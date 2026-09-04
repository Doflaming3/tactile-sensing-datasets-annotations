import { NextRequest } from "next/server";
import { hubResolveUrl } from "@/utils/repoRef";
import { spawn } from "child_process";
import { createHash } from "crypto";
import { createWriteStream } from "fs";
import { mkdir, readdir, stat, unlink } from "fs/promises";
import os from "os";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import ffmpegPath from "ffmpeg-static";

// Server-side single-frame extraction for streams the browser can't decode:
// RGBD color (MJPEG-in-MKV) and depth (FFV1 gray16le).
//
// ffmpeg-static's binary cannot read https inputs (verified), so the route
// downloads the stream once with Node fetch (which handles the HF auth
// header and CDN redirects), caches it under the OS temp dir, and runs
// ffmpeg on the local file. First request per stream pays the download;
// subsequent scrubs are local-disk fast.
//
//   GET /api/videoframe?repo=<org/dataset>&path=<repo-relative>&t=<sec>
//        &kind=color|depth [&w=&h=]
//
// kind=color -> image/jpeg;  kind=depth -> raw gray16le (w*h*2 bytes).

const HF = "https://huggingface.co/datasets";
const COOKIE_NAME = "hf_access_token";
const ALLOWED_KINDS = new Set(["color", "depth"]);
const CACHE_DIR = path.join(os.tmpdir(), "tactile-viz-videocache");
const CACHE_MAX_BYTES = 3 * 1024 * 1024 * 1024; // 3 GB

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// De-duplicate concurrent downloads of the same stream.
const inflight = new Map<string, Promise<string>>();

async function cachedDownload(url: string, token?: string): Promise<string> {
  await mkdir(CACHE_DIR, { recursive: true });
  const key = createHash("sha1").update(url).digest("hex");
  const dest = path.join(CACHE_DIR, key);
  try {
    const st = await stat(dest);
    if (st.size > 0) return dest;
  } catch {
    /* not cached */
  }
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = (async () => {
    const res = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      redirect: "follow",
    });
    if (!res.ok || !res.body) {
      throw new Error(`upstream ${res.status}`);
    }
    const tmp = `${dest}.part`;
    await pipeline(
      Readable.fromWeb(
        res.body as unknown as import("stream/web").ReadableStream,
      ),
      createWriteStream(tmp),
    );
    const { rename } = await import("fs/promises");
    await rename(tmp, dest);
    void pruneCache();
    return dest;
  })();
  inflight.set(key, p);
  p.finally(() => inflight.delete(key));
  return p;
}

async function pruneCache() {
  try {
    const entries = await readdir(CACHE_DIR);
    const stats = await Promise.all(
      entries.map(async (f) => {
        const full = path.join(CACHE_DIR, f);
        const st = await stat(full);
        return { full, size: st.size, mtime: st.mtimeMs };
      }),
    );
    let total = stats.reduce((a, s) => a + s.size, 0);
    for (const s of stats.sort((a, b) => a.mtime - b.mtime)) {
      if (total <= CACHE_MAX_BYTES) break;
      await unlink(s.full).catch(() => {});
      total -= s.size;
    }
  } catch {
    /* best effort */
  }
}

function runFfmpeg(
  args: string[],
): Promise<{ code: number; out: Buffer; err: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const err: Buffer[] = [];
    const p = spawn(ffmpegPath as string, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    p.stdout.on("data", (c: Buffer) => chunks.push(c));
    p.stderr.on("data", (c: Buffer) => err.push(c));
    p.on("close", (code) =>
      resolve({
        code: code ?? 1,
        out: Buffer.concat(chunks),
        err: Buffer.concat(err).toString(),
      }),
    );
    setTimeout(() => p.kill("SIGKILL"), 60_000);
  });
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  // Self-diagnosis: open /api/videoframe?diag=1 in the browser and paste the
  // JSON when reporting problems.
  if (sp.get("diag")) {
    const { existsSync } = await import("fs");
    let version = "n/a";
    if (ffmpegPath && existsSync(ffmpegPath)) {
      const r = await runFfmpeg(["-version"]);
      version = (r.out.toString() || r.err).split("\n")[0];
    }
    return Response.json({
      ffmpegPath: ffmpegPath ?? null,
      binaryExists: !!ffmpegPath && existsSync(ffmpegPath),
      version,
      cacheDir: CACHE_DIR,
      node: process.version,
      hasAuthCookie: !!req.cookies.get(COOKIE_NAME)?.value,
    });
  }
  const repo = sp.get("repo") ?? "";
  const relPath = sp.get("path") ?? "";
  const t = Math.max(0, Number(sp.get("t") ?? "0"));
  const kind = sp.get("kind") ?? "color";
  const w = Math.min(4096, Number(sp.get("w") ?? "1280"));
  const h = Math.min(4096, Number(sp.get("h") ?? "720"));
  if (
    !/^[\w.-]+\/[\w.-]+(@[\w.\-\/]+)?$/.test(repo) ||
    !relPath ||
    relPath.includes("..") ||
    !ALLOWED_KINDS.has(kind) ||
    !Number.isFinite(t)
  ) {
    return new Response("bad request", { status: 400 });
  }
  const { existsSync } = await import("fs");
  if (!ffmpegPath || !existsSync(ffmpegPath)) {
    return new Response(
      "ffmpeg binary missing. bun skips ffmpeg-static's install script " +
        "unless trusted - run: bun pm trust ffmpeg-static && bun install " +
        "(or: npm install), then restart the dev server.",
      { status: 500 },
    );
  }
  const token = req.cookies.get(COOKIE_NAME)?.value;
  let local: string;
  try {
    local = await cachedDownload(hubResolveUrl(HF, repo, relPath), token);
  } catch (e) {
    return new Response(`download failed: ${String(e).slice(0, 200)}`, {
      status: 502,
    });
  }

  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    t.toFixed(3),
    "-i",
    local,
    "-frames:v",
    "1",
  ];
  if (kind === "depth") {
    args.push("-f", "rawvideo", "-pix_fmt", "gray16le", "pipe:1");
  } else {
    args.push("-f", "image2", "-c:v", "mjpeg", "-q:v", "4", "pipe:1");
  }
  const { code, out, err } = await runFfmpeg(args);
  if (code !== 0 || out.length === 0) {
    return new Response(`ffmpeg failed: ${err.slice(0, 300)}`, { status: 502 });
  }
  return new Response(new Uint8Array(out), {
    headers:
      kind === "depth"
        ? {
            "content-type": "application/octet-stream",
            "x-width": String(w),
            "x-height": String(h),
            "cache-control": "private, max-age=3600",
          }
        : {
            "content-type": "image/jpeg",
            "cache-control": "private, max-age=3600",
          },
  });
}

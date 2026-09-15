import { describe, expect, test } from "bun:test";

import {
  SOTAC_PROFILE,
  TEMPLATE_PROFILE,
  type RigProfile,
} from "../rigProfile";
import {
  WorkerPool,
  type PoolRequest,
  type PoolResponse,
  type WorkerLike,
} from "../workerPool";

interface Job {
  profile: RigProfile;
  n: number;
}

type Fake = WorkerLike & {
  received: PoolRequest<Job>[];
  terminated: boolean;
};

/** A worker stand-in: answers on the next tick with n × 10, or fails per
 * job, or crashes, or stays silent. */
function fakeWorker(mode: "ok" | "fail" | "crash" | "silent" = "ok"): Fake {
  const listeners: Record<string, Array<(ev: never) => void>> = {
    message: [],
    error: [],
  };
  const emit = (type: string, ev: unknown) => {
    for (const l of listeners[type]) (l as (e: unknown) => void)(ev);
  };
  const w: Fake = {
    received: [],
    terminated: false,
    postMessage(msg) {
      const req = msg as PoolRequest<Job>;
      w.received.push(req);
      if (mode === "silent") return;
      setTimeout(() => {
        if (mode === "crash") {
          emit("error", { message: "boom" });
          return;
        }
        const res: PoolResponse<number> =
          mode === "fail"
            ? { id: req.id, ok: false, error: "bad job" }
            : { id: req.id, ok: true, result: req.job.n * 10 };
        emit("message", { data: res });
      }, 0);
    },
    terminate() {
      w.terminated = true;
    },
    addEventListener(type: string, listener: (ev: never) => void) {
      (listeners[type] ??= []).push(listener);
    },
  };
  return w;
}

const job = (n: number, profile: RigProfile = SOTAC_PROFILE): Job => ({
  profile,
  n,
});

describe("WorkerPool", () => {
  test("spreads jobs over the least-busy worker, routes results by id, sends the profile once per worker", async () => {
    const workers: Fake[] = [];
    const pool = new WorkerPool<Job, number>(2, () => {
      const w = fakeWorker();
      workers.push(w);
      return w;
    });
    expect(pool.size).toBe(2);
    const results = await Promise.all(
      [1, 2, 3, 4].map((n) => pool.run(job(n))),
    );
    expect(results).toEqual([10, 20, 30, 40]);
    expect(workers.map((w) => w.received.length)).toEqual([2, 2]);
    for (const w of workers) {
      expect(w.received.filter((r) => r.profile !== undefined).length).toBe(1);
      // the job crosses without its profile
      expect("profile" in w.received[0].job).toBe(false);
    }
    // a different profile object is sent again
    await pool.run(job(5, TEMPLATE_PROFILE));
    const sent = workers.flatMap((w) => w.received).filter((r) => r.profile);
    expect(sent.length).toBe(3);
    pool.terminate();
    expect(workers.every((w) => w.terminated)).toBe(true);
  });

  test("a per-job failure rejects only that job", async () => {
    const pool = new WorkerPool<Job, number>(1, () => fakeWorker("fail"));
    await expect(pool.run(job(1))).rejects.toThrow("bad job");
    pool.terminate();
  });

  test("a crashed worker hands its pending jobs to the fallback", async () => {
    const crashes: Array<[string, number]> = [];
    const pool = new WorkerPool<Job, number>(1, () => fakeWorker("crash"), {
      fallback: async (j) => 1000 + j.n,
      onWorkerError: (m, n) => crashes.push([m, n]),
    });
    const [a, b] = await Promise.all([pool.run(job(5)), pool.run(job(6))]);
    expect([a, b]).toEqual([1005, 1006]);
    expect(crashes[0]).toEqual(["boom", 2]);
    pool.terminate();
  });

  test("without a fallback a crash rejects; terminate rejects what is still pending", async () => {
    const crashPool = new WorkerPool<Job, number>(1, () => fakeWorker("crash"));
    await expect(crashPool.run(job(1))).rejects.toThrow("boom");
    crashPool.terminate();

    const silent = fakeWorker("silent");
    const pool = new WorkerPool<Job, number>(1, () => silent);
    const p = pool.run(job(2));
    pool.terminate();
    await expect(p).rejects.toThrow("pool terminated");
    expect(silent.terminated).toBe(true);
    await expect(pool.run(job(3))).rejects.toThrow("pool terminated");
  });
});

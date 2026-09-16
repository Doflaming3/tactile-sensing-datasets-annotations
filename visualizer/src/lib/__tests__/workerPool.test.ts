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
  /** fire an event on the page side, as the browser would */
  emit: (type: string, ev: unknown) => void;
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
    emit,
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

describe("a dead worker is terminated and, when allowed, replaced", () => {
  const fallback = async (j: Job) => 1000 + j.n;

  test("a crashed worker is terminated, not only skipped", async () => {
    const w = fakeWorker("crash");
    const pool = new WorkerPool<Job, number>(1, () => w, { fallback });
    expect(await pool.run(job(1))).toBe(1001);
    expect(w.terminated).toBe(true);
    pool.terminate();
  });

  test("a hung worker is terminated when given up on", async () => {
    const w = fakeWorker("silent");
    const pool = new WorkerPool<Job, number>(1, () => w, {
      fallback,
      jobTimeoutMs: 20,
    });
    expect(await pool.run(job(1))).toBe(1001);
    expect(w.terminated).toBe(true);
    pool.terminate();
  });

  test("without restarts (the default) a dead slot stays dead", async () => {
    const made: Fake[] = [];
    const pool = new WorkerPool<Job, number>(
      1,
      () => {
        const w = fakeWorker("crash");
        made.push(w);
        return w;
      },
      { fallback },
    );
    await pool.run(job(1));
    expect(await pool.run(job(2))).toBe(1002);
    expect(made.length).toBe(1);
    expect(pool.liveSize).toBe(0);
    pool.terminate();
  });

  test("with restarts allowed a fresh worker takes the dead one's place and is sent the profile again", async () => {
    const made: Fake[] = [];
    const restartable: boolean[] = [];
    const pool = new WorkerPool<Job, number>(
      1,
      () => {
        const w = fakeWorker(made.length === 0 ? "crash" : "ok");
        made.push(w);
        return w;
      },
      {
        fallback,
        onWorkerError: (_m, _n, r) => restartable.push(r),
        maxRespawns: 1,
      },
    );
    expect(await pool.run(job(1))).toBe(1001); // the crash: fallback
    expect(restartable).toEqual([true]);
    expect(made[0].terminated).toBe(true);
    expect(pool.liveSize).toBe(0);
    expect(await pool.run(job(2))).toBe(20); // a fresh worker answered
    expect(made.length).toBe(2);
    expect(pool.liveSize).toBe(1);
    expect(made[1].received[0].profile).toBeDefined();
    pool.terminate();
    expect(made[1].terminated).toBe(true);
  });

  test("the cap holds: a worker that keeps dying is not replaced again", async () => {
    const made: Fake[] = [];
    const restartable: boolean[] = [];
    const pool = new WorkerPool<Job, number>(
      1,
      () => {
        const w = fakeWorker("crash");
        made.push(w);
        return w;
      },
      {
        fallback,
        onWorkerError: (_m, _n, r) => restartable.push(r),
        maxRespawns: 1,
      },
    );
    expect(await pool.run(job(1))).toBe(1001);
    expect(await pool.run(job(2))).toBe(1002); // the replacement died too
    expect(await pool.run(job(3))).toBe(1003); // no third worker
    expect(made.length).toBe(2);
    expect(restartable).toEqual([true, false]);
    expect(pool.liveSize).toBe(0);
    pool.terminate();
  });

  test("a late event from a replaced worker does not kill its successor", async () => {
    const made: Fake[] = [];
    const pool = new WorkerPool<Job, number>(
      1,
      () => {
        const w = fakeWorker(made.length === 0 ? "crash" : "ok");
        made.push(w);
        return w;
      },
      { fallback, maxRespawns: 1 },
    );
    await pool.run(job(1));
    expect(await pool.run(job(2))).toBe(20);
    made[0].emit("error", { message: "late" });
    made[0].emit("message", { data: { id: 1, ok: true, result: -1 } });
    expect(pool.liveSize).toBe(1);
    expect(await pool.run(job(3))).toBe(30);
    expect(made[1].received.length).toBe(2);
    pool.terminate();
  });

  test("an idle live worker is preferred; a dead one is restarted only when every live one is busy", async () => {
    const made: Fake[] = [];
    const pool = new WorkerPool<Job, number>(
      2,
      () => {
        const w = fakeWorker(made.length === 0 ? "crash" : "ok");
        made.push(w);
        return w;
      },
      { fallback, maxRespawns: 1 },
    );
    expect(await pool.run(job(1))).toBe(1001); // slot 0 dies
    expect(await pool.run(job(2))).toBe(20); // slot 1 was idle: no restart
    expect(made.length).toBe(2);
    const [c, d] = await Promise.all([pool.run(job(3)), pool.run(job(4))]);
    expect([c, d]).toEqual([30, 40]); // slot 1 busy: slot 0 restarted
    expect(made.length).toBe(3);
    expect(made[2].received.length).toBe(1);
    expect(pool.liveSize).toBe(2);
    pool.terminate();
  });
});

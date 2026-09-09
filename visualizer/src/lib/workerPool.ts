// A pool of Web Workers. JavaScript has one thread per realm, but a Web
// Worker is a real OS thread with its own realm: the pool sends each job
// to the least-busy worker and resolves the result by request id, so the
// batch's per-episode pipeline (parquet decode, sidecar parse, detection)
// runs on several cores while the page stays responsive. The worker
// factory is injected (tests use a fake, batchWorkers.ts creates real
// Workers). Every job carries the rig profile — a few hundred KB with the
// screen corpus attached — and a worker keeps the one it was last sent, so
// only the first job of a worker pays for it.
import type { RigProfile } from "./rigProfile";

/** The slice of the Worker API the pool needs (a fake fits it in tests). */
export interface WorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  addEventListener(
    type: "message",
    listener: (ev: { data: unknown }) => void,
  ): void;
  addEventListener(
    type: "error",
    listener: (ev: { message?: string }) => void,
  ): void;
}

export interface PoolJob {
  profile: RigProfile;
}

/** What crosses to a worker: the job without its profile, plus the
 * profile when it differs from what that worker holds. */
export interface PoolRequest<J extends PoolJob> {
  id: number;
  job: Omit<J, "profile">;
  profile?: RigProfile;
}

export type PoolResponse<R> =
  | { id: number; ok: true; result: R }
  | { id: number; ok: false; error: string };

interface Slot {
  worker: WorkerLike;
  busy: number;
  profile: RigProfile | null;
  pending: Set<number>;
}

interface Waiting<J, R> {
  resolve: (result: R) => void;
  reject: (error: Error) => void;
  slot: Slot;
  job: J;
}

export interface WorkerPoolOptions<J, R> {
  /** where a crashed worker's jobs go (the main thread, typically) */
  fallback?: (job: J) => Promise<R>;
  /** told about a worker crash (once per crash) */
  onWorkerError?: (message: string, jobs: number) => void;
}

export class WorkerPool<J extends PoolJob, R> {
  private readonly slots: Slot[] = [];
  private readonly waiting = new Map<number, Waiting<J, R>>();
  private seq = 0;
  private closed = false;

  constructor(
    size: number,
    factory: () => WorkerLike,
    private readonly options: WorkerPoolOptions<J, R> = {},
  ) {
    for (let i = 0; i < Math.max(1, Math.floor(size)); i++) {
      const worker = factory();
      const slot: Slot = { worker, busy: 0, profile: null, pending: new Set() };
      worker.addEventListener("message", (ev) =>
        this.onMessage(ev.data as PoolResponse<R>),
      );
      worker.addEventListener("error", (ev) =>
        this.onError(slot, ev.message ?? "worker error"),
      );
      this.slots.push(slot);
    }
  }

  get size(): number {
    return this.slots.length;
  }

  run(job: J): Promise<R> {
    if (this.closed) return Promise.reject(new Error("pool terminated"));
    const slot = this.slots.reduce((a, b) => (b.busy < a.busy ? b : a));
    const id = ++this.seq;
    const { profile, ...rest } = job;
    const req: PoolRequest<J> = {
      id,
      job: rest as Omit<J, "profile">,
      ...(slot.profile === profile ? {} : { profile }),
    };
    slot.profile = profile;
    slot.busy++;
    slot.pending.add(id);
    return new Promise<R>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject, slot, job });
      try {
        slot.worker.postMessage(req);
      } catch (e) {
        this.settle(
          id,
          undefined,
          e instanceof Error ? e : new Error(String(e)),
        );
      }
    });
  }

  terminate(): void {
    this.closed = true;
    for (const s of this.slots) s.worker.terminate();
    for (const id of [...this.waiting.keys()])
      this.settle(id, undefined, new Error("pool terminated"));
  }

  private take(id: number): Waiting<J, R> | undefined {
    const w = this.waiting.get(id);
    if (!w) return undefined;
    this.waiting.delete(id);
    w.slot.busy--;
    w.slot.pending.delete(id);
    return w;
  }

  private settle(id: number, result?: R, error?: Error): void {
    const w = this.take(id);
    if (!w) return;
    if (error) w.reject(error);
    else w.resolve(result as R);
  }

  private onMessage(msg: PoolResponse<R>): void {
    if (!msg || typeof msg.id !== "number") return;
    if (msg.ok) this.settle(msg.id, msg.result);
    else this.settle(msg.id, undefined, new Error(msg.error));
  }

  /** A worker died (its script failed to load, or it threw outside a
   * message): its pending jobs go to the fallback or fail. */
  private onError(slot: Slot, message: string): void {
    const ids = [...slot.pending];
    slot.profile = null;
    this.options.onWorkerError?.(message, ids.length);
    for (const id of ids) {
      const w = this.take(id);
      if (!w) continue;
      const fallback = this.options.fallback;
      if (fallback) fallback(w.job).then(w.resolve, w.reject);
      else w.reject(new Error(message));
    }
  }
}

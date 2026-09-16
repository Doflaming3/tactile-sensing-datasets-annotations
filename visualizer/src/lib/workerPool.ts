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
  addEventListener(type: "messageerror", listener: (ev: unknown) => void): void;
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
  /** crashed or hung: its worker is terminated and it is never dispatched
   * to (postMessage would be a no-op) until a fresh worker takes its place */
  dead: boolean;
  /** fresh workers this slot has been given */
  respawns: number;
}

interface Waiting<J, R> {
  resolve: (result: R) => void;
  reject: (error: Error) => void;
  slot: Slot;
  job: J;
  timer?: ReturnType<typeof setTimeout>;
}

export interface WorkerPoolOptions<J, R> {
  /** where a crashed worker's jobs go (the main thread, typically) */
  fallback?: (job: J) => Promise<R>;
  /** told about a worker crash (once per crash): the message, how many of
   * its jobs moved to the fallback, whether a fresh worker may replace it */
  onWorkerError?: (message: string, jobs: number, restartable: boolean) => void;
  /** a job unanswered this long marks its worker dead (hung, not crashed)
   * and goes to the fallback; 0 = wait forever */
  jobTimeoutMs?: number;
  /** how many times a dead slot may be given a fresh worker (0 = never):
   * a transient failure then costs one job's delay, not a thread for the
   * rest of the page's life; a worker that keeps dying stays dead */
  maxRespawns?: number;
}

export class WorkerPool<J extends PoolJob, R> {
  private readonly slots: Slot[] = [];
  private readonly waiting = new Map<number, Waiting<J, R>>();
  private seq = 0;
  private closed = false;

  constructor(
    size: number,
    private readonly factory: () => WorkerLike,
    private readonly options: WorkerPoolOptions<J, R> = {},
  ) {
    for (let i = 0; i < Math.max(1, Math.floor(size)); i++)
      this.slots.push(this.spawn());
  }

  /** A slot with a fresh worker: a new one, or a dead slot revived. Events
   * from a worker the slot has since replaced are ignored — a terminated
   * worker may still have events queued on this side. */
  private spawn(prior?: Slot): Slot {
    const worker = this.factory();
    const slot: Slot = prior ?? {
      worker,
      busy: 0,
      profile: null,
      pending: new Set(),
      dead: false,
      respawns: 0,
    };
    if (prior) {
      slot.worker = worker;
      slot.busy = 0;
      slot.profile = null;
      slot.pending = new Set();
      slot.dead = false;
      slot.respawns++;
    }
    const mine = () => slot.worker === worker;
    worker.addEventListener("message", (ev) => {
      if (mine()) this.onMessage(ev.data as PoolResponse<R>);
    });
    worker.addEventListener("error", (ev) => {
      if (mine()) this.onError(slot, ev.message ?? "worker error");
    });
    worker.addEventListener("messageerror", () => {
      if (mine())
        this.onError(
          slot,
          "a message to or from the worker could not be decoded",
        );
    });
    return slot;
  }

  get size(): number {
    return this.slots.length;
  }

  /** workers still alive */
  get liveSize(): number {
    return this.slots.filter((s) => !s.dead).length;
  }

  run(job: J): Promise<R> {
    if (this.closed) return Promise.reject(new Error("pool terminated"));
    const slot = this.pick();
    if (!slot) {
      // every worker is dead for good: the job runs through the fallback
      // (the main thread) rather than waiting on a corpse
      const fallback = this.options.fallback;
      return fallback
        ? fallback(job)
        : Promise.reject(new Error("every worker of the pool has died"));
    }
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
      const w: Waiting<J, R> = { resolve, reject, slot, job };
      const limit = this.options.jobTimeoutMs ?? 0;
      if (limit > 0)
        w.timer = setTimeout(() => {
          if (!slot.pending.has(id)) return; // moved already: its worker died
          this.onError(
            slot,
            `no answer from the worker in ${Math.round(limit / 1000)} s`,
          );
        }, limit);
      this.waiting.set(id, w);
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

  /** The least-busy live worker; when none is idle, a dead slot with
   * restarts left is given a fresh worker instead (a dead slot is never
   * chosen as it is: postMessage to it would be a silent no-op). */
  private pick(): Slot | null {
    const live = this.slots.filter((s) => !s.dead);
    const best = live.length
      ? live.reduce((a, b) => (b.busy < a.busy ? b : a))
      : null;
    if (best && best.busy === 0) return best;
    const max = this.options.maxRespawns ?? 0;
    for (const s of this.slots) {
      if (!s.dead || s.respawns >= max) continue;
      try {
        return this.spawn(s);
      } catch {
        s.respawns = max; // no worker could be made: this slot stays dead
      }
    }
    return best;
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
    if (w.timer) clearTimeout(w.timer);
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

  /** A worker died (its script failed to load, it threw outside a message,
   * a message could not be decoded, or a job went unanswered too long).
   * Its thread is terminated — a crashed worker's realm lives on with its
   * memory, and a hung one keeps its core too, until the page is left —
   * and its pending jobs go to the fallback or fail. */
  private onError(slot: Slot, message: string): void {
    if (slot.dead) return;
    slot.dead = true;
    try {
      slot.worker.terminate();
    } catch {
      /* already gone */
    }
    const ids = [...slot.pending];
    slot.profile = null;
    this.options.onWorkerError?.(
      message,
      ids.length,
      slot.respawns < (this.options.maxRespawns ?? 0),
    );
    for (const id of ids) {
      const w = this.take(id);
      if (!w) continue;
      const fallback = this.options.fallback;
      if (fallback) fallback(w.job).then(w.resolve, w.reject);
      else w.reject(new Error(message));
    }
  }
}

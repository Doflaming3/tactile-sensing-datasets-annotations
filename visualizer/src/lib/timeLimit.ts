// A promise with a deadline. The work behind it is not cancelled — a fetch
// the browser is still waiting on keeps waiting in the background — but
// the caller moves on, so one stalled request cannot hold a whole run.

/** `p`, or a rejection with `message` after `ms` (0 = no limit). */
export function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  if (!(ms > 0)) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

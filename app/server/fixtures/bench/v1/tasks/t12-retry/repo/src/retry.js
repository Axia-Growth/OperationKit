// retry(fn, { attempts, delayMs }) calls async fn until it resolves, at most
// `attempts` times in total, waiting `delayMs * 2 ** (attemptIndex)` between tries
// (so delays are delayMs, 2*delayMs, 4*delayMs ...). Resolves with fn's value, or
// rejects with the LAST error. `attempts` defaults to 3, `delayMs` to 100.
export async function retry(fn, opts = {}) {
  return fn()
}

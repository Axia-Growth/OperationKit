/* Off-main-thread force layout for the knowledge-base graph (obj 900867).
   The page posts {id, input, seed, exact}; we settle and post back the
   positions as two transferable Float64Arrays, so the UI thread never runs
   the ~300 Barnes–Hut ticks a large graph needs. */
import { layoutNow, type LayoutInput, type Positions } from './kbGraphLayout'

interface Req { id: number; input: LayoutInput; seed: Positions | null; exact: boolean }

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<Req>) => void) | null
  postMessage: (msg: unknown, transfer: Transferable[]) => void
}

ctx.onmessage = (e: MessageEvent<Req>) => {
  const { id, input, seed, exact } = e.data
  const { sim, ticks } = layoutNow(input, seed, exact)
  const xs = new Float64Array(sim.nodes.length)
  const ys = new Float64Array(sim.nodes.length)
  sim.nodes.forEach((n, i) => { xs[i] = n.x; ys[i] = n.y })
  ctx.postMessage({ id, xs, ys, ticks }, [xs.buffer, ys.buffer])
}

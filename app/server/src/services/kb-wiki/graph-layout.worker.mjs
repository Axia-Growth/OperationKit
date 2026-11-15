/* Worker thread for graph-layout.ts (obj 900867): settles one knowledge-base
   graph layout off the server's event loop and posts the packed positions.

   Plain JavaScript on purpose. A worker thread does not get tsx's resolver
   (Node runs a .ts worker with its own type stripping, which cannot follow the
   server's `.js` import specifiers), so this file loads the shared TypeScript
   module through tsx's tsImport API instead — or with a plain import when the
   server runs compiled JavaScript. */
import { parentPort, workerData } from 'node:worker_threads'

const { moduleUrl, input, seed } = workerData
const mod = moduleUrl.endsWith('.ts')
  ? await (await import('tsx/esm/api')).tsImport(moduleUrl, import.meta.url)
  : await import(moduleUrl)
const { sim } = mod.layoutNow(input, seed)
parentPort.postMessage(mod.packPositions(sim))

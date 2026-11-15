#!/usr/bin/env node
// Context / Graph load benchmark (obj 900867). Manual tool — never run by CI or
// `npm test`. Drives a real Chromium against a SCRATCH server (see CLAUDE.md,
// "Scratch server for screenshots") seeded by seed-scratch.mts over the vault
// from gen-kb-vault.mjs, and prints the median time to each milestone for:
//   cold    — fresh browser profile, first visit to /knowledge
//   return  — in-app: Context → Board → Context (the case Operator reported)
//   reload  — full page reload of /knowledge with a warm profile
//
//   PLAYWRIGHT_BROWSERS_PATH=… node scripts/bench/context-load.mjs \
//     --base http://localhost:3912 --token <jwt> [--runs 3] [--cpu 4] [--shots dir]
// `playwright` is not a repo dependency: install it in a scratch dir and point
// NODE_PATH at that dir's node_modules.
import { createRequire } from 'module'
import path from 'path'
// Resolve playwright from NODE_PATH (ESM imports ignore it).
const req = createRequire(path.join(process.env.NODE_PATH || process.cwd(), 'noop.js'))
const { chromium } = req('playwright')

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d }
const BASE = arg('base', 'http://localhost:3912')
const TOKEN = arg('token')
const RUNS = Number(arg('runs', 3))
const CPU = Number(arg('cpu', 1))
const SHOTS = arg('shots', '')
const LABEL = arg('label', 'run')
// --net <download kbit/s>,<rtt ms>: e.g. 12000,40. Local responses are not gzipped (Caddy does that in prod), so this is pessimistic.
const NET = arg('net', '')
if (!TOKEN) throw new Error('--token <jwt> is required')

// In-page milestone watcher: records performance.now() the first frame each selector matches.
const WATCH = `(() => {
  const marks = {}; window.__marks = marks
  const want = {
    shell: () => [...document.querySelectorAll('h1')].some(h => h.textContent.trim() === 'Context'),
    skeleton: () => !!document.querySelector('[aria-busy="true"], [aria-label="Loading pages"]'),
    tree: () => !!document.querySelector('[role="tree"] [role="treeitem"]'),
    graph: () => !!document.querySelector('svg[aria-label^="Graph of"] g[data-rel]'),
  }
  window.__lt = 0
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lt += Math.max(0, e.duration - 50) }).observe({ type: 'longtask', buffered: true }) } catch {}
  window.__resetMarks = (t0) => { for (const k of Object.keys(marks)) delete marks[k]; window.__t0 = t0; window.__lt = 0 }
  window.__t0 = 0
  const loop = () => { const now = performance.now(); for (const [k, f] of Object.entries(want)) if (!(k in marks)) { try { if (f()) marks[k] = Math.round(now - window.__t0) } catch {} } requestAnimationFrame(loop) }
  requestAnimationFrame(loop)
})()`

async function waitDone(page) {
  await page.waitForFunction(() => window.__marks && 'tree' in window.__marks && 'graph' in window.__marks, null, { timeout: 300_000, polling: 100 })
  return page.evaluate(() => ({ ...window.__marks, blocking: Math.round(window.__lt) }))
}

async function newPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, bypassCSP: true })
  const u = new URL(BASE)
  await ctx.addCookies([{ name: 'token', value: TOKEN, domain: u.hostname, path: '/', httpOnly: true }])
  await ctx.addInitScript(WATCH)
  const page = await ctx.newPage()
  const cdp = await ctx.newCDPSession(page)
  if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU })
  if (NET) {
    const [kbps, rtt] = NET.split(',').map(Number)
    await cdp.send('Network.enable')
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: rtt, downloadThroughput: (kbps * 1000) / 8, uploadThroughput: (kbps * 1000) / 8 })
  }
  return { ctx, page }
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }
const results = { cold: [], return: [], reload: [] }
const browser = await chromium.launch()
for (let r = 0; r < RUNS; r++) {
  const { ctx, page } = await newPage(browser)
  // Cold: fresh profile, no HTTP cache, no storage.
  await page.goto(`${BASE}/knowledge`)
  if (SHOTS && r === 0) {
    // First meaningful paint of a cold visit: the page shell with its skeleton (or content, if it is already there).
    await page.waitForFunction(() => window.__marks && ('skeleton' in window.__marks || 'tree' in window.__marks), null, { timeout: 300_000, polling: 16 })
    await page.screenshot({ path: `${SHOTS}/${LABEL}-cold-first-paint.png` })
  }
  results.cold.push(await waitDone(page))
  if (SHOTS && r === 0) await page.screenshot({ path: `${SHOTS}/${LABEL}-cold-done.png` })
  // Return: in-app navigation Board → Context.
  await page.locator('a[href="/"]:visible').first().click()
  await page.waitForFunction(() => location.pathname === '/' && !document.querySelector('svg[aria-label^="Graph of"]'))
  await page.waitForTimeout(1500)
  await page.evaluate(() => window.__resetMarks(performance.now()))
  await page.locator('a[href="/knowledge"]:visible').first().click()
  if (SHOTS && r === 0) { await page.waitForTimeout(120); await page.screenshot({ path: `${SHOTS}/${LABEL}-return-120ms.png` }) }
  results.return.push(await waitDone(page))
  // Reload: warm profile, full page load.
  await page.reload()
  results.reload.push(await waitDone(page))
  await ctx.close()
}
await browser.close()
const summary = {}
for (const [k, rows] of Object.entries(results)) {
  summary[k] = {}
  for (const m of ['shell', 'skeleton', 'tree', 'graph', 'blocking']) {
    const xs = rows.map(r => r[m]).filter(x => typeof x === 'number')
    if (xs.length) summary[k][m] = median(xs)
  }
}
console.log(JSON.stringify({ label: LABEL, base: BASE, runs: RUNS, cpuThrottle: CPU, net: NET || null, median_ms: summary, raw: results }, null, 2))

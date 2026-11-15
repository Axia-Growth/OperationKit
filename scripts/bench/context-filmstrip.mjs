#!/usr/bin/env node
// Filmstrip of Context loading, before vs after (obj 900867). Manual tool —
// never run by CI or `npm test`. Same setup as context-load.mjs (scratch
// servers, NODE_PATH pointing at a scratch playwright install).
//
//   node scripts/bench/context-filmstrip.mjs --token <jwt> \
//     --before http://localhost:3912 --after http://localhost:3913 \
//     [--cpu 4] [--net 12000,40] --out dir
//
// Records Chrome's screencast (frames carry the time they were painted) for a
// cold first visit and an in-app return visit (Board → Context) on each
// server, then lays the frames out side by side — one row per build, one
// column per moment — and screenshots that sheet to <out>/<scenario>.png.
import { createRequire } from 'module'
import fs from 'fs'
import path from 'path'
const req = createRequire(path.join(process.env.NODE_PATH || process.cwd(), 'noop.js'))
const { chromium } = req('playwright')

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d }
const TOKEN = arg('token')
const BUILDS = [['before', arg('before', 'http://localhost:3912')], ['after', arg('after', 'http://localhost:3913')]]
const CPU = Number(arg('cpu', 1))
const NET = arg('net', '')
const OUT = arg('out', '.')
if (!TOKEN) throw new Error('--token <jwt> is required')
fs.mkdirSync(OUT, { recursive: true })

const DONE = () => !!document.querySelector('[role="tree"] [role="treeitem"]') && !!document.querySelector('svg[aria-label^="Graph of"] g[data-rel]')

async function newPage(browser, base) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, bypassCSP: true })
  await ctx.addCookies([{ name: 'token', value: TOKEN, domain: new URL(base).hostname, path: '/', httpOnly: true }])
  const page = await ctx.newPage()
  const cdp = await ctx.newCDPSession(page)
  if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU })
  if (NET) {
    const [kbps, rtt] = NET.split(',').map(Number)
    await cdp.send('Network.enable')
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: rtt, downloadThroughput: (kbps * 1000) / 8, uploadThroughput: (kbps * 1000) / 8 })
  }
  const frames = []
  cdp.on('Page.screencastFrame', f => {
    frames.push({ t: f.metadata.timestamp * 1000, data: f.data })
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
  })
  const record = () => { frames.length = 0; return cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 720, maxHeight: 450 }) }
  const stop = () => cdp.send('Page.stopScreencast')
  return { ctx, page, frames, record, stop }
}

/** The frame on screen at each moment: the last one painted at or before t0 + ms. */
function pick(frames, t0, moments) {
  return moments.map(ms => {
    let best = null
    for (const f of frames) if (f.t <= t0 + ms) best = f
    return best?.data ?? null
  })
}

async function capture(browser) {
  const rows = { cold: {}, return: {} }
  for (const [label, base] of BUILDS) {
    const { ctx, page, frames, record, stop } = await newPage(browser, base)
    // Cold: fresh profile, first visit.
    await record()
    const tCold = Date.now()
    await page.goto(`${base}/knowledge`)
    await page.waitForFunction(DONE, null, { timeout: 300_000, polling: 50 })
    const coldDone = Date.now() - tCold
    await page.waitForTimeout(400)
    await stop()
    rows.cold[label] = { frames: [...frames], t0: tCold, done: coldDone }
    // Return: Board, then back to Context in-app.
    await page.locator('a[href="/"]:visible').first().click()
    await page.waitForFunction(() => location.pathname === '/' && !document.querySelector('svg[aria-label^="Graph of"]'))
    await page.waitForTimeout(1500)
    await record()
    await page.waitForTimeout(200)
    const tRet = Date.now()
    await page.locator('a[href="/knowledge"]:visible').first().click()
    await page.waitForFunction(DONE, null, { timeout: 300_000, polling: 16 })
    const retDone = Date.now() - tRet
    await page.waitForTimeout(400)
    await stop()
    rows.return[label] = { frames: [...frames], t0: tRet, done: retDone }
    await ctx.close()
  }
  return rows
}

async function sheet(browser, scenario, rows, moments, title) {
  const cells = (label) => pick(rows[label].frames, rows[label].t0, moments)
  const fmt = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(ms % 1000 ? 1 : 0)} s` : `${ms} ms`)
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;padding:24px;font:14px system-ui,sans-serif;background:#fff;color:#111}
    h1{font-size:18px;margin:0 0 4px} p{margin:0 0 16px;color:#555}
    table{border-collapse:collapse} td{padding:4px;vertical-align:top;text-align:center}
    th{font-weight:600;padding:4px 10px 4px 0;text-align:right;white-space:nowrap}
    img{width:240px;display:block;border:1px solid #ddd} .t{font-size:12px;color:#555;margin-top:2px}
    .blank{width:240px;height:150px;background:#f3f3f3;border:1px solid #ddd}
  </style><h1>${title}</h1><p>Each frame is what was on screen at that moment (Chrome screencast). Done = page tree and graph both drawn.</p><table>
  ${BUILDS.map(([label]) => `<tr><th>${label}<br><span class="t">done ${fmt(rows[label].done)}</span></th>${cells(label).map((d, i) => `<td>${d ? `<img src="data:image/jpeg;base64,${d}">` : '<div class="blank"></div>'}<div class="t">+${fmt(moments[i])}</div></td>`).join('')}</tr>`).join('')}
  </table>`
  const page = await browser.newPage({ viewport: { width: 280 + moments.length * 250, height: 600 } })
  await page.setContent(html)
  const file = path.join(OUT, `${scenario}.png`)
  await page.screenshot({ path: file, fullPage: true })
  await page.close()
  return file
}

const browser = await chromium.launch()
const rows = await capture(browser)
const net = NET ? `, network ${NET.split(',')[0] / 1000} Mbit/s + ${NET.split(',')[1]} ms RTT` : ''
const cond = `${CPU > 1 ? `CPU ${CPU}× slower` : 'unthrottled CPU'}${net}`
const coldMax = Math.max(rows.cold.before.done, rows.cold.after.done)
const step = coldMax > 4000 ? 1000 : 500
const coldMoments = Array.from({ length: Math.ceil(coldMax / step) + 1 }, (_, i) => i * step).slice(0, 9)
const retMoments = [0, 50, 100, 200, 400, 800, 1600, 3200].filter(ms => ms <= Math.max(rows.return.before.done, rows.return.after.done) + 400)
const files = [
  await sheet(browser, 'cold-visit', rows.cold, coldMoments, `Context — cold first visit (${cond})`),
  await sheet(browser, 'return-visit', rows.return, retMoments, `Context — return visit, Board → Context (${cond})`),
]
await browser.close()
console.log(JSON.stringify({ files, done_ms: { cold: { before: rows.cold.before.done, after: rows.cold.after.done }, return: { before: rows.return.before.done, after: rows.return.after.done } } }))

#!/usr/bin/env node
/**
 * Read-only card usage audit (obj 900857).
 *
 * Summarises API-equivalent cost/tokens on board cards over two windows
 * (default 30 and 90 days) by model, worker persona, owner bot, origin,
 * filing agent key, project, routine, week; lists the costliest cards and
 * estimates duplicate-worker and restart overhead.
 *
 * Input is the JSON array from GET /api/internal/objectives?fields=summary
 * (from a card session, send X-CC-Session-Token; the result is that
 * workspace only). Per-ACCOUNT attribution is not on card rows; it lives in
 * session_usage_daily and is served by the owner-only GET /api/costs/by-account.
 *
 * Usage:
 *   node scripts/usage-audit/card-usage-audit.mjs objectives.json [out.json] [--end YYYY-MM-DD]
 *
 * Read-only: it reads a file and writes a JSON summary. It calls no API.
 */
import fs from 'node:fs'
const args = process.argv.slice(2)
const endIdx = args.indexOf('--end')
const END = endIdx >= 0 ? args.splice(endIdx, 2)[1] : new Date().toISOString().slice(0, 10)
const [inPath, outPath] = args
if (!inPath) { console.error('usage: card-usage-audit.mjs objectives.json [out.json] [--end YYYY-MM-DD]'); process.exit(2) }
const rows = JSON.parse(fs.readFileSync(inPath, 'utf8'))
const dayKey = n => new Date(Date.parse(END) - n * 864e5).toISOString().slice(0, 10)
const W = { d30: dayKey(30), d90: dayKey(90) }
const c = r => r.total_cost_usd || 0, t = r => r.total_tokens || 0;
const out = {};
const norm = s => s.toLowerCase().replace(/^\[review\]\s*/, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
function agg(list, keyf) {
  const o = {};
  for (const r of list) {
    const k = keyf(r);
    o[k] = o[k] || { cards: 0, cost: 0, tokens: 0, sessions: 0 };
    o[k].cards++; o[k].cost += c(r); o[k].tokens += t(r); o[k].sessions += r.session_count || 0;
  }
  return Object.entries(o).map(([k, v]) => ({ key: k, ...v, cost: +v.cost.toFixed(2) })).sort((a, b) => b.cost - a.cost);
}
for (const [w, since] of Object.entries(W)) {
  const L = rows.filter(r => r.created_at >= since);
  const La = rows.filter(r => (r.last_activity_at || r.updated_at) >= since);
  const tot = L.reduce((a, r) => a + c(r), 0), tok = L.reduce((a, r) => a + t(r), 0), ses = L.reduce((a, r) => a + (r.session_count || 0), 0);
  const days = (Date.parse(END) - Date.parse(since)) / 864e5;
  const o = {
    since, days, cards: L.length, cards_with_cost: L.filter(r => c(r) > 0).length, cost: +tot.toFixed(2), tokens: tok, sessions: ses,
    per_day: +(tot / days).toFixed(2), cost_by_activity_window: +La.reduce((a, r) => a + c(r), 0).toFixed(2),
  };
  o.by_model = agg(L, r => r.model || 'default');
  o.by_ran_model = agg(L, r => r.ran_model || '(none)');
  o.by_bot = agg(L, r => r.agent_context || '?');
  o.by_owner_bot = agg(L, r => r.owner_bot || '(none)');
  o.by_origin = agg(L, r => r.origin || '?');
  o.by_agent_key = agg(L, r => r.agent_key_label || '(no agent key)');
  o.by_project = agg(L, r => r.project || '(none)');
  o.by_routine = agg(L.filter(r => r.routine_id), r => String(r.routine_id));
  o.by_type = agg(L, r => r.type);
  o.by_status = agg(L, r => r.status);
  o.by_week = agg(L, r => {
    const d = new Date(r.created_at.replace(' ', 'T') + 'Z');
    const m = new Date(d); m.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return m.toISOString().slice(0, 10);
  }).sort((a, b) => (a.key < b.key ? -1 : 1));
  o.top_cards = [...L].sort((a, b) => c(b) - c(a)).slice(0, 15).map(r => ({
    id: r.id, title: r.title, cost: +c(r).toFixed(2), sessions: r.session_count, status: r.status, bot: r.agent_context,
    origin: r.origin, model: r.model, review_iter: r.ai_review_iteration, start_reason: r.last_start_reason, created: r.created_at.slice(0, 10),
  }));
  o.sessions_hist = agg(L, r => { const n = r.session_count || 0; return n >= 8 ? '8+' : String(n); }).sort((a, b) => (a.key < b.key ? -1 : 1));
  let ub = 0, lb = 0;
  for (const r of L) {
    const n = r.session_count || 0;
    if (n > 2) ub += c(r) * (n - 2) / n;
    if (['fresh_seeded_after_cap', 'resume_after_limit'].includes(r.last_start_reason) && n > 0) lb += c(r) / n;
  }
  const five = L.filter(r => (r.session_count || 0) >= 5);
  o.restart_overhead = {
    upper_bound_sessions_beyond_2: +ub.toFixed(2), flagged_redo_starts_lower: +lb.toFixed(2),
    cards_5plus_sessions: five.length, cost_5plus: +five.reduce((a, r) => a + c(r), 0).toFixed(2),
    start_reasons: agg(L, r => r.last_start_reason || '(none recorded)'),
  };
  const g = {};
  for (const r of L) { if (/^\[review\]/i.test(r.title)) continue; const k = norm(r.title); (g[k] = g[k] || []).push(r); }
  const dups = []; let dupWaste = 0;
  for (const arr of Object.values(g)) {
    if (arr.length < 2) continue;
    const paid = arr.filter(r => c(r) > 0);
    if (paid.length < 2) continue;
    const keep = [...paid].sort((a, b) => ((b.status === 'done') - (a.status === 'done')) || (c(b) - c(a)))[0];
    const waste = paid.filter(r => r !== keep).reduce((a, r) => a + c(r), 0);
    dupWaste += waste;
    dups.push({ title: arr[0].title.slice(0, 100), ids: arr.map(r => r.id), costs: arr.map(r => +c(r).toFixed(2)), statuses: arr.map(r => r.status), waste: +waste.toFixed(2) });
  }
  dups.sort((a, b) => b.waste - a.waste);
  o.duplicate_cards = { groups: dups.length, waste: +dupWaste.toFixed(2), top: dups.slice(0, 15) };
  const rev = L.filter(r => /^\[review\]/i.test(r.title));
  o.review_companions = { cards: rev.length, cost: +rev.reduce((a, r) => a + c(r), 0).toFixed(2) };
  o.fallback = { ran_on_fallback: L.filter(r => r.ran_on_fallback).length, cost: +L.filter(r => r.ran_on_fallback).reduce((a, r) => a + c(r), 0).toFixed(2) };
  o.cancelled_spend = +L.filter(r => r.status === 'cancelled').reduce((a, r) => a + c(r), 0).toFixed(2);
  o.cancelled_paid_cards = L.filter(r => r.status === 'cancelled' && c(r) > 0).length;
  const dc = {};
  for (const r of L) { const d = r.created_at.slice(0, 10); dc[d] = (dc[d] || 0) + c(r); }
  o.costliest_days = Object.entries(dc).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([d, v]) => [d, +v.toFixed(0)]);
  out[w] = o;
}
const json = JSON.stringify(out, null, 1)
if (outPath) fs.writeFileSync(outPath, json)
else process.stdout.write(json + '\n')

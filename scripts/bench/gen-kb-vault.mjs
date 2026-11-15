#!/usr/bin/env node
// Synthetic knowledge-base vault for the Context / Graph load benchmark (obj 900867).
// Deterministic (seeded), so before/after runs measure the same vault.
//
//   node scripts/bench/gen-kb-vault.mjs <outDir> [scale=1]
//
// scale=1 ≈ 7,000 markdown files: two workspace knowledge folders (the bigger
// one is over the 2,000-node graph cap) plus daily notes and a deep archive,
// i.e. the shape of a long-lived second-brain vault.
import fs from 'fs'
import path from 'path'

const out = path.resolve(process.argv[2] || '/tmp/kb-bench-vault')
const scale = Number(process.argv[3] || 1)
let seed = 900867
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
const pick = (a) => a[Math.floor(rnd() * a.length)]
const FIRST = ['Dana', 'Lee', 'Sam', 'Ari', 'Kim', 'Jo', 'Max', 'Ola', 'Ravi', 'Mia', 'Noor', 'Theo', 'Ines', 'Yuki', 'Omar', 'Zoe']
const LAST = ['Ruiz', 'Chen', 'Park', 'Okafor', 'Silva', 'Novak', 'Haas', 'Moreau', 'Kaur', 'Berg', 'Ito', 'Lund', 'Reyes', 'Shah']
const CO = ['Greenway', 'Northwind', 'Bluefin', 'Atlas', 'Copper', 'Harbor', 'Summit', 'Pioneer', 'Lumen', 'Vector', 'Orchard', 'Keystone']
const SUF = ['Growers', 'Labs', 'Partners', 'Logistics', 'Capital', 'Foods', 'Systems', 'Health']
const WORDS = 'pipeline renewal pricing onboarding churn forecast supplier contract launch hiring audit migration roadmap budget review'.split(' ')
const para = (n) => Array.from({ length: n }, () => Array.from({ length: 12 + Math.floor(rnd() * 20) }, () => pick(WORDS)).join(' ') + '.').join('\n\n')

let files = 0
function write(rel, body) {
  const abs = path.join(out, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body)
  files++
}
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

function workspace(ws, n) {
  const base = `workspaces/${ws}`
  const people = Array.from({ length: Math.round(n.people * scale) }, (_, i) => `${pick(FIRST)} ${pick(LAST)} ${i}`)
  const cos = Array.from({ length: Math.round(n.companies * scale) }, (_, i) => `${pick(CO)} ${pick(SUF)} ${i}`)
  const projects = Array.from({ length: Math.round(n.projects * scale) }, (_, i) => `Project ${pick(WORDS)} ${i}`)
  const topics = Array.from({ length: Math.round(n.topics * scale) }, (_, i) => `Topic ${pick(WORDS)} ${i}`)
  for (const p of people) write(`${base}/people/${slug(p)}.md`, `---\ntype: person\n---\n# ${p}\n\nWorks at [[${pick(cos)}]].\n\n${para(2)}\n`)
  for (const c of cos) write(`${base}/companies/${slug(c)}.md`, `---\ntype: company\n---\n# ${c}\n\n${para(2)}\n\n## Related\n\n- [[${pick(people)}]]\n`)
  for (const p of projects) write(`${base}/projects/${slug(p)}.md`, `# ${p}\n\nOwner: [[${pick(people)}]]. Client: [[${pick(cos)}]].\n\n${para(3)}\n`)
  for (const t of topics) write(`${base}/topics/${slug(t)}.md`, `# ${t}\n\n${para(2)}\n`)
  for (let i = 0; i < Math.round(n.decisions * scale); i++) {
    write(`${base}/decisions/2026-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}-decision-${i}.md`,
      `# Decision ${i}\n\nFor [[${pick(projects)}]], with [[${pick(people)}]].\n\n${para(3)}\n\n## Related\n\n- Topic: [[${pick(topics)}]]\n`)
  }
  for (let i = 0; i < Math.round(n.sources * scale); i++) {
    const links = Array.from({ length: 2 + Math.floor(rnd() * 4) }, () => `[[${rnd() < 0.6 ? pick(people) : pick(cos)}]]`).join(', ')
    write(`${base}/sources/${2026 - (i % 3)}/call-${i}.md`, `---\ntype: source\n---\n# Call ${i}\n\nAttendees: ${links}.\n\n${para(4)}\n`)
  }
  for (let i = 0; i < Math.round(n.meetings * scale); i++) {
    write(`${base}/meetings/meeting-${i}.md`, `# Meeting ${i}\n\nWith [[${pick(people)}]] about [[${pick(projects)}]].\n\n${para(2)}\n`)
  }
}

fs.rmSync(out, { recursive: true, force: true })
workspace('operationkit', { people: 600, companies: 300, projects: 60, topics: 100, decisions: 400, sources: 1400, meetings: 300 })
workspace('your-org', { people: 300, companies: 150, projects: 30, topics: 50, decisions: 200, sources: 600, meetings: 150 })
for (let i = 0; i < Math.round(1000 * scale); i++) write(`daily/${2024 + (i % 3)}/${String(1 + (i % 12)).padStart(2, '0')}/day-${i}.md`, `# Day ${i}\n\n${para(2)}\n`)
for (let i = 0; i < Math.round(1200 * scale); i++) write(`archive/${pick(WORDS)}/${pick(WORDS)}/${pick(WORDS)}/note-${i}.md`, `# Note ${i}\n\n${para(1)}\n`)
console.log(JSON.stringify({ out, files }))

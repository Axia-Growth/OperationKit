#!/usr/bin/env node
// Usage: node src/wc.js [--lines] <file>
//   default: prints the number of words in <file>; --lines: the number of newlines.
import fs from 'node:fs'

const args = process.argv.slice(2)
const flags = args.filter((a) => a.startsWith('--'))
const files = args.filter((a) => !a.startsWith('--'))
for (const f of flags) {
  if (f !== '--lines') {
    console.error(`unknown flag: ${f}`)
    process.exit(2)
  }
}
const text = fs.readFileSync(files[0], 'utf8')
if (flags.includes('--lines')) console.log(String((text.match(/\n/g) ?? []).length))
else console.log(String(text.split(/\s+/).filter(Boolean).length))

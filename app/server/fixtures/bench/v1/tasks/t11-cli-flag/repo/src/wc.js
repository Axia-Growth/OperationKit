#!/usr/bin/env node
// Usage: node src/wc.js <file>   -> prints the number of words in <file>
import fs from 'node:fs'

const file = process.argv[2]
const text = fs.readFileSync(file, 'utf8')
const words = text.split(/\s+/).filter(Boolean).length
console.log(String(words))

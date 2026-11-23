/**
 * Writes shared/app-map.generated.json (obj 901493).
 *   npm run gen:app-map --workspace=client            # write
 *   npm run gen:app-map --workspace=client -- --check # exit 1 when the committed file is out of date
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateAppMap, renderAppMapFile } from '../src/lib/app-map/generate'

const here = path.dirname(fileURLToPath(import.meta.url))
const srcDir = path.resolve(here, '../src')
const outFile = path.resolve(here, '../../shared/app-map.generated.json')

const map = generateAppMap({ srcDir })
const text = renderAppMapFile(map)

if (process.argv.includes('--check')) {
  const current = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : ''
  if (current !== text) {
    console.error('shared/app-map.generated.json is out of date. Run: npm run gen:app-map --workspace=client')
    process.exit(1)
  }
  console.log('app map is up to date')
} else {
  fs.writeFileSync(outFile, text)
  const panels = map.pages.reduce((n, p) => n + p.panels.length, 0)
  console.log(`wrote ${path.relative(process.cwd(), outFile)}: ${map.pages.length} pages, ${panels} panels, ${map.redirects.length} redirects, ${map.undescribed.length} undescribed`)
}

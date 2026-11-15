// cn — className joiner for the UI primitives that also resolves conflicting
// Tailwind utilities: the LAST class of a group wins, so `cn('h-8 px-3', 'h-6')`
// gives `px-3 h-6` instead of leaving both heights to fight on CSS order.
// Dependency-free on purpose (a new package means an image rebuild); it covers
// the utility groups this codebase uses, not all of Tailwind.
export type ClassValue = string | false | null | undefined

const SIDES = ['x', 'y', 't', 'r', 'b', 'l', 's', 'e']
const TEXT_SIZES = new Set(['xs', 'sm', 'base', 'lg', 'xl', '2xl'])
const TEXT_NON_COLOR = /^(left|center|right|justify|start|end|ellipsis|clip|wrap|nowrap|balance|pretty)$/
const BG_NON_COLOR = /^(fixed|local|scroll|no-repeat|repeat.*|cover|contain|auto|center|top|bottom|left|right|none|gradient-.*|clip-.*|origin-.*|blend-.*)$/
const BORDER_STYLE = /^(solid|dashed|dotted|double|hidden|none)$/
const WIDTH_VALUE = /^(\d+|\[\d+(\.\d+)?px\])$/
const DISPLAY = new Set(['block', 'inline-block', 'inline', 'flex', 'inline-flex', 'grid', 'inline-grid', 'hidden', 'contents', 'table', 'flow-root'])
const POSITION = new Set(['static', 'fixed', 'absolute', 'relative', 'sticky'])
const FONT_WEIGHT = /^(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/
const SIMPLE_PREFIXES = [
  'min-w', 'max-w', 'min-h', 'max-h', 'w', 'h', 'size', 'tracking', 'leading', 'shadow', 'opacity', 'z',
  'justify', 'items', 'self', 'content', 'cursor', 'whitespace', 'outline', 'gap-x', 'gap-y', 'gap',
  'overflow-x', 'overflow-y', 'overflow', 'inset-x', 'inset-y', 'inset', 'top', 'right', 'bottom', 'left',
  'grow', 'shrink', 'basis', 'order', 'col-span', 'row-span', 'select', 'pointer-events', 'duration', 'ease',
]

// Returns [group, groups this class overrides when it comes later].
function groupOf(utility: string): [string, string[]] | null {
  const neg = utility.startsWith('-') ? utility.slice(1) : utility
  if (DISPLAY.has(neg)) return ['display', []]
  if (POSITION.has(neg)) return ['position', []]
  if (neg === 'truncate') return ['truncate', []]
  let m = /^(p|m)([xytrblse]?)-(.+)$/.exec(neg)
  if (m) {
    const [, kind, side] = m
    if (!side) return [kind, SIDES.map((s) => kind + s)]
    if (side === 'x') return [kind + 'x', [kind + 'l', kind + 'r', kind + 's', kind + 'e']]
    if (side === 'y') return [kind + 'y', [kind + 't', kind + 'b']]
    return [kind + side, []]
  }
  m = /^text-(.+)$/.exec(neg)
  if (m) {
    const v = m[1]
    if (TEXT_SIZES.has(v) || /^\[\d+(\.\d+)?(px|rem)\]$/.test(v)) return ['font-size', []]
    if (TEXT_NON_COLOR.test(v)) return [/^(ellipsis|clip)$/.test(v) ? 'text-overflow' : /wrap|balance|pretty/.test(v) ? 'text-wrap' : 'text-align', []]
    return ['text-color', []]
  }
  m = /^bg-(.+)$/.exec(neg)
  if (m) return BG_NON_COLOR.test(m[1]) ? null : ['bg-color', []]
  m = /^font-(.+)$/.exec(neg)
  if (m) return [FONT_WEIGHT.test(m[1]) ? 'font-weight' : 'font-family', []]
  m = /^rounded(-([trblse]{1,2}))?(-(.+))?$/.exec(neg)
  if (m) {
    const side = m[2] && /^(t|r|b|l|s|e|tl|tr|br|bl|ss|se|ee|es)$/.test(m[2]) ? m[2] : ''
    if (!side) return ['rounded', ['rounded-t', 'rounded-r', 'rounded-b', 'rounded-l', 'rounded-s', 'rounded-e', 'rounded-tl', 'rounded-tr', 'rounded-br', 'rounded-bl']]
    return ['rounded-' + side, []]
  }
  if (neg === 'border') return ['border-w', SIDES.map((s) => 'border-w-' + s)]
  m = /^border-([xytrblse])(-(.+))?$/.exec(neg)
  if (m) return !m[3] || WIDTH_VALUE.test(m[3]) ? ['border-w-' + m[1], []] : ['border-color-' + m[1], []]
  m = /^border-(.+)$/.exec(neg)
  if (m) {
    if (WIDTH_VALUE.test(m[1])) return ['border-w', SIDES.map((s) => 'border-w-' + s)]
    if (BORDER_STYLE.test(m[1])) return ['border-style', []]
    if (/^(collapse|separate)$/.test(m[1])) return null
    return ['border-color', []]
  }
  m = /^ring(-(.+))?$/.exec(neg)
  if (m) {
    if (!m[2] || /^(\d+|inset|\[\d+px\])$/.test(m[2])) return ['ring-w', []]
    if (m[2].startsWith('offset-')) return [/^offset-\d+$/.test(m[2]) ? 'ring-offset-w' : 'ring-offset-color', []]
    return ['ring-color', []]
  }
  if (/^flex-(row|col)(-reverse)?$/.test(neg)) return ['flex-direction', []]
  if (/^flex-(wrap|nowrap|wrap-reverse)$/.test(neg)) return ['flex-wrap', []]
  if (/^flex-(1|auto|initial|none|\[.+\])$/.test(neg)) return ['flex', []]
  for (const p of SIMPLE_PREFIXES) {
    if (neg === p || neg.startsWith(p + '-')) return [p, []]
  }
  return null
}

function splitVariant(cls: string): [string, string] {
  // Variants end at the last ':' outside brackets (`hover:`, `sm:`, `data-[open]:`).
  let depth = 0
  let cut = -1
  for (let i = 0; i < cls.length; i++) {
    const c = cls[i]
    if (c === '[') depth++
    else if (c === ']') depth--
    else if (c === ':' && depth === 0) cut = i
  }
  return cut < 0 ? ['', cls] : [cls.slice(0, cut + 1), cls.slice(cut + 1)]
}

export function cn(...parts: ClassValue[]): string {
  const classes = parts.filter(Boolean).join(' ').split(/\s+/).filter(Boolean)
  const covered = new Set<string>()
  const kept: string[] = []
  for (let i = classes.length - 1; i >= 0; i--) {
    const cls = classes[i]
    const [variant, rest] = splitVariant(cls)
    const important = rest.startsWith('!') ? '!' : ''
    const g = groupOf(important ? rest.slice(1) : rest)
    if (!g) {
      kept.push(cls)
      continue
    }
    const key = variant + important + g[0]
    if (covered.has(key)) continue
    covered.add(key)
    for (const o of g[1]) covered.add(variant + important + o)
    kept.push(cls)
  }
  return kept.reverse().join(' ')
}

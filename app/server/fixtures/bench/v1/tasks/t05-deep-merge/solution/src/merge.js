// deepMerge(target, source): returns a NEW object; neither input is mutated.
// Plain objects merge recursively; arrays and every other value from `source`
// replace the value in `target`. `undefined` in source leaves target's value.
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

export function deepMerge(target, source) {
  const out = { ...target }
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue
    out[k] = isPlain(v) && isPlain(out[k]) ? deepMerge(out[k], v) : v
  }
  return out
}

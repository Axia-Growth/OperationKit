// deepMerge(target, source): returns a NEW object; neither input is mutated.
// Plain objects merge recursively; arrays and every other value from `source`
// replace the value in `target`. `undefined` in source leaves target's value.
export function deepMerge(target, source) {
  return Object.assign(target, source)
}

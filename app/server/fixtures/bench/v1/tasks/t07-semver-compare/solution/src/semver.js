const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

function parse(v) {
  const [core, pre] = v.split('-', 2)
  return { nums: core.split('.').map(Number), pre: pre ? pre.split('.') : [] }
}

export function compareSemver(a, b) {
  const A = parse(a)
  const B = parse(b)
  for (let i = 0; i < 3; i++) if (A.nums[i] !== B.nums[i]) return cmp(A.nums[i], B.nums[i])
  if (!A.pre.length || !B.pre.length) return cmp(B.pre.length, A.pre.length)
  for (let i = 0; i < Math.min(A.pre.length, B.pre.length); i++) {
    const x = A.pre[i]
    const y = B.pre[i]
    if (x === y) continue
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) return cmp(Number(x), Number(y))
    if (xn) return -1
    if (yn) return 1
    return cmp(x, y)
  }
  return cmp(A.pre.length, B.pre.length)
}

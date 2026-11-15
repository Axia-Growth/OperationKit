const UNITS = { d: 86400, h: 3600, m: 60, s: 1 }

export function parseDuration(input) {
  const m = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(input)
  if (!input || !m) throw new RangeError(`invalid duration: ${JSON.stringify(input)}`)
  const [, d, h, mi, s] = m
  return (Number(d ?? 0) * UNITS.d) + (Number(h ?? 0) * UNITS.h) + (Number(mi ?? 0) * UNITS.m) + Number(s ?? 0)
}

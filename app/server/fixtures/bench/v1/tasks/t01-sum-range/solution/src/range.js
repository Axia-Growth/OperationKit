// Sum of every integer from `from` to `to`, BOTH ends inclusive.
// sumRange(1, 3) should be 6.
export function sumRange(from, to) {
  let total = 0
  for (let i = from; i <= to; i++) total += i
  return total
}

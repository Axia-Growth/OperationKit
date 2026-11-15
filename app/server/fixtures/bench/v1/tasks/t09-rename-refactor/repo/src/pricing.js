export function calc(items, taxRate) {
  const subtotal = items.reduce((sum, it) => sum + it.price * it.qty, 0)
  return Math.round(subtotal * (1 + taxRate) * 100) / 100
}

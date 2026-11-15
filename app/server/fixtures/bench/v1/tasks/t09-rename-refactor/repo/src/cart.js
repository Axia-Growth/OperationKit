import { calc } from './pricing.js'

export function cartTotal(items, taxRate) {
  return calc(items, taxRate)
}

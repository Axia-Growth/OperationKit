import { computeTotal } from './pricing.js'

export function cartTotal(items, taxRate) {
  return computeTotal(items, taxRate)
}

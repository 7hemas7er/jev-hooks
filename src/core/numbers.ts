// Probability arithmetic and number formatting for display.

// Logit clipping: rizzo computes P(yes) = σ(z_B − z_A), and beyond |z| = 36 a double
// can no longer tell p apart from 0 or 1. Clipping there keeps every transformation
// (Platt, band in logit) finite even on an answer of exactly 0 or 1.
export const LOGIT_MAX = 36

export function sigmoid(z: number): number {
  // stable form: exp of a large negative number does not overflow
  if (z >= 0) return 1 / (1 + Math.exp(-z))
  const e = Math.exp(z)
  return e / (1 + e)
}

export function clippedLogit(p: number): number {
  if (Number.isNaN(p)) return Number.NaN
  if (p <= 0) return -LOGIT_MAX
  if (p >= 1) return LOGIT_MAX
  const z = Math.log(p) - Math.log1p(-p)
  return Math.max(-LOGIT_MAX, Math.min(LOGIT_MAX, z))
}

// "0.87": a decimal point and no thousands separator (the numbers printed are
// probabilities, milliseconds and counts, and a grouping comma would read as a
// list). Never "-0.00".
export function formatNumber(x: number, decimals: number = 2): string {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? 'n/a' : x > 0 ? '∞' : '-∞'
  let s = x.toFixed(decimals)
  if (/^-0(\.0*)?$/.test(s)) s = s.slice(1)
  return s
}

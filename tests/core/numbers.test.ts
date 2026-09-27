import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LOGIT_MAX, clippedLogit, formatNumber, sigmoid } from '../../src/core/numbers.ts'

const near = (a: number, b: number, eps = 1e-12): void => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`)

test('sigmoid and logit are inverses and stable at the extremes', () => {
  for (const p of [1e-9, 0.02, 0.2, 0.5, 0.7, 0.9, 0.997, 1 - 1e-9]) near(sigmoid(clippedLogit(p)), p, 1e-9)
  assert.equal(sigmoid(0), 0.5)
  assert.equal(sigmoid(-1000), 0)
  assert.equal(sigmoid(1000), 1)
})

test('logit clipped at ±36, also on exact 0 and 1', () => {
  assert.equal(clippedLogit(0), -LOGIT_MAX)
  assert.equal(clippedLogit(1), LOGIT_MAX)
  assert.equal(clippedLogit(1e-300), -LOGIT_MAX)
  assert.equal(clippedLogit(-0.1), -LOGIT_MAX)
  assert.ok(Number.isNaN(clippedLogit(Number.NaN)))
  near(clippedLogit(0.5), 0)
})

test('Platt with a = 1/3 (the first rizzo-provisional) gives the design numbers', () => {
  const platt = (p: number): number => sigmoid(clippedLogit(p) / 3)
  assert.equal(formatNumber(platt(0.997), 3), '0.874')
  assert.equal(formatNumber(platt(0.9), 3), '0.675')
  assert.equal(formatNumber(platt(0.5), 3), '0.500')
  assert.equal(formatNumber(platt(0.02), 3), '0.215')
})

test('formatNumber: decimal point, no -0', () => {
  assert.equal(formatNumber(0.87), '0.87')
  assert.equal(formatNumber(0.874, 3), '0.874')
  assert.equal(formatNumber(3.1, 1), '3.1')
  assert.equal(formatNumber(4120, 0), '4120')
  assert.equal(formatNumber(-0.001), '0.00')
  assert.equal(formatNumber(-0.25), '-0.25')
  assert.equal(formatNumber(Number.NaN), 'n/a')
})

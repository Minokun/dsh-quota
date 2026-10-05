import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sparklinePoints, trendValues } from '../src/client/sparkline.ts'

test('sparkline maps a rising series across the full viewport, first/last on the edges', () => {
  const points = sparklinePoints([0, 5, 10], 48, 14)
  const [a, b, c] = points.split(' ')
  assert.equal(a, '0.0,12.6') // min -> bottom (with 10% pad)
  assert.equal(b, '24.0,7.0') // midpoint -> middle
  assert.equal(c.startsWith('48.0,'), true) // max -> top, right edge
})

test('a flat series centers on the midline instead of dividing by zero', () => {
  const points = sparklinePoints([7, 7, 7], 48, 14)
  assert.equal(points, '0.0,7.0 24.0,7.0 48.0,7.0')
})

test('fewer than two points or a non-positive viewport yields no polyline', () => {
  assert.equal(sparklinePoints([], 48, 14), '')
  assert.equal(sparklinePoints([1], 48, 14), '')
  assert.equal(sparklinePoints([1, 2], 0, 14), '')
  assert.equal(sparklinePoints([1, 2], 48, 0), '')
})

test('trendValues keeps the newest samples and drops malformed entries', () => {
  const row = [[1, 10], [2, 'x'], [3], 'junk', [4, 20], [5, 30], [6, 40]]
  assert.deepEqual(trendValues(row), [10, 20, 30, 40])
  assert.deepEqual(trendValues(row, 2), [30, 40]) // newest 2
  assert.deepEqual(trendValues(undefined), [])
  assert.deepEqual(trendValues([null, 42]), [])
})

test('trendValues accepts non-finite filtering', () => {
  assert.deepEqual(trendValues([[1, Number.NaN], [2, Number.POSITIVE_INFINITY], [3, 5]]), [5])
})

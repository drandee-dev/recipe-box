import test from 'node:test'
import assert from 'node:assert/strict'
import { ringWavBytes } from './ring.js'

const ascii = (b, at, n) => String.fromCharCode(...b.slice(at, at + n))

test('the ring is a well-formed 16-bit mono PCM wav', () => {
  const b = ringWavBytes()
  const v = new DataView(b.buffer)
  assert.equal(ascii(b, 0, 4), 'RIFF')
  assert.equal(ascii(b, 8, 4), 'WAVE')
  assert.equal(ascii(b, 12, 4), 'fmt ')
  assert.equal(v.getUint16(20, true), 1)
  assert.equal(v.getUint16(22, true), 1)
  assert.equal(v.getUint16(34, true), 16)
  assert.equal(ascii(b, 36, 4), 'data')
  // The two length fields must agree with the real size, or players refuse it.
  assert.equal(v.getUint32(4, true), b.length - 8)
  assert.equal(v.getUint32(40, true), b.length - 44)
  assert.equal(v.getUint32(28, true), v.getUint32(24, true) * 2)
})

function samples(b) {
  const v = new DataView(b.buffer)
  const out = []
  for (let i = 44; i < b.length; i += 2) out.push(v.getInt16(i, true) / 32768)
  return out
}

test('the alarm is audible, four beeps then a pause, and loops without a click', () => {
  const b = ringWavBytes()
  const s = samples(b)
  const rate = new DataView(b.buffer).getUint32(24, true)
  assert.ok(Math.max(...s.map(Math.abs)) > 0.6, 'peak is loud')
  assert.ok(Math.max(...s.map(Math.abs)) < 0.95, 'and does not clip')
  // A loop must join silence to silence, or every cycle starts with a click.
  assert.equal(s[0], 0)
  assert.ok(Math.abs(s[s.length - 1]) < 0.001)
  // A long gap at the end, so it reads as bursts and not a continuous drone.
  const tail = s.slice(Math.round(s.length - 0.5 * new DataView(b.buffer).getUint32(24, true)))
  assert.ok(Math.max(...tail.map(Math.abs)) < 0.001, 'the end of the cycle is silent')
  assert.equal(s[0], 0)
  assert.ok(Math.abs(s[s.length - 1]) < 0.001)
  // Count beeps by the loud windows: 10 ms blocks above a threshold, grouped.
  const block = Math.round(rate * 0.01)
  let beeps = 0
  let inBeep = false
  for (let i = 0; i + block <= s.length; i += block) {
    const loud = Math.max(...s.slice(i, i + block).map(Math.abs)) > 0.2
    if (loud && !inBeep) beeps += 1
    inBeep = loud
  }
  assert.equal(beeps, 4)
})

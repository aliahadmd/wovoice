import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeWav, resample } from '../src/renderer/src/lib/wav'

function sine(length: number, rate: number, frequency: number, amplitude = 0.5): Float32Array {
  const samples = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    samples[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / rate)
  }
  return samples
}

function zeroCrossings(samples: Float32Array): number {
  let count = 0
  for (let i = 1; i < samples.length; i++) {
    if (samples[i - 1] <= 0 && samples[i] > 0) count++
  }
  return count
}

test('resample keeps same-rate audio untouched', () => {
  const input = sine(16_000, 16_000, 440)
  assert.equal(resample(input, 16_000, 16_000), input)
})

test('resample preserves duration and frequency for non-multiple rates', () => {
  // 1 s of 100 Hz tone captured at 44.1 kHz — the old floor-decimation turned
  // this into a 22.05 kHz stream labelled 16 kHz (pitch shifted ~38%).
  const input = sine(44_100, 44_100, 100)
  const output = resample(input, 44_100, 16_000)
  assert.ok(Math.abs(output.length - 16_000) <= 2, `length ${output.length}`)
  const inputCycles = zeroCrossings(input) / 2
  const outputCycles = zeroCrossings(output) / 2
  assert.ok(Math.abs(outputCycles - inputCycles) <= 1, `${outputCycles} vs ${inputCycles} cycles`)
})

test('resample interpolates amplitude smoothly (48 kHz → 16 kHz)', () => {
  const input = sine(48_000, 48_000, 100)
  const output = resample(input, 48_000, 16_000)
  assert.equal(output.length, 16_000)
  const inputCycles = zeroCrossings(input) / 2
  const outputCycles = zeroCrossings(output) / 2
  assert.ok(Math.abs(outputCycles - inputCycles) <= 1)
})

test('encodeWav writes a 16 kHz mono PCM header and clamps samples', () => {
  // 16 kHz source: no resampling, so samples map one-to-one into the stream.
  const samples = Float32Array.from([0, 0.5, -0.5, 1.5, -1.5])
  const buffer = encodeWav(samples, 16_000)
  const view = new DataView(buffer)
  const magic = (offset: number): string =>
    String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3)
    )
  assert.equal(magic(0), 'RIFF')
  assert.equal(magic(8), 'WAVE')
  assert.equal(magic(12), 'fmt ')
  assert.equal(view.getUint16(20, true), 1) // PCM
  assert.equal(view.getUint16(22, true), 1) // mono
  assert.equal(view.getUint32(24, true), 16_000)
  assert.equal(view.getUint32(28, true), 32_000) // byte rate
  assert.equal(view.getUint16(34, true), 16) // bits per sample
  assert.equal(magic(36), 'data')
  assert.equal(view.getUint32(40, true), samples.length * 2)
  assert.equal(view.getInt16(44 + 0 * 2, true), 0)
  assert.equal(view.getInt16(44 + 1 * 2, true), 16_384) // 0.5
  assert.equal(view.getInt16(44 + 2 * 2, true), -16_384)
  assert.equal(view.getInt16(44 + 3 * 2, true), 32_767) // clamped
  assert.equal(view.getInt16(44 + 4 * 2, true), -32_768) // clamped
})

test('encodeWav output duration tracks the source duration', () => {
  const rate = 44_100
  const seconds = 3.5
  const buffer = encodeWav(sine(Math.round(rate * seconds), rate, 100), rate)
  const view = new DataView(buffer)
  const dataBytes = view.getUint32(40, true)
  const durationSeconds = dataBytes / 2 / 16_000
  assert.ok(Math.abs(durationSeconds - seconds) < 0.001, `${durationSeconds}`)
})

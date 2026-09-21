/**
 * Encodes Float32 PCM (captured at `sourceRate`) as a 16 kHz mono 16-bit WAV —
 * the exact byte format the Worker's validateWav enforces (60 s cap applied by
 * the caller before encoding).
 */
export function encodeWav(samples: Float32Array, sourceRate: number): ArrayBuffer {
  const pcm16k = resample(samples, sourceRate, TARGET_RATE)
  const outSamples = pcm16k.length
  const pcm = new Int16Array(outSamples)
  for (let i = 0; i < outSamples; i++) {
    const scaled = pcm16k[i] * 32768
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(scaled)))
  }

  const buffer = new ArrayBuffer(44 + outSamples * 2)
  const view = new DataView(buffer)
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + outSamples * 2, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, TARGET_RATE, true)
  view.setUint32(28, TARGET_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, outSamples * 2, true)
  for (let i = 0; i < outSamples; i++) view.setInt16(44 + i * 2, pcm[i], true)
  return buffer
}

/**
 * Linear-interpolation resampler. Works for any source rate — the previous
 * integer floor-decimation silently pitch-shifted audio from devices whose
 * rate isn't a multiple of 16 kHz (e.g. 44.1 kHz USB mics).
 */
export function resample(
  samples: Float32Array,
  sourceRate: number,
  targetRate: number
): Float32Array {
  if (sourceRate === targetRate || samples.length === 0) return samples
  const step = sourceRate / targetRate
  const outLength = Math.max(1, Math.round(samples.length / step))
  const out = new Float32Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const pos = i * step
    const i0 = Math.floor(pos)
    if (i0 + 1 >= samples.length) {
      out[i] = samples[Math.min(i0, samples.length - 1)]
      continue
    }
    const frac = pos - i0
    out[i] = samples[i0] + (samples[i0 + 1] - samples[i0]) * frac
  }
  return out
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
}

const TARGET_RATE = 16_000

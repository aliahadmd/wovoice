/**
 * Encodes Float32 PCM (captured at `sourceRate`) as a 16 kHz mono 16-bit WAV —
 * the exact byte format the Worker's validateWav enforces (60 s cap applied by
 * the caller before encoding).
 */
export function encodeWav(samples: Float32Array, sourceRate: number): ArrayBuffer {
  const factor = Math.max(1, Math.floor(sourceRate / TARGET_RATE))
  const outSamples = Math.floor(samples.length / factor)
  const pcm = new Int16Array(outSamples)
  for (let i = 0; i < outSamples; i++) {
    let sum = 0
    for (let j = 0; j < factor; j++) sum += samples[i * factor + j]
    const scaled = (sum / factor) * 32768
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

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
}

const TARGET_RATE = 16_000

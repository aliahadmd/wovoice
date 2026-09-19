/**
 * Silence gate — a direct port of the phone's SpeechSignalDetector: rejects
 * only near-digital silence and leaves the real voice decision to the
 * server-side ASR.
 */
export class SpeechSignalDetector {
  private totalSamples = 0
  private activeSamples = 0
  private totalSquares = 0
  private peakFrameRms = 0

  /** Consumes one frame of Float32 samples (-1..1); returns its RMS (0..1). */
  observe(samples: Float32Array): number {
    let squares = 0
    for (let i = 0; i < samples.length; i++) squares += samples[i] * samples[i]
    const rms = Math.sqrt(squares / samples.length)
    this.totalSamples += samples.length
    this.totalSquares += squares
    this.peakFrameRms = Math.max(this.peakFrameRms, rms)
    if (rms >= ACTIVE_FRAME_RMS) this.activeSamples += samples.length
    return rms
  }

  result(): {
    containsSpeech: boolean
    durationMs: number
    activeMs: number
    peakRms: number
    averageRms: number
  } {
    const durationMs = (this.totalSamples / SAMPLE_RATE) * 1000
    const activeMs = (this.activeSamples / SAMPLE_RATE) * 1000
    const averageRms =
      this.totalSamples === 0 ? 0 : Math.sqrt(this.totalSquares / this.totalSamples)
    return {
      containsSpeech:
        durationMs >= MIN_RECORDING_MS &&
        activeMs >= MIN_ACTIVE_MS &&
        this.peakFrameRms >= MIN_PEAK_FRAME_RMS,
      durationMs: Math.round(durationMs),
      activeMs: Math.round(activeMs),
      peakRms: this.peakFrameRms,
      averageRms
    }
  }
}

const SAMPLE_RATE = 16_000
const MIN_RECORDING_MS = 250
const MIN_ACTIVE_MS = 120
// ~-56.5 dBFS: rejects near-zero captures without mistaking a low-gain
// microphone for silence (identical thresholds to the phone build).
const ACTIVE_FRAME_RMS = 0.0015
const MIN_PEAK_FRAME_RMS = 0.0025

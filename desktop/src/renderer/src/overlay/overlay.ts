import { SpeechSignalDetector } from '../lib/speech'
import { encodeWav } from '../lib/wav'

/**
 * Overlay capture page: records the microphone while visible, animates the
 * waveform bars from live RMS, and hands the finished 16 kHz WAV to the main
 * process for transcription. Never focusable — the target app keeps focus.
 */
const MAX_DURATION_MS = 60_000

const label = document.getElementById('label') as HTMLDivElement
const cancel = document.getElementById('cancel') as HTMLButtonElement
const bars = Array.from(document.getElementById('bars')!.children) as HTMLDivElement[]

let chunks: Float32Array[] = []
let detector: SpeechSignalDetector | null = null
let audioContext: AudioContext | null = null
let mediaStream: MediaStream | null = null
let autoStop: ReturnType<typeof setTimeout> | null = null

function setLabel(text: string): void {
  label.textContent = text
}

async function begin(): Promise<void> {
  if (running()) return
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    })
  } catch {
    fail('Microphone access was denied. Enable it and try again.')
    return
  }

  chunks = []
  detector = new SpeechSignalDetector()
  audioContext = new AudioContext()
  const source = audioContext.createMediaStreamSource(mediaStream)
  const processor = audioContext.createScriptProcessor(4096, 1, 1)
  processor.onaudioprocess = (event) => {
    if (!running()) return
    const input = event.inputBuffer.getChannelData(0)
    const copy = new Float32Array(input)
    chunks.push(copy)
    const rms = detector!.observe(copy)
    animateBars(rms)
  }
  source.connect(processor)
  processor.connect(audioContext.destination)

  runningFlag.value = true
  window.api.overlay.setLabel('Listening… (release or tap to stop)')

  autoStop = setTimeout(() => finish(), MAX_DURATION_MS)
}

function running(): boolean {
  return runningFlag.value
}

const runningFlag = { value: false }

let barPhase = 0
function animateBars(rms: number): void {
  barPhase += 0.6
  bars.forEach((bar, index) => {
    const wobble = 0.65 + 0.35 * Math.abs(Math.sin(barPhase + index * 0.9))
    const height = Math.max(14, 14 + 52 * Math.min(1, rms * 8) * wobble)
    bar.style.height = `${height}px`
  })
}

function finish(): void {
  if (autoStop !== null) {
    clearTimeout(autoStop)
    autoStop = null
  }
  const captured = chunks
  chunks = []
  const detection = detector?.result() ?? { containsSpeech: false, durationMs: 0 }
  teardownAudio()
  runningFlag.value = false

  if (!detection.containsSpeech) {
    window.api.overlay.fail('No clear speech — try again')
    return
  }

  const merged = new Float32Array(captured.reduce((sum, chunk) => sum + chunk.length, 0))
  let offset = 0
  for (const chunk of captured) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  const wav = encodeWav(merged, audioContext?.sampleRate ?? 48_000)
  window.api.overlay.done({
    wav,
    durationMs: detection.durationMs,
    containsSpeech: detection.containsSpeech
  })
}

function fail(message: string): void {
  window.api.overlay.fail(message)
}

function cancelCapture(): void {
  if (autoStop !== null) clearTimeout(autoStop)
  autoStop = null
  chunks = []
  teardownAudio()
  runningFlag.value = false
  window.api.overlay.cancelled()
}

function teardownAudio(): void {
  mediaStream?.getTracks().forEach((track) => track.stop())
  mediaStream = null
  void audioContext?.close()
  audioContext = null
  bars.forEach((bar) => (bar.style.height = '14px'))
}

window.api.overlay.onBegin(() => {
  setLabel('Listening… (release or tap to stop)')
  void begin()
})
window.api.overlay.onEnd(() => finish())
window.api.overlay.onCancel(() => cancelCapture())
cancel.addEventListener('click', cancelCapture)

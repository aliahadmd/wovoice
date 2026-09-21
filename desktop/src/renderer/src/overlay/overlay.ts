import { SpeechSignalDetector } from '../lib/speech'
import { encodeWav } from '../lib/wav'

/**
 * Overlay bubble: an animated pill that walks through the dictation story —
 * recording (live waveform + timer) → uploading → transcribing (shimmer +
 * thinking dots) → inserted (✓ + text preview) / error / cancelled.
 * Never focusable — the target app keeps focus.
 */
const MAX_DURATION_MS = 60_000
// Mirrors the main-process visibility windows minus a beat for the exit anim.
const SUCCESS_EXIT_AT_MS = 1900
const ERROR_EXIT_AT_MS = 3300
const CANCELLED_EXIT_AT_MS = 1300
const BAR_COUNT = 18

const pill = document.getElementById('pill') as HTMLDivElement
const stateLine = document.getElementById('stateLine') as HTMLDivElement
const subLine = document.getElementById('subLine') as HTMLDivElement
const timerEl = document.getElementById('timer') as HTMLDivElement
const barsEl = document.getElementById('bars') as HTMLDivElement
const cancel = document.getElementById('cancel') as HTMLButtonElement

const bars: HTMLDivElement[] = []
for (let i = 0; i < BAR_COUNT; i++) {
  const bar = document.createElement('div')
  bar.className = 'bar'
  barsEl.appendChild(bar)
  bars.push(bar)
}

type UiState = 'idle' | 'recording' | 'processing' | 'success' | 'error' | 'cancelled'
let uiState: UiState = 'idle'

let chunks: Float32Array[] = []
let detector: SpeechSignalDetector | null = null
let audioContext: AudioContext | null = null
let mediaStream: MediaStream | null = null
let autoStop: ReturnType<typeof setTimeout> | null = null
let stateTimers: ReturnType<typeof setTimeout>[] = []
let phaseTimers: ReturnType<typeof setTimeout>[] = []
let tickInterval: ReturnType<typeof setInterval> | null = null
let tickStart = 0

const runningFlag = { value: false }
function running(): boolean {
  return runningFlag.value
}

function setState(state: UiState): void {
  uiState = state
  document.body.dataset.state = state
}

function clearTimers(list: ReturnType<typeof setTimeout>[]): void {
  for (const t of list) clearTimeout(t)
  list.length = 0
}

function schedule(fn: () => void, ms: number): void {
  const t = setTimeout(fn, ms)
  stateTimers.push(t)
}

function setLine(text: string): void {
  stateLine.textContent = text
}

function setSub(text: string): void {
  subLine.textContent = text
}

function startTick(): void {
  stopTick()
  tickStart = Date.now()
  tickInterval = setInterval(() => {
    const s = Math.floor((Date.now() - tickStart) / 1000)
    timerEl.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  }, 200)
}

function stopTick(): void {
  if (tickInterval !== null) clearInterval(tickInterval)
  tickInterval = null
}

function enterRecording(): void {
  setState('recording')
  pill.classList.remove('closing')
  pill.classList.add('show')
  pill.dataset.tone = ''
  setLine('Listening…')
  subLine.innerHTML = 'Release ⌥ to transcribe · <kbd>esc</kbd> cancels'
  timerEl.textContent = '0:00'
  startTick()
  for (const bar of bars) bar.style.height = '5px'
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
  audioContext = new AudioContext()
  // Chromium starts contexts suspended without user activation; the overlay
  // is never focused, so resume explicitly or no audio callbacks ever fire.
  if (audioContext.state === 'suspended') await audioContext.resume()
  detector = new SpeechSignalDetector(audioContext.sampleRate)
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
  autoStop = setTimeout(() => finish(), MAX_DURATION_MS)
}

let barPhase = 0
function animateBars(rms: number): void {
  barPhase += 0.55
  for (let i = 0; i < bars.length; i++) {
    const wobble = 0.55 + 0.45 * Math.abs(Math.sin(barPhase + i * 0.7))
    const level = Math.min(1, rms * 9)
    const height = 5 + level * 29 * (0.55 + 0.45 * wobble)
    bars[i].style.height = `${height}px`
  }
}

function settleBars(): void {
  for (const bar of bars) bar.style.height = '5px'
}

function enterProcessing(): void {
  clearTimers(phaseTimers)
  setState('processing')
  pill.dataset.tone = ''
  settleBars()
  startTick()
  setLine('Uploading audio…')
  setSub('')
  phaseTimers.push(
    setTimeout(() => {
      if (uiState === 'processing') setLine('Transcribing…')
    }, 750)
  )
}

function setSuccess(text: string, polished: boolean): void {
  clearTimers(phaseTimers)
  stopTick()
  setState('success')
  pill.dataset.tone = 'success'
  setLine(text)
  setSub(
    polished
      ? 'Inserted at your cursor · <span class="chip">✨ polished</span>'
      : 'Inserted at your cursor'
  )
  schedule(() => pill.classList.add('closing'), SUCCESS_EXIT_AT_MS)
}

function fail(message: string): void {
  clearTimers(phaseTimers)
  stopTick()
  setState('error')
  pill.dataset.tone = 'error'
  setLine(message)
  setSub('Nothing was inserted')
  schedule(() => pill.classList.add('closing'), ERROR_EXIT_AT_MS)
}

function setCancelled(): void {
  clearTimers(phaseTimers)
  stopTick()
  runningFlag.value = false
  setState('cancelled')
  pill.dataset.tone = ''
  setLine('Dictation cancelled')
  setSub('')
  settleBars()
  schedule(() => pill.classList.add('closing'), CANCELLED_EXIT_AT_MS)
}

function finish(): void {
  if (autoStop !== null) {
    clearTimeout(autoStop)
    autoStop = null
  }
  if (tickInterval !== null) clearInterval(tickInterval)
  enterProcessing()
  const captured = chunks
  chunks = []
  const detection = detector?.result() ?? { containsSpeech: false, durationMs: 0 }
  teardownAudio()
  runningFlag.value = false

  if (!detection.containsSpeech) {
    console.log('overlay page: speech gate rejected —', JSON.stringify(detection))
    window.api.overlay.fail('No clear speech detected — try holding ⌥ a little longer')
    return
  }

  const merged = new Float32Array(captured.reduce((sum, chunk) => sum + chunk.length, 0))
  let offset = 0
  for (const chunk of captured) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  const wav = encodeWav(merged, audioContext?.sampleRate ?? 48_000)
  console.log('overlay page: sending WAV,', merged.length, 'samples @', audioContext?.sampleRate ?? 48_000, 'Hz')
  window.api.overlay.done({
    wav,
    durationMs: detection.durationMs,
    containsSpeech: detection.containsSpeech
  })
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
  settleBars()
}

window.api.overlay.onBegin(() => {
  clearTimers(stateTimers)
  pill.classList.remove('closing')
  enterRecording()
  void begin()
})
window.api.overlay.onEnd(() => finish())
window.api.overlay.onCancel(() => {
  clearTimers(stateTimers)
  cancelCapture()
})
window.api.overlay.onState((state) => {
  if (state.state === 'transcribing') {
    // Main picked the capture up; keep the processing visuals going.
    if (uiState === 'processing') setLine('Transcribing…')
    return
  }
  if (state.state === 'success') {
    setSuccess(state.text, state.polished)
    return
  }
  if (state.state === 'error') {
    fail(state.message)
    return
  }
  if (state.state === 'cancelled') {
    setCancelled()
  }
})
cancel.addEventListener('click', cancelCapture)

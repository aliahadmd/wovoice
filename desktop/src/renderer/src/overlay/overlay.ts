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
const stateTimers: ReturnType<typeof setTimeout>[] = []
const phaseTimers: ReturnType<typeof setTimeout>[] = []
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

function enterRecording(releaseHint: string): void {
  setState('recording')
  pill.classList.remove('closing')
  pill.classList.add('show')
  pill.dataset.tone = ''
  setLine('Listening…')
  // The hint used to say "⌥" whatever trigger key was chosen.
  subLine.textContent = `${releaseHint} to transcribe · `
  const esc = document.createElement('kbd')
  esc.textContent = 'esc'
  subLine.append(esc, ' cancels')
  timerEl.textContent = '0:00'
  startTick()
  for (const bar of bars) bar.style.height = '5px'
}

async function begin(): Promise<void> {
  if (running()) return
  // Claim the session synchronously: a release that lands while the mic is
  // still starting must not leave a ghost recording running after finish().
  runningFlag.value = true
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
    runningFlag.value = false
    fail('Microphone access was denied. Enable it and try again.')
    return
  }
  if (!running()) {
    // Cancelled while getUserMedia was pending — release the device we opened.
    teardownAudio()
    return
  }

  chunks = []
  audioContext = new AudioContext()
  // Chromium starts contexts suspended without user activation; the overlay
  // is never focused, so resume explicitly or no audio callbacks ever fire.
  if (audioContext.state === 'suspended') await audioContext.resume()
  if (!running()) {
    teardownAudio()
    return
  }
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
  // ScriptProcessorNode only pumps while connected to the destination; a
  // zero-gain node keeps it running without monitoring the mic out loud.
  const mute = audioContext.createGain()
  mute.gain.value = 0
  processor.connect(mute)
  mute.connect(audioContext.destination)

  // Ask main to end the session: finishing here alone left main in its
  // "recording" state, so it discarded the WAV and the dictation was lost.
  autoStop = setTimeout(() => {
    autoStop = null
    window.api.overlay.autoStop()
  }, MAX_DURATION_MS)
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
  setSub(polished ? 'Inserted at your cursor · ' : 'Inserted at your cursor')
  if (polished) {
    // setSub writes textContent, so the chip markup used to show as literal tags.
    const chip = document.createElement('span')
    chip.className = 'chip'
    chip.textContent = '✨ polished'
    subLine.appendChild(chip)
  }
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
  // The cancelled state can arrive from main (Esc) while the mic is live:
  // release the device, the pending auto-stop, and any buffered audio now,
  // or a stale auto-stop would transcribe and paste the cancelled audio.
  discardCapture()
  clearTimers(phaseTimers)
  setState('cancelled')
  pill.dataset.tone = ''
  setLine('Dictation cancelled')
  setSub('')
  settleBars()
  schedule(() => pill.classList.add('closing'), CANCELLED_EXIT_AT_MS)
}

/** Releases every capture resource; safe to call from any state. */
function discardCapture(): void {
  if (autoStop !== null) {
    clearTimeout(autoStop)
    autoStop = null
  }
  stopTick()
  chunks = []
  detector = null
  teardownAudio()
  runningFlag.value = false
}

function finish(): void {
  if (autoStop !== null) {
    clearTimeout(autoStop)
    autoStop = null
  }
  stopTick()
  enterProcessing()
  const captured = chunks
  chunks = []
  const detection = detector?.result() ?? { containsSpeech: false, durationMs: 0 }
  detector = null
  // Read the live rate before teardownAudio() nulls the context — the
  // fallback would otherwise encode every recording as 48 kHz regardless
  // of the input device (44.1 kHz mics produced pitch-shifted WAVs).
  const sampleRate = audioContext?.sampleRate ?? 48_000
  teardownAudio()
  runningFlag.value = false

  if (!detection.containsSpeech) {
    console.log('overlay page: speech gate rejected —', JSON.stringify(detection))
    window.api.overlay.fail('No clear speech detected — try speaking a little longer')
    return
  }

  // The cap timer starts after the microphone opens and audio arrives in
  // 4096-sample blocks, so a capped recording can run a little past 60 s —
  // beyond the Worker's 60.1 s limit. Trim to exactly the cap.
  const maxSamples = Math.floor((sampleRate * MAX_DURATION_MS) / 1000)
  const total = Math.min(
    maxSamples,
    captured.reduce((sum, chunk) => sum + chunk.length, 0)
  )
  const merged = new Float32Array(total)
  let offset = 0
  for (const chunk of captured) {
    if (offset >= total) break
    const part = chunk.subarray(0, total - offset)
    merged.set(part, offset)
    offset += part.length
  }
  const wav = encodeWav(merged, sampleRate)
  console.log('overlay page: sending WAV,', merged.length, 'samples @', sampleRate, 'Hz')
  window.api.overlay.done({
    wav,
    durationMs: Math.min(detection.durationMs, MAX_DURATION_MS),
    containsSpeech: detection.containsSpeech
  })
}

function cancelCapture(): void {
  discardCapture()
  window.api.overlay.cancelled()
}

function teardownAudio(): void {
  mediaStream?.getTracks().forEach((track) => track.stop())
  mediaStream = null
  void audioContext?.close()
  audioContext = null
  settleBars()
}

window.api.overlay.onBegin((releaseHint) => {
  clearTimers(stateTimers)
  pill.classList.remove('closing')
  enterRecording(releaseHint)
  void begin()
})
window.api.overlay.onEnd(() => finish())
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

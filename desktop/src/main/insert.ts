import { clipboard } from 'electron'
import { execFile } from 'child_process'

const PASTE_SETTLE_MS = 120
const PASTE_AFTER_MS = 300
const APPLESCRIPT_TIMEOUT_MS = 5_000

/**
 * Inserts text at the focused app's cursor: clipboard save → write →
 * synthesized ⌘V → restore. Requires the Accessibility permission.
 * The previous clipboard contents (text or image) are restored even when the
 * keystroke fails, so a failed paste never leaves the dictated text behind.
 */
export async function pasteText(text: string): Promise<void> {
  if (text.length === 0) return
  const previousText = clipboard.readText()
  const hasImage = clipboard
    .availableFormats()
    .some((format) => format.startsWith('image/'))
  const previousImage = hasImage ? clipboard.readImage() : null
  clipboard.writeText(text)
  try {
    await sleep(PASTE_SETTLE_MS)
    await new Promise<void>((resolve, reject) => {
      execFile(
        'osascript',
        ['-e', 'tell application "System Events" to keystroke "v" using command down'],
        { timeout: APPLESCRIPT_TIMEOUT_MS },
        (error) => (error ? reject(error) : resolve())
      )
    })
    await sleep(PASTE_AFTER_MS)
  } finally {
    if (previousImage !== null && !previousImage.isEmpty()) clipboard.writeImage(previousImage)
    else clipboard.writeText(previousText)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

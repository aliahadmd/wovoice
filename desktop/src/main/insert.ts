import { clipboard } from 'electron'
import { execFile } from 'child_process'

/**
 * Inserts text at the focused app's cursor: clipboard save → write →
 * synthesized ⌘V → restore. Requires the Accessibility permission.
 */
export async function pasteText(text: string): Promise<void> {
  if (text.length === 0) return
  const previous = clipboard.readText()
  clipboard.writeText(text)
  await sleep(120)
  await new Promise<void>((resolve, reject) => {
    execFile(
      'osascript',
      ['-e', 'tell application "System Events" to keystroke "v" using command down'],
      (error) => (error ? reject(error) : resolve())
    )
  })
  await sleep(300)
  clipboard.writeText(previous)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

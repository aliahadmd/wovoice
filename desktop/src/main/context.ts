import { app } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import {
  classifyContext,
  restrictContext,
  type ContextLevel,
  type ContextStyle,
  type DictationContext
} from '../../../worker/src/context'
export { restrictContext }
export type { ContextLevel, ContextStyle, DictationContext }
interface EditorSnapshot {
  reason?: 'accessibility' | 'editor'
  available: boolean
  token?: string
  appId?: string
  hint?: string
  field?: 'text' | 'search' | 'literal' | 'code'
  sentenceStart?: boolean
  before?: string
  after?: string
}
export interface ContextTarget {
  reason?: 'accessibility' | 'editor'
  token?: string
  sentenceStart: boolean
  context?: DictationContext
}
/** A bounded private IPC channel; raw snippets never reach logs or persistent storage. */
export class ContextReader {
  private child: ChildProcessWithoutNullStreams | null = null
  private sequence = 0
  private pending = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; timer: ReturnType<typeof setTimeout> }
  >()
  prepare(): void {
    if (this.child) return
    const path = app.isPackaged
      ? join(process.resourcesPath, 'contextd')
      : join(__dirname, '../../native/contextd')
    const child = spawn(path, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        const value = JSON.parse(line)
        const pending = this.pending.get(value.id)
        if (!pending) return
        this.pending.delete(value.id)
        clearTimeout(pending.timer)
        pending.resolve(value.result)
      } catch {
        /* Ignore malformed output; the request deadline closes the helper. */
      }
    })
    child.stderr.resume()
    child.on('error', () => {
      if (this.child === child) this.dispose()
    })
    child.on('exit', () => {
      if (this.child === child) this.dispose()
    })
  }
  private request(
    command: string,
    extra: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    this.prepare()
    return new Promise((resolve) => {
      const id = ++this.sequence
      const timer = setTimeout(() => this.dispose(), 2500)
      this.pending.set(id, { resolve, timer })
      this.child?.stdin.write(JSON.stringify({ id, command, ...extra }) + '\n', (error) => {
        if (error) this.dispose()
      })
    })
  }
  async capture(level: ContextLevel, style: ContextStyle): Promise<ContextTarget> {
    const value = (await this.request('capture', { level })) as unknown as EditorSnapshot
    if (!value.available || typeof value.token !== 'string')
      return { sentenceStart: true, reason: value.reason }
    return {
      token: value.token,
      sentenceStart: value.sentenceStart !== false,
      context: classifyContext({
        appId: value.appId ?? '',
        hint: value.hint,
        field: value.field,
        level,
        style,
        before: value.before,
        after: value.after
      })
    }
  }
  async validate(token?: string): Promise<boolean> {
    return !!token && (await this.request('validate', { token })).valid === true
  }
  release(): void {
    if (this.child) void this.request('release')
  }
  dispose(): void {
    const child = this.child
    this.child = null
    for (const item of this.pending.values()) {
      clearTimeout(item.timer)
      item.resolve({})
    }
    this.pending.clear()
    child?.kill()
  }
}

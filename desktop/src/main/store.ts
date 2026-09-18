import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

/** JSON-backed app settings under ~/Library/Application Support/WoVoice. */
export class SettingsStore {
  private readonly file: string
  private readonly data: Record<string, unknown>

  constructor(dir = join(app.getPath('userData'))) {
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'settings.json')
    this.data = this.read()
  }

  private read(): Record<string, unknown> {
    try {
      return JSON.parse(readFileSync(this.file, 'utf-8')) as Record<string, unknown>
    } catch {
      return {}
    }
  }

  private persist(): void {
    writeFileSync(this.file, JSON.stringify(this.data, null, 2))
  }

  get<T>(key: string, fallback: T): T {
    const value = this.data[key]
    return (value === undefined ? fallback : value) as T
  }

  set<T>(key: string, value: T): void {
    if (value === undefined) delete this.data[key]
    else this.data[key] = value
    this.persist()
  }

  get workerUrl(): string {
    return this.get<string>('workerUrl', 'https://wovoice.aliahad.com')
  }

  get syncCursor(): number {
    return this.get<number>('syncCursor', 0)
  }

  set syncCursor(value: number) {
    this.set('syncCursor', value)
  }

  get vaultRecoveryAcknowledged(): boolean {
    return this.get<boolean>('vaultRecoveryAcknowledged', false)
  }

  set vaultRecoveryAcknowledged(value: boolean) {
    this.set('vaultRecoveryAcknowledged', value)
  }

  clearAccount(): void {
    for (const key of ['accountId', 'accountEmail', 'accountRole', 'accountState', 'accountPublicMessage', 'accountSupportEmail', 'syncCursor', 'vaultRecoveryAcknowledged']) {
      delete this.data[key]
    }
    this.persist()
  }
}

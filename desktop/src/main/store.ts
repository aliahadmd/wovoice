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

  // Cloud sync keeps its own cursor: the old vault's 'syncCursor' counts a different feed.
  get syncCursor(): number {
    return this.get<number>('cloudSyncCursor', 0)
  }

  set syncCursor(value: number) {
    this.set('cloudSyncCursor', value)
  }

  /** Account whose one-time move from the old recovery-key vault is done on this Mac. */
  get cloudSyncMigratedAccount(): string | null {
    return this.get<string | null>('cloudSyncMigratedAccount', null)
  }

  set cloudSyncMigratedAccount(value: string | null) {
    this.set('cloudSyncMigratedAccount', value ?? undefined)
  }

  get historySyncEnabled(): boolean {
    return this.get<boolean>('historySyncEnabled', true)
  }

  set historySyncEnabled(value: boolean) {
    this.set('historySyncEnabled', value)
  }

  get historyRetentionDays(): number | null {
    return this.get<number | null>('historyRetentionDays', null)
  }

  set historyRetentionDays(value: number | null) {
    this.set('historyRetentionDays', value ?? undefined)
  }

  get lastSyncAt(): number {
    return this.get<number>('lastSyncAt', 0)
  }

  set lastSyncAt(value: number) {
    this.set('lastSyncAt', value)
  }

  get keyboardShortcutEnabled(): boolean {
    return this.get<boolean>('keyboardShortcutEnabled', true)
  }

  set keyboardShortcutEnabled(value: boolean) {
    this.set('keyboardShortcutEnabled', value)
  }

  get middleClickEnabled(): boolean {
    return this.get<boolean>('middleClickEnabled', false)
  }

  set middleClickEnabled(value: boolean) {
    this.set('middleClickEnabled', value)
  }

  clearAccount(): void {
    // cloudSyncMigratedAccount survives sign-out: that account's vault import is done here.
    for (const key of [
      'accountId',
      'accountEmail',
      'accountRole',
      'accountState',
      'accountPublicMessage',
      'accountSupportEmail',
      'syncCursor',
      'vaultRecoveryAcknowledged',
      'cloudSyncCursor',
      'historySyncEnabled',
      'historyRetentionDays',
      'lastSyncAt'
    ]) {
      delete this.data[key]
    }
    this.persist()
  }
}

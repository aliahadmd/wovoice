import { safeStorage } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { WorkerError, type WorkerClient } from './worker'
import {
  decodeRecoveryKey,
  encryptRecord,
  newSecret,
  unwrapVaultKey,
  wrapVaultKey
} from './vault-crypto'

const KEY_VERSION = 1
const SCHEMA_VERSION = 1
const MAX_BATCH = 100

export interface RemoteSyncItem {
  id: string
  type: 'history' | 'dictionary' | 'analytics'
  version: number
  keyVersion: number
  nonce: string | null
  ciphertext: string | null
  deleted: boolean
}

export type SyncOutcome =
  | { kind: 'ok'; uploaded: number; downloaded: number }
  | { kind: 'needs-recovery' }
  | { kind: 'reconciled' }
  | { kind: 'error'; message: string }

/**
 * End-to-end encrypted sync, mirroring the phone's SyncCoordinator: a random
 * vault key encrypts each record (AAD-bound to account|type|id|version), the
 * vault key is wrapped with the user's recovery secret and only the wrapped
 * form reaches the server. Deletes push tombstones; conflicts are server-wins.
 */
export class SyncService {
  private vaultKey: Buffer | null = null
  private syncing: Promise<SyncOutcome> | null = null

  constructor(
    private readonly deps: {
      worker: WorkerClient
      settings: { workerUrl: string; getAccountId: () => string | null; getCursor: () => number; setCursor: (v: number) => void }
      db: import('./db').WoVoiceDb
      getToken: () => Promise<string>
      vaultDir: string
    }
  ) {}

  get vaultConfigured(): boolean {
    return this.loadSealed('vault-key.bin') !== null
  }

  async status(): Promise<{ vaultConfigured: boolean; signedIn: boolean }> {
    let remoteConfigured = false
    try {
      const token = await this.deps.getToken()
      const vault = await this.deps.worker.getVault(token)
      remoteConfigured = vault !== null
    } catch {
      remoteConfigured = false
    }
    return { vaultConfigured: this.vaultConfigured || remoteConfigured, signedIn: true }
  }

  async importRecoveryKey(key: string): Promise<boolean> {
    const recoverySecret = decodeRecoveryKey(key)
    if (recoverySecret === null) return false
    const token = await this.deps.getToken()
    const remote = await this.deps.worker.getVault(token)
    if (remote === null) return false
    const accountId = this.accountId()
    const vaultKey = unwrapVaultKey(remote, recoverySecret, accountId)
    if (vaultKey === null) return false
    this.seal('vault-key.bin', vaultKey)
    this.seal('recovery-secret.bin', recoverySecret)
    this.vaultKey = vaultKey
    return true
  }

  async syncNow(): Promise<SyncOutcome> {
    if (this.syncing === null) {
      this.syncing = this.run().finally(() => {
        this.syncing = null
      })
    }
    return this.syncing
  }

  private accountId(): string {
    const id = this.deps.settings.getAccountId()
    if (id === null) throw new WorkerError('AUTH_REQUIRED', 'Sign in first.', false, 401)
    return id
  }

  private async ensureVault(): Promise<'ready' | 'needs-recovery'> {
    const token = await this.deps.getToken()
    const accountId = this.accountId()
    const remote = await this.deps.worker.getVault(token)
    const localKey = this.loadSealed('vault-key.bin')
    if (remote !== null && localKey !== null) {
      this.vaultKey = localKey
      return 'ready'
    }
    if (remote !== null) return 'needs-recovery'

    const vaultKey = localKey ?? newSecret()
    const recoverySecret = this.loadSealed('recovery-secret.bin') ?? newSecret()
    const wrapped = wrapVaultKey(vaultKey, recoverySecret, accountId, KEY_VERSION)
    await this.deps.worker.putVault(token, wrapped, null)
    this.seal('vault-key.bin', vaultKey)
    this.seal('recovery-secret.bin', recoverySecret)
    this.vaultKey = vaultKey
    return 'ready'
  }

  private async run(): Promise<SyncOutcome> {
    try {
      const vaultState = await this.ensureVault()
      if (vaultState !== 'ready') return { kind: 'needs-recovery' }
      const token = await this.deps.getToken()
      const accountId = this.accountId()
      const vaultKey = this.vaultKey
      if (vaultKey === null) return { kind: 'needs-recovery' }

      let downloaded = 0
      let cursor = this.deps.settings.getCursor()
      for (;;) {
        const page = await this.deps.worker.pull(token, cursor)
        for (const item of page.items) {
          if (this.applyRemote(accountId, vaultKey, item)) downloaded++
        }
        cursor = page.nextCursor
        this.deps.settings.setCursor(cursor)
        if (!page.hasMore) break
      }

      const uploaded = await this.pushLocal(token, accountId, vaultKey)
      return { kind: 'ok', uploaded, downloaded }
    } catch (error) {
      if (error instanceof WorkerError && error.code === 'SYNC_CONFLICT') {
        // The push path already reconciled server-wins; a second pass converges.
        return { kind: 'reconciled' }
      }
      return {
        kind: 'error',
        message: error instanceof Error ? error.message : 'Sync failed'
      }
    }
  }

  private applyRemote(accountId: string, vaultKey: Buffer, item: RemoteSyncItem): boolean {
    if (item.deleted) {
      this.deps.db.applyTombstone(item.type, item.id)
      return true
    }
    if (item.keyVersion !== KEY_VERSION || item.nonce === null || item.ciphertext === null) return false
    const plaintext = this.decryptJson(vaultKey, item, accountId)
    if (plaintext === null) return false
    if (item.type === 'history') {
      this.deps.db.upsertRemoteHistory(
        {
          requestId: item.id,
          finalText: String(plaintext.text),
          createdAtMs: Number(plaintext.createdAtMs),
          zoneId: String(plaintext.zoneId),
          wordCount: Number(plaintext.wordCount),
          audioDurationMs: Number(plaintext.audioDurationMs),
          asrModel: String(plaintext.asrModel ?? ''),
          polished: Boolean(plaintext.polished),
          asrMs: Number(plaintext.asrMs ?? 0),
          polishMs: Number(plaintext.polishMs ?? 0),
          totalMs: Number(plaintext.totalMs ?? 0)
        },
        item.version
      )
      return true
    }
    if (item.type === 'dictionary') {
      this.deps.db.upsertRemoteDictionary(
        {
          term: String(plaintext.term),
          normalizedTerm: String(plaintext.normalizedTerm),
          status: String(plaintext.status ?? 'confirmed'),
          source: String(plaintext.source ?? 'manual'),
          createdAtMs: Number(plaintext.createdAtMs),
          lastUsedAtMs: Number(plaintext.lastUsedAtMs),
          useCount: Number(plaintext.useCount ?? 0)
        },
        item.id,
        item.version
      )
      return true
    }
    return false // analytics stay phone-side in this desktop version
  }

  private decryptJson(
    vaultKey: Buffer,
    item: RemoteSyncItem,
    accountId: string
  ): Record<string, unknown> | null {
    const { decryptRecord } = require('./vault-crypto') as typeof import('./vault-crypto')
    const plaintext = decryptRecord(
      vaultKey,
      { nonce: item.nonce ?? '', ciphertext: item.ciphertext ?? '' },
      accountId,
      item.type,
      item.id,
      item.keyVersion,
      SCHEMA_VERSION
    )
    if (plaintext === null) return null
    try {
      return JSON.parse(plaintext.toString('utf-8')) as Record<string, unknown>
    } catch {
      return null
    }
  }

  private async pushLocal(token: string, accountId: string, vaultKey: Buffer): Promise<number> {
    const items: Array<{
      id: string
      type: 'history' | 'dictionary'
      baseVersion: number
      keyVersion: number
      nonce: string
      ciphertext: string
      deleted: boolean
    }> = []

    for (const tombstone of this.deps.db.tombstones()) {
      items.push({
        id: tombstone.recordId,
        type: tombstone.recordType as 'history' | 'dictionary',
        baseVersion: tombstone.baseVersion,
        keyVersion: KEY_VERSION,
        nonce: '',
        ciphertext: '',
        deleted: true
      })
    }

    for (const record of this.deps.db.historyNeedingSync()) {
      const offsetSeconds = -new Date().getTimezoneOffset() * 60
      const sealed = encryptRecord(
        vaultKey,
        Buffer.from(
          JSON.stringify({
            schemaVersion: SCHEMA_VERSION,
            text: record.finalText,
            createdAtMs: record.createdAtMs,
            zoneId: record.zoneId,
            offsetSeconds,
            wordCount: record.wordCount,
            audioDurationMs: record.audioDurationMs,
            asrModel: record.asrModel,
            polished: record.polished,
            asrMs: record.asrMs,
            polishMs: record.polishMs,
            totalMs: record.totalMs
          })
        ),
        accountId,
        'history',
        record.requestId,
        KEY_VERSION,
        SCHEMA_VERSION
      )
      items.push({
        id: record.requestId,
        type: 'history',
        baseVersion: 0,
        keyVersion: KEY_VERSION,
        nonce: sealed.nonce,
        ciphertext: sealed.ciphertext,
        deleted: false
      })
    }

    for (const entry of this.deps.db.dictionaryNeedingSync()) {
      const sealed = encryptRecord(
        vaultKey,
        Buffer.from(
          JSON.stringify({
            schemaVersion: SCHEMA_VERSION,
            term: entry.term,
            normalizedTerm: entry.normalizedTerm,
            status: entry.status,
            source: entry.source,
            createdAtMs: entry.createdAtMs,
            lastUsedAtMs: entry.lastUsedAtMs,
            useCount: entry.useCount
          })
        ),
        accountId,
        'dictionary',
        entry.syncId,
        KEY_VERSION,
        SCHEMA_VERSION
      )
      items.push({
        id: entry.syncId,
        type: 'dictionary',
        baseVersion: 0,
        keyVersion: KEY_VERSION,
        nonce: sealed.nonce,
        ciphertext: sealed.ciphertext,
        deleted: false
      })
    }

    if (items.length === 0) return 0

    try {
      const result = await this.deps.worker.push(token, items.slice(0, MAX_BATCH))
      for (const applied of result.applied) {
        if (applied.type === 'history') this.deps.db.markHistorySynced(applied.id, applied.version)
        else if (applied.type === 'dictionary') this.deps.db.markDictionarySynced(applied.id, applied.version)
        this.deps.db.clearTombstone(applied.type, applied.id)
      }
      // Tombstoned history rows leave the local list once their tombstone lands.
      for (const tombstone of this.deps.db.tombstones()) {
        if (tombstone.recordType === 'history') continue
      }
      for (const item of items) {
        if (!item.deleted || item.type !== 'history') continue
        if (this.deps.db.historyByRequestId(item.id) === null) continue
        const stillPending = this.deps.db
          .tombstones()
          .some((t) => t.recordType === 'history' && t.recordId === item.id)
        if (!stillPending) this.deps.db.hardDeleteHistory(item.id)
      }
      return result.applied.length
    } catch (error) {
      if (error instanceof WorkerError && error.code === 'SYNC_CONFLICT' && error.conflicts.length > 0) {
        for (const conflict of error.conflicts) {
          if (conflict.deleted) {
            this.deps.db.applyTombstone(conflict.type, conflict.id)
          } else if (conflict.nonce !== null && conflict.ciphertext !== null) {
            const plaintext = this.decryptJson(vaultKey, conflict, accountId)
            if (plaintext !== null && conflict.type === 'history') {
              this.deps.db.upsertRemoteHistory(
                {
                  requestId: conflict.id,
                  finalText: String(plaintext.text),
                  createdAtMs: Number(plaintext.createdAtMs),
                  zoneId: String(plaintext.zoneId),
                  wordCount: Number(plaintext.wordCount),
                  audioDurationMs: Number(plaintext.audioDurationMs),
                  asrModel: String(plaintext.asrModel ?? ''),
                  polished: Boolean(plaintext.polished),
                  asrMs: Number(plaintext.asrMs ?? 0),
                  polishMs: Number(plaintext.polishMs ?? 0),
                  totalMs: Number(plaintext.totalMs ?? 0)
                },
                conflict.version
              )
            } else if (plaintext !== null && conflict.type === 'dictionary') {
              this.deps.db.upsertRemoteDictionary(
                {
                  term: String(plaintext.term),
                  normalizedTerm: String(plaintext.normalizedTerm),
                  status: String(plaintext.status ?? 'confirmed'),
                  source: String(plaintext.source ?? 'manual'),
                  createdAtMs: Number(plaintext.createdAtMs),
                  lastUsedAtMs: Number(plaintext.lastUsedAtMs),
                  useCount: Number(plaintext.useCount ?? 0)
                },
                conflict.id,
                conflict.version
              )
            }
          }
          this.deps.db.clearTombstone(conflict.type, conflict.id)
        }
        throw error // surfaced as 'reconciled' by run()
      }
      throw error
    }
  }

  private seal(name: string, secret: Buffer): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Keychain encryption is unavailable; refusing to store vault material in plaintext.')
    }
    writeFileSync(join(this.deps.vaultDir, name), safeStorage.encryptString(secret.toString('base64')))
  }

  private loadSealed(name: string): Buffer | null {
    try {
      const sealed = readFileSync(join(this.deps.vaultDir, name))
      if (sealed.length === 0 || !safeStorage.isEncryptionAvailable()) return null
      return Buffer.from(safeStorage.decryptString(sealed), 'base64')
    } catch {
      return null
    }
  }
}

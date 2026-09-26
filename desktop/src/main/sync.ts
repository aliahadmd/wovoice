import { safeStorage } from 'electron'
import { readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import {
  WorkerError,
  type CloudRecord,
  type CloudSettings,
  type CloudWrite,
  type WorkerClient
} from './worker'
import { decryptRecord, unwrapVaultKey } from './vault-crypto'
import type { DictationRecord, WoVoiceDb } from './db'

const SCHEMA_VERSION = 1
const MAX_BATCH = 100
// Up to 2,000 uploads per sync; anything beyond waits for the next one.
const MAX_PUSH_ROUNDS = 20
const MAX_CONFLICT_ROUNDS = 3
const DAY_MS = 86_400_000

export type SyncOutcome =
  | { kind: 'ok'; uploaded: number; downloaded: number; warning?: string }
  | { kind: 'error'; message: string }

/** Where the sync engine keeps its per-account state (settings.json in the app). */
export interface SyncState {
  workerUrl: string
  getAccountId: () => string | null
  getCursor: () => number
  setCursor: (value: number) => void
  getMigratedAccount: () => string | null
  setMigratedAccount: (accountId: string) => void
  getHistorySyncEnabled: () => boolean
  setHistorySyncEnabled: (value: boolean) => void
  getRetentionDays: () => number | null
  setRetentionDays: (value: number | null) => void
  setLastSyncAt: (value: number) => void
}

/** Keychain-sealed files left by the old recovery-key vault (injectable for tests). */
export interface SecretFiles {
  load(name: string): Buffer | null
  remove(name: string): void
}

type SyncWorker = Pick<
  WorkerClient,
  | 'pullRecords'
  | 'pushRecords'
  | 'updateSyncSettings'
  | 'completeLegacyMigration'
  | 'getVault'
  | 'pullLegacy'
>

interface Batch {
  writes: CloudWrite[]
  tombstones: Set<string>
}

/**
 * Cloud sync, mirroring the phone's SyncCoordinator: history and dictionary
 * follow the signed-in account. Records travel as plain JSON over TLS and the
 * Worker encrypts them with the account's key, so there is no vault or recovery
 * key. Conflicts resolve server-wins, except that a delete or an undo made on
 * this Mac is re-based onto the server version so the user's action still lands.
 */
export class SyncService {
  private syncing: Promise<SyncOutcome> | null = null
  private readonly secrets: SecretFiles

  constructor(
    private readonly deps: {
      worker: SyncWorker
      settings: SyncState
      db: WoVoiceDb
      getToken: () => Promise<string>
      invalidateToken?: (token: string) => void
      vaultDir: string
      secrets?: SecretFiles
      now?: () => number
    }
  ) {
    this.secrets = deps.secrets ?? keychainSecretFiles(deps.vaultDir)
  }

  /** Single-flight: concurrent callers share the sync already running. */
  async syncNow(): Promise<SyncOutcome> {
    if (this.syncing === null) {
      this.syncing = this.run().finally(() => {
        this.syncing = null
      })
    }
    return this.syncing
  }

  /** Changes the account's history choices; turning history off deletes its cloud copy. */
  async updateSettings(changes: {
    historySyncEnabled?: boolean
    historyRetentionDays?: number | null
  }): Promise<CloudSettings> {
    while (this.syncing !== null) await this.syncing
    const settings = await this.call((token) => this.deps.worker.updateSyncSettings(token, changes))
    this.applySettings(settings)
    return settings
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private accountId(): string {
    const id = this.deps.settings.getAccountId()
    if (id === null) throw new WorkerError('AUTH_REQUIRED', 'Sign in first.', false, 401)
    return id
  }

  /** Runs a Worker call; a token the server rejects as expired is refreshed once. */
  private async call<T>(request: (token: string) => Promise<T>): Promise<T> {
    const token = await this.deps.getToken()
    try {
      return await request(token)
    } catch (error) {
      if (!(error instanceof WorkerError) || error.code !== 'TOKEN_EXPIRED') throw error
      this.deps.invalidateToken?.(token)
      return request(await this.deps.getToken())
    }
  }

  private async run(): Promise<SyncOutcome> {
    try {
      const accountId = this.accountId()
      if (this.deps.settings.getMigratedAccount() !== accountId) {
        await this.importLegacyVault(accountId)
      }
      const downloaded = await this.pull()
      const outcome = await this.push()
      this.deps.settings.setLastSyncAt(this.now())
      return outcome.warning === undefined
        ? { kind: 'ok', uploaded: outcome.uploaded, downloaded }
        : { kind: 'ok', uploaded: outcome.uploaded, downloaded, warning: outcome.warning }
    } catch (error) {
      return { kind: 'error', message: error instanceof Error ? error.message : 'Sync failed' }
    }
  }

  // ---- Downloads ----

  private async pull(): Promise<number> {
    let downloaded = 0
    for (;;) {
      const cursor = this.deps.settings.getCursor()
      const page = await this.call((token) => this.deps.worker.pullRecords(token, cursor))
      // Settings arrive before any upload, so a history-off choice made on
      // another device is honoured before this Mac sends history.
      if (page.settings) this.applySettings(page.settings)
      for (const record of page.items) {
        // One record that cannot be applied must not stall the feed.
        try {
          if (this.applyRecord(record)) downloaded++
        } catch (error) {
          console.error('[sync] skipped record', record.type, record.id, error)
        }
      }
      this.deps.settings.setCursor(page.nextCursor)
      if (!page.hasMore) return downloaded
    }
  }

  private applyRecord(record: CloudRecord): boolean {
    if (record.type === 'analytics') return false // analytics stay on the phone
    const db = this.deps.db
    // A delete made here and not yet uploaded outranks incoming content.
    if (!record.deleted && db.hasPendingTombstone(record.type, record.id)) return false
    // This Mac's own writes echo back on the next pull: the version it already
    // holds is not news. A lower remote version is (the account was reset).
    const known = db.knownSyncVersion(record.type, record.id)
    if (known !== null && known === record.version) return false
    if (record.deleted) {
      if (known === null) return false
      db.applyTombstone(record.type, record.id)
      return true
    }
    if (record.payload === null) return false
    if (record.type === 'history') {
      if (!this.deps.settings.getHistorySyncEnabled()) return false
      db.upsertRemoteHistory(historyFromJson(record.id, record.payload), record.version)
    } else {
      db.upsertRemoteDictionary(dictionaryFromJson(record.payload), record.id, record.version)
    }
    return true
  }

  // ---- Uploads ----

  private async push(): Promise<{ uploaded: number; warning?: string }> {
    let uploaded = 0
    let conflictRounds = 0
    let skipNewTerms = false
    let warning: string | undefined
    for (let round = 0; round < MAX_PUSH_ROUNDS; round++) {
      const batch = this.stageBatch(skipNewTerms)
      if (batch.writes.length === 0) break
      try {
        const result = await this.call((token) => this.deps.worker.pushRecords(token, batch.writes))
        for (const applied of result.applied) this.settle(batch, applied)
        uploaded += result.applied.length
      } catch (error) {
        if (!(error instanceof WorkerError)) throw error
        if (error.code === 'SYNC_CONFLICT' && error.conflicts.length > 0) {
          if (++conflictRounds > MAX_CONFLICT_ROUNDS) {
            throw new Error('Changes from another device were merged. Sync again to finish.')
          }
          for (const conflict of error.conflicts) this.reconcile(conflict, batch)
        } else if (error.code === 'STORAGE_LIMIT_REACHED') {
          // The dictionary is full: keep syncing everything else.
          skipNewTerms = true
          warning = error.message
        } else if (error.code === 'HISTORY_SYNC_DISABLED') {
          this.applyHistorySyncDisabled()
        } else {
          throw error
        }
      }
    }
    return { uploaded, warning }
  }

  private stageBatch(skipNewTerms: boolean): Batch {
    const db = this.deps.db
    const historyOn = this.deps.settings.getHistorySyncEnabled()
    const writes: CloudWrite[] = []
    const keys = new Set<string>()
    const tombstones = new Set<string>()
    const add = (write: CloudWrite): void => {
      // The server refuses a batch that names the same record twice.
      const key = `${write.type}:${write.id}`
      if (keys.has(key) || writes.length >= MAX_BATCH) return
      keys.add(key)
      writes.push(write)
      if (write.payload === null) tombstones.add(key)
    }

    for (const tombstone of db.tombstones()) {
      const type = tombstone.recordType as 'history' | 'dictionary'
      if (type === 'history' && !historyOn) {
        // The account keeps no history in the cloud; there is nothing to delete.
        db.clearTombstone(type, tombstone.recordId)
        continue
      }
      add({ id: tombstone.recordId, type, baseVersion: tombstone.baseVersion, payload: null })
    }
    if (historyOn) {
      for (const record of db.historyNeedingSync()) {
        // baseVersion: 0 for a new dictation; the server version after an undo.
        add({ id: record.requestId, type: 'history', baseVersion: record.syncVersion, payload: historyJson(record) })
      }
    }
    for (const entry of db.dictionaryNeedingSync()) {
      if (skipNewTerms && entry.syncVersion === 0) continue
      add({
        id: entry.syncId,
        type: 'dictionary',
        baseVersion: entry.syncVersion,
        payload: {
          schemaVersion: SCHEMA_VERSION,
          term: entry.term,
          normalizedTerm: entry.normalizedTerm,
          status: entry.status,
          source: entry.source,
          createdAtMs: entry.createdAtMs,
          lastUsedAtMs: entry.lastUsedAtMs,
          useCount: entry.useCount
        }
      })
    }
    return { writes, tombstones }
  }

  private settle(batch: Batch, applied: { id: string; type: string; version: number }): void {
    const db = this.deps.db
    const type = applied.type === 'dictionary' ? 'dictionary' : 'history'
    if (!batch.tombstones.has(`${type}:${applied.id}`)) {
      if (type === 'history') db.markHistorySynced(applied.id, applied.version)
      else db.markDictionarySynced(applied.id, applied.version)
      return
    }
    db.clearTombstone(type, applied.id)
    if (type !== 'history') return
    // The deletion landed. A row still marked deleted leaves the list; a row
    // restored (undo) while the upload was in flight is re-queued on top of it.
    const deleted = db.isHistoryDeleted(applied.id)
    if (deleted === true) db.hardDeleteHistory(applied.id)
    else if (deleted === false) db.rebaseHistory(applied.id, applied.version)
  }

  /** Resolves one refused write against the server's current copy of the record. */
  private reconcile(remote: CloudRecord, batch: Batch): void {
    if (remote.type === 'analytics') return
    const db = this.deps.db
    const type = remote.type
    const remoteExists = remote.version > 0
    if (batch.tombstones.has(`${type}:${remote.id}`)) {
      if (remoteExists && !remote.deleted) {
        // The user deleted it here: re-base the deletion so it still lands.
        db.queueTombstone(type, remote.id, remote.version)
        return
      }
      db.clearTombstone(type, remote.id)
      if (type === 'history') db.hardDeleteHistory(remote.id)
      return
    }
    if (!remoteExists) {
      // The server has no copy: upload again as a new record.
      if (type === 'history') db.rebaseHistory(remote.id, 0)
      else db.rebaseDictionary(remote.id, 0)
      return
    }
    if (remote.deleted) {
      // A local write against a server deletion is an undo made here: keep it.
      if (type === 'history') db.rebaseHistory(remote.id, remote.version)
      else db.applyTombstone(type, remote.id)
      return
    }
    if (remote.payload === null) return
    if (type === 'history') {
      db.upsertRemoteHistory(historyFromJson(remote.id, remote.payload), remote.version)
    } else {
      db.upsertRemoteDictionary(dictionaryFromJson(remote.payload), remote.id, remote.version)
    }
  }

  // ---- Settings ----

  private applySettings(settings: CloudSettings): void {
    const state = this.deps.settings
    if (state.getHistorySyncEnabled() && !settings.historySyncEnabled) this.applyHistorySyncDisabled()
    state.setHistorySyncEnabled(settings.historySyncEnabled)
    state.setRetentionDays(settings.historyRetentionDays)
    // The server deletes expired cloud history itself; this covers copies that
    // were never uploaded (or when history sync is off).
    if (settings.historyRetentionDays !== null) {
      this.deps.db.deleteHistoryBefore(this.now() - settings.historyRetentionDays * DAY_MS)
    }
  }

  private applyHistorySyncDisabled(): void {
    this.deps.settings.setHistorySyncEnabled(false)
    // The cloud copy is gone; mark local history unsynced so turning the setting
    // back on uploads it again.
    this.deps.db.markHistoryUnsynced()
  }

  // ---- One-time import of the old recovery-key vault ----

  /**
   * Moves this Mac onto cloud sync once per account. When it still holds the old
   * vault key, the vault's records are merged into local data first (the only
   * copy of records from devices that are gone), the server is told so it can
   * retire the vault, and the key files are deleted. Every local record is then
   * uploaded fresh, since the cloud starts empty.
   */
  private async importLegacyVault(accountId: string): Promise<void> {
    const vaultKey = this.secrets.load('vault-key.bin')
    const recovery = this.secrets.load('recovery-secret.bin')
    let imported = false
    if (vaultKey !== null && recovery !== null) {
      try {
        const remote = await this.call((token) => this.deps.worker.getVault(token))
        const unwrapped = remote === null ? null : unwrapVaultKey(remote, recovery, accountId)
        if (unwrapped !== null && unwrapped.equals(vaultKey)) {
          let cursor = 0
          for (;;) {
            const from = cursor
            const page = await this.call((token) => this.deps.worker.pullLegacy(token, from))
            for (const record of page.items) {
              try {
                this.importLegacyRecord(accountId, vaultKey, record)
              } catch (error) {
                console.error('[sync] skipped vault record', record.type, record.id, error)
              }
            }
            cursor = page.nextCursor
            if (!page.hasMore) break
          }
          imported = true
        }
      } catch (error) {
        // Another device already moved this account and the vault is closed.
        if (!(error instanceof WorkerError) || error.code !== 'UPGRADE_REQUIRED') throw error
      }
    }
    if (imported) await this.call((token) => this.deps.worker.completeLegacyMigration(token))
    this.deps.db.resetSyncState()
    this.deps.settings.setCursor(0)
    this.secrets.remove('vault-key.bin')
    this.secrets.remove('recovery-secret.bin')
    this.deps.settings.setMigratedAccount(accountId)
  }

  private importLegacyRecord(
    accountId: string,
    vaultKey: Buffer,
    record: {
      id: string
      type: string
      keyVersion: number
      nonce: string | null
      ciphertext: string | null
      deleted: boolean
    }
  ): void {
    const db = this.deps.db
    if (record.type !== 'history' && record.type !== 'dictionary') return
    if (record.deleted) {
      db.applyTombstone(record.type, record.id)
      return
    }
    if (record.nonce === null || record.ciphertext === null) return
    const plaintext = decryptRecord(
      vaultKey,
      { nonce: record.nonce, ciphertext: record.ciphertext },
      accountId,
      record.type,
      record.id,
      record.keyVersion,
      SCHEMA_VERSION
    )
    if (plaintext === null) return
    const json = JSON.parse(plaintext.toString('utf-8')) as Record<string, unknown>
    // Local copies win: they are at least as new as anything in the vault.
    if (record.type === 'history') {
      if (db.historyByRequestId(record.id) === null) {
        db.upsertRemoteHistory(historyFromJson(record.id, json), 0)
      }
    } else if (db.dictionaryBySyncId(record.id) === null) {
      db.upsertRemoteDictionary(dictionaryFromJson(json), record.id, 0)
    }
  }
}

function historyJson(record: DictationRecord): Record<string, unknown> {
  return {
    schemaVersion: SCHEMA_VERSION,
    text: record.finalText,
    createdAtMs: record.createdAtMs,
    zoneId: record.zoneId,
    offsetSeconds: -new Date(record.createdAtMs).getTimezoneOffset() * 60,
    wordCount: record.wordCount,
    audioDurationMs: record.audioDurationMs,
    asrModel: record.asrModel,
    polished: record.polished,
    asrMs: record.asrMs,
    polishMs: record.polishMs,
    totalMs: record.totalMs
  }
}

function historyFromJson(
  requestId: string,
  plaintext: Record<string, unknown>
): Omit<DictationRecord, 'deleted'> {
  return {
    requestId,
    finalText: String(plaintext.text),
    createdAtMs: Number(plaintext.createdAtMs),
    zoneId: String(plaintext.zoneId ?? 'UTC'),
    wordCount: Number(plaintext.wordCount ?? 0),
    audioDurationMs: Number(plaintext.audioDurationMs ?? 0),
    asrModel: String(plaintext.asrModel ?? ''),
    polished: Boolean(plaintext.polished),
    asrMs: Number(plaintext.asrMs ?? 0),
    polishMs: Number(plaintext.polishMs ?? 0),
    totalMs: Number(plaintext.totalMs ?? 0)
  }
}

function dictionaryFromJson(plaintext: Record<string, unknown>): {
  term: string
  normalizedTerm: string
  status: string
  source: string
  createdAtMs: number
  lastUsedAtMs: number
  useCount: number
} {
  return {
    term: String(plaintext.term),
    normalizedTerm: String(plaintext.normalizedTerm),
    status: String(plaintext.status ?? 'confirmed'),
    source: String(plaintext.source ?? 'manual'),
    createdAtMs: Number(plaintext.createdAtMs ?? 0),
    lastUsedAtMs: Number(plaintext.lastUsedAtMs ?? 0),
    useCount: Number(plaintext.useCount ?? 0)
  }
}

function keychainSecretFiles(dir: string): SecretFiles {
  return {
    load(name): Buffer | null {
      try {
        const sealed = readFileSync(join(dir, name))
        if (sealed.length === 0 || !safeStorage.isEncryptionAvailable()) return null
        return Buffer.from(safeStorage.decryptString(sealed), 'base64')
      } catch {
        return null
      }
    },
    remove(name): void {
      try {
        unlinkSync(join(dir, name))
      } catch {
        // absent — nothing to remove
      }
    }
  }
}

import { strict as assert } from 'node:assert'
import { beforeEach, describe, test } from 'node:test'
import { openDatabase, type DictationRecord, type WoVoiceDb } from '../src/main/db'
import { SyncService, type SecretFiles, type SyncState } from '../src/main/sync'
import { encryptRecord, newSecret, wrapVaultKey } from '../src/main/vault-crypto'
import {
  WorkerError,
  type CloudRecord,
  type CloudSettings,
  type CloudWrite,
  type LegacyPage,
  type RemoteVault
} from '../src/main/worker'

const ACCOUNT = 'acct-1'

/** In-memory stand-in for the Worker's /v2/sync routes (same version rules). */
class FakeCloud {
  records = new Map<string, CloudRecord>()
  private feed = new Map<string, number>()
  private seq = 0
  settings: CloudSettings = { historySyncEnabled: true, historyRetentionDays: null, legacyVault: false }
  dictionaryLimit = 1_000
  dropNextPushResponse = false
  afterPushApplied: (() => void) | null = null
  legacyVault: RemoteVault | null = null
  legacyItems: LegacyPage['items'] = []
  legacyMigrated = false

  write(record: CloudRecord): void {
    const key = `${record.type}:${record.id}`
    this.records.set(key, record)
    this.feed.delete(key)
    this.feed.set(key, ++this.seq)
  }

  readonly worker = {
    pullRecords: async (_token: string, cursor: number) => {
      const page = [...this.feed.entries()].filter(([, seq]) => seq > cursor).slice(0, 50)
      return {
        nextCursor: page.reduce((latest, [, seq]) => Math.max(latest, seq), cursor),
        hasMore: page.length === 50,
        items: page.map(([key]) => structuredClone(this.records.get(key)!)),
        settings: { ...this.settings }
      }
    },
    pushRecords: async (_token: string, writes: CloudWrite[]) => {
      const keys = writes.map((write) => `${write.type}:${write.id}`)
      assert.equal(new Set(keys).size, keys.length, 'client pushed the same record twice')
      if (
        !this.settings.historySyncEnabled &&
        writes.some((write) => write.type === 'history' && write.payload !== null)
      ) {
        throw new WorkerError('HISTORY_SYNC_DISABLED', 'History sync is off.', false, 409)
      }
      const conflicts = writes
        .filter(
          (write) =>
            (this.records.get(`${write.type}:${write.id}`)?.version ?? 0) !== write.baseVersion
        )
        .map(
          (write) =>
            structuredClone(this.records.get(`${write.type}:${write.id}`)) ?? {
              id: write.id,
              type: write.type,
              version: 0,
              deleted: false,
              payload: null
            }
        )
      if (conflicts.length > 0) {
        throw new WorkerError('SYNC_CONFLICT', 'conflict', false, 409, conflicts)
      }
      const newTerms = writes.filter(
        (write) =>
          write.type === 'dictionary' &&
          write.payload !== null &&
          !this.records.has(`dictionary:${write.id}`)
      ).length
      const liveTerms = [...this.records.values()].filter(
        (value) => value.type === 'dictionary' && !value.deleted
      ).length
      if (newTerms > 0 && liveTerms + newTerms > this.dictionaryLimit) {
        throw new WorkerError('STORAGE_LIMIT_REACHED', 'Your dictionary is full.', false, 413)
      }
      const applied = writes.map((write) => {
        const value: CloudRecord = {
          id: write.id,
          type: write.type,
          version: write.baseVersion + 1,
          deleted: write.payload === null,
          payload: write.payload === null ? null : structuredClone(write.payload)
        }
        this.write(value)
        return { id: value.id, type: value.type, version: value.version }
      })
      this.afterPushApplied?.()
      this.afterPushApplied = null
      if (this.dropNextPushResponse) {
        this.dropNextPushResponse = false
        throw new WorkerError('NETWORK_UNAVAILABLE', 'Could not reach WoVoice.', true, 0)
      }
      return { applied }
    },
    updateSyncSettings: async (
      _token: string,
      changes: { historySyncEnabled?: boolean; historyRetentionDays?: number | null }
    ) => {
      if (changes.historySyncEnabled === false && this.settings.historySyncEnabled) {
        for (const key of [...this.records.keys()].filter((k) => k.startsWith('history:'))) {
          this.records.delete(key)
          this.feed.delete(key)
        }
      }
      if (changes.historySyncEnabled !== undefined) {
        this.settings.historySyncEnabled = changes.historySyncEnabled
      }
      if (changes.historyRetentionDays !== undefined) {
        this.settings.historyRetentionDays = changes.historyRetentionDays
      }
      return { ...this.settings }
    },
    completeLegacyMigration: async () => {
      this.legacyMigrated = true
    },
    getVault: async () => {
      if (this.legacyMigrated) throw new WorkerError('UPGRADE_REQUIRED', 'Update WoVoice.', false, 426)
      return this.legacyVault
    },
    pullLegacy: async (_token: string, cursor: number): Promise<LegacyPage> => ({
      nextCursor: this.legacyItems.length,
      hasMore: false,
      items: cursor === 0 ? this.legacyItems : []
    })
  }
}

interface Device {
  db: WoVoiceDb
  sync: SyncService
  state: SyncState & { values: Record<string, unknown> }
  secrets: SecretFiles & { values: Map<string, Buffer> }
}

function device(cloud: FakeCloud): Device {
  const values: Record<string, unknown> = { cursor: 0, historySyncEnabled: true, retention: null }
  const state = {
    values,
    workerUrl: 'https://wovoice.test',
    getAccountId: () => ACCOUNT,
    getCursor: () => values.cursor as number,
    setCursor: (value: number) => void (values.cursor = value),
    getMigratedAccount: () => (values.migrated as string | undefined) ?? null,
    setMigratedAccount: (value: string) => void (values.migrated = value),
    getHistorySyncEnabled: () => values.historySyncEnabled as boolean,
    setHistorySyncEnabled: (value: boolean) => void (values.historySyncEnabled = value),
    getRetentionDays: () => values.retention as number | null,
    setRetentionDays: (value: number | null) => void (values.retention = value),
    setLastSyncAt: (value: number) => void (values.lastSyncAt = value)
  }
  const secretValues = new Map<string, Buffer>()
  const secrets = {
    values: secretValues,
    load: (name: string) => secretValues.get(name) ?? null,
    remove: (name: string) => void secretValues.delete(name)
  }
  const db = openDatabase(':memory:')
  const sync = new SyncService({
    worker: cloud.worker as never,
    settings: state,
    db,
    getToken: async () => 'token',
    vaultDir: '/unused',
    secrets
  })
  return { db, sync, state, secrets }
}

function record(requestId: string, text = 'Hello from the Mac.', createdAtMs = Date.now()): DictationRecord {
  return {
    requestId,
    finalText: text,
    createdAtMs,
    zoneId: 'UTC',
    wordCount: 4,
    audioDurationMs: 2_000,
    asrModel: 'whisper-large-v3-turbo',
    polished: true,
    asrMs: 10,
    polishMs: 20,
    totalMs: 30,
    deleted: false
  }
}

function remoteTerm(cloud: FakeCloud, id: string, term: string): void {
  const current = cloud.records.get(`dictionary:${id}`)?.version ?? 0
  cloud.write({
    id,
    type: 'dictionary',
    version: current + 1,
    deleted: false,
    payload: {
      term,
      normalizedTerm: term.toLowerCase(),
      status: 'confirmed',
      source: 'manual',
      createdAtMs: 1
    }
  })
}

const historyInCloud = (cloud: FakeCloud): number =>
  [...cloud.records.keys()].filter((key) => key.startsWith('history:')).length

describe('cloud sync', () => {
  let cloud: FakeCloud
  let mac: Device

  beforeEach(() => {
    cloud = new FakeCloud()
    mac = device(cloud)
  })

  test('history and dictionary follow the account to another device', async () => {
    mac.db.insertRecord(record('r1', 'Meet Rahim at the clinic.'))
    mac.db.addTerm('Rahim')
    assert.deepEqual(await mac.sync.syncNow(), { kind: 'ok', uploaded: 2, downloaded: 0 })
    const other = device(cloud)
    assert.deepEqual(await other.sync.syncNow(), { kind: 'ok', uploaded: 0, downloaded: 2 })
    assert.deepEqual(
      other.db.historySearch('').map((value) => value.finalText),
      ['Meet Rahim at the clinic.']
    )
    assert.deepEqual(
      other.db.listTerms('').map((value) => value.term),
      ['Rahim']
    )
    assert.deepEqual(await mac.sync.syncNow(), { kind: 'ok', uploaded: 0, downloaded: 0 })
  })

  test('an upload whose response was lost converges', async () => {
    mac.db.insertRecord(record('r1'))
    cloud.dropNextPushResponse = true
    assert.equal((await mac.sync.syncNow()).kind, 'error')
    assert.deepEqual(await mac.sync.syncNow(), { kind: 'ok', uploaded: 0, downloaded: 1 })
    mac.db.insertRecord(record('r2'))
    assert.deepEqual(await mac.sync.syncNow(), { kind: 'ok', uploaded: 1, downloaded: 0 })
    assert.equal(mac.db.historyNeedingSync().length, 0)
  })

  test('undo before the deletion syncs keeps the record everywhere', async () => {
    mac.db.insertRecord(record('r1'))
    await mac.sync.syncNow()
    mac.db.deleteRecord('r1')
    assert.equal(mac.db.restoreRecord('r1'), true)
    await mac.sync.syncNow()
    assert.equal(cloud.records.get('history:r1')?.deleted, false)
    assert.equal(mac.db.historySearch('').length, 1)
  })

  test('undo while the deletion is uploading re-sends the record on top of it', async () => {
    mac.db.insertRecord(record('r1'))
    await mac.sync.syncNow()
    mac.db.deleteRecord('r1')
    cloud.afterPushApplied = () => assert.equal(mac.db.restoreRecord('r1'), true)
    await mac.sync.syncNow()
    await mac.sync.syncNow()
    assert.equal(cloud.records.get('history:r1')?.deleted, false)
    assert.equal(mac.db.historySearch('').length, 1)
  })

  test('undo after the deletion synced reports that it is too late', async () => {
    mac.db.insertRecord(record('r1'))
    await mac.sync.syncNow()
    mac.db.deleteRecord('r1')
    await mac.sync.syncNow()
    assert.equal(mac.db.restoreRecord('r1'), false)
  })

  test('a delete made while the record is uploading still lands', async () => {
    mac.db.insertRecord(record('r1'))
    cloud.afterPushApplied = () => mac.db.deleteRecord('r1')
    await mac.sync.syncNow()
    await mac.sync.syncNow()
    assert.equal(cloud.records.get('history:r1')?.deleted, true)
    assert.equal(mac.db.historyByRequestId('r1'), null)
  })

  test('a term renamed on the phone updates the entry', async () => {
    remoteTerm(cloud, 'term-1', 'Kubernetes')
    await mac.sync.syncNow()
    remoteTerm(cloud, 'term-1', 'Kubernetes Engine')
    assert.deepEqual(await mac.sync.syncNow(), { kind: 'ok', uploaded: 0, downloaded: 1 })
    assert.deepEqual(
      mac.db.listTerms('').map((value) => value.term),
      ['Kubernetes Engine']
    )
  })

  test('a term deleted here beats a remote edit that raced it', async () => {
    remoteTerm(cloud, 'term-1', 'Kubernetes')
    await mac.sync.syncNow()
    mac.db.deleteTerm(mac.db.listTerms('')[0].id)
    remoteTerm(cloud, 'term-1', 'Kubernetes')
    assert.equal((await mac.sync.syncNow()).kind, 'ok')
    assert.equal(cloud.records.get('dictionary:term-1')?.deleted, true)
    assert.equal(mac.db.listTerms('').length, 0)
  })

  test('turning history sync off keeps local copies and stops uploads until it is back on', async () => {
    mac.db.insertRecord(record('r1'))
    await mac.sync.syncNow()
    const other = device(cloud)
    await other.sync.syncNow()
    await other.sync.updateSettings({ historySyncEnabled: false })
    assert.equal(historyInCloud(cloud), 0)
    await mac.sync.syncNow()
    mac.db.insertRecord(record('r2'))
    await mac.sync.syncNow()
    assert.equal(historyInCloud(cloud), 0)
    assert.equal(mac.db.historySearch('').length, 2)
    await other.sync.updateSettings({ historySyncEnabled: true })
    await mac.sync.syncNow()
    assert.equal(historyInCloud(cloud), 2)
  })

  test('retention removes old local history', async () => {
    mac.db.insertRecord(record('old', 'Old note.', Date.now() - 40 * 86_400_000))
    mac.db.insertRecord(record('new', 'New note.'))
    await mac.sync.updateSettings({ historyRetentionDays: 30 })
    assert.deepEqual(
      mac.db.historySearch('').map((value) => value.finalText),
      ['New note.']
    )
  })

  test('a full dictionary does not block history', async () => {
    cloud.dictionaryLimit = 0
    mac.db.addTerm('Rahim')
    mac.db.insertRecord(record('r1'))
    const outcome = await mac.sync.syncNow()
    assert.equal(outcome.kind === 'ok' && outcome.warning, 'Your dictionary is full.')
    assert.ok(cloud.records.has('history:r1'))
  })

  test('the old vault is imported once, then retired', async () => {
    const vaultKey = newSecret()
    const recovery = newSecret()
    cloud.legacyVault = wrapVaultKey(vaultKey, recovery, ACCOUNT, 1)
    const sealed = encryptRecord(
      vaultKey,
      Buffer.from(
        JSON.stringify({ schemaVersion: 1, text: 'Only in the vault.', createdAtMs: 1_790_000_000_000 })
      ),
      ACCOUNT,
      'history',
      'vault-only',
      1,
      1
    )
    cloud.legacyItems = [
      { id: 'vault-only', type: 'history', version: 3, keyVersion: 1, deleted: false, ...sealed }
    ]
    mac.secrets.values.set('vault-key.bin', vaultKey)
    mac.secrets.values.set('recovery-secret.bin', recovery)
    mac.db.insertRecord(record('r1'))
    assert.equal((await mac.sync.syncNow()).kind, 'ok')
    assert.equal(cloud.legacyMigrated, true)
    assert.equal(mac.secrets.values.size, 0)
    assert.equal(mac.state.values.migrated, ACCOUNT)
    assert.ok(cloud.records.has('history:vault-only'))
    assert.ok(cloud.records.has('history:r1'))
    // A second device without the key simply joins.
    const other = device(cloud)
    assert.deepEqual(await other.sync.syncNow(), { kind: 'ok', uploaded: 0, downloaded: 2 })
  })
})

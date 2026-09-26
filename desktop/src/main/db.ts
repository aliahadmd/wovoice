import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

/**
 * Local dictation database on Node's built-in SQLite. The schema mirrors the
 * phone's Room entities (same table and column names) so the E6 sync layer can
 * map records 1:1. Soft deletes leave tombstone-ready rows for sync.
 */

export interface DictationRecord {
  requestId: string
  finalText: string
  createdAtMs: number
  zoneId: string
  wordCount: number
  audioDurationMs: number
  asrModel: string
  polished: boolean
  asrMs: number
  polishMs: number
  totalMs: number
  deleted: boolean
}

export interface DictionaryEntry {
  id: number
  term: string
  normalizedTerm: string
  status: string
  source: string
  createdAtMs: number
  lastUsedAtMs: number
  useCount: number
}

export interface HomeStats {
  dictations: number
  audioDurationMs: number
  words: number
  recent: Array<Pick<DictationRecord, 'requestId' | 'finalText' | 'createdAtMs' | 'wordCount' | 'audioDurationMs'>>
}

export function openDatabase(path: string): WoVoiceDb {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA)
  migrate(db)
  return new WoVoiceDb(db)
}

/**
 * Brings tables created by earlier builds up to the current shape. SCHEMA only
 * runs CREATE TABLE IF NOT EXISTS, which never alters an existing table: the
 * dictionary table from the pre-sync build had no syncId, so on every upgraded
 * Mac each sync failed with "no such column: syncId" and adding a term threw.
 */
function migrate(db: DatabaseSync): void {
  const columns = (table: string): Set<string> =>
    new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )
  db.exec('BEGIN')
  try {
    const records = columns('dictation_records')
    if (!records.has('syncState')) {
      db.exec("ALTER TABLE dictation_records ADD COLUMN syncState TEXT NOT NULL DEFAULT 'local'")
    }
    if (!records.has('syncVersion')) {
      db.exec('ALTER TABLE dictation_records ADD COLUMN syncVersion INTEGER NOT NULL DEFAULT 0')
    }
    const dictionary = columns('dictionary_entries')
    if (!dictionary.has('syncState')) {
      db.exec("ALTER TABLE dictionary_entries ADD COLUMN syncState TEXT NOT NULL DEFAULT 'local'")
    }
    if (!dictionary.has('syncVersion')) {
      db.exec('ALTER TABLE dictionary_entries ADD COLUMN syncVersion INTEGER NOT NULL DEFAULT 0')
    }
    if (!dictionary.has('syncId')) {
      // ALTER TABLE cannot add a NOT NULL UNIQUE column: add it, give every
      // existing term an id, then enforce uniqueness with an index.
      db.exec('ALTER TABLE dictionary_entries ADD COLUMN syncId TEXT')
      const assign = db.prepare('UPDATE dictionary_entries SET syncId = ? WHERE id = ?')
      for (const row of db.prepare('SELECT id FROM dictionary_entries').all() as Array<{ id: number }>) {
        assign.run(randomUUID(), row.id)
      }
      db.exec('CREATE UNIQUE INDEX idx_dictionary_entries_sync_id ON dictionary_entries(syncId)')
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dictation_records (
  requestId TEXT PRIMARY KEY,
  finalText TEXT NOT NULL,
  createdAtMs INTEGER NOT NULL,
  zoneId TEXT NOT NULL,
  wordCount INTEGER NOT NULL,
  audioDurationMs INTEGER NOT NULL,
  asrModel TEXT NOT NULL,
  polished INTEGER NOT NULL,
  asrMs INTEGER NOT NULL DEFAULT 0,
  polishMs INTEGER NOT NULL DEFAULT 0,
  totalMs INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  syncState TEXT NOT NULL DEFAULT 'local',
  syncVersion INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_records_created
  ON dictation_records(createdAtMs DESC);
CREATE TABLE IF NOT EXISTS dictionary_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  term TEXT NOT NULL,
  normalizedTerm TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'confirmed',
  source TEXT NOT NULL DEFAULT 'manual',
  createdAtMs INTEGER NOT NULL,
  lastUsedAtMs INTEGER NOT NULL,
  useCount INTEGER NOT NULL DEFAULT 0,
  syncId TEXT NOT NULL UNIQUE,
  syncState TEXT NOT NULL DEFAULT 'local',
  syncVersion INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pending_tombstones (
  recordType TEXT NOT NULL,
  recordId TEXT NOT NULL,
  baseVersion INTEGER NOT NULL,
  createdAtMs INTEGER NOT NULL,
  PRIMARY KEY (recordType, recordId)
);
`

export class WoVoiceDb {
  constructor(private readonly db: DatabaseSync) {}

  insertRecord(record: DictationRecord): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO dictation_records
           (requestId, finalText, createdAtMs, zoneId, wordCount, audioDurationMs,
            asrModel, polished, asrMs, polishMs, totalMs)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.requestId,
        record.finalText,
        record.createdAtMs,
        record.zoneId,
        record.wordCount,
        record.audioDurationMs,
        record.asrModel,
        record.polished ? 1 : 0,
        record.asrMs,
        record.polishMs,
        record.totalMs
      )
  }

  historySearch(query: string): DictationRecord[] {
    const like = `%${escapeLike(query.trim())}%`
    const rows = this.db
      .prepare(
        `SELECT requestId, finalText, createdAtMs, zoneId, wordCount, audioDurationMs,
                asrModel, polished, asrMs, polishMs, totalMs
         FROM dictation_records
         WHERE deleted = 0 AND (:q = '' OR finalText LIKE :like ESCAPE '\\')
         ORDER BY createdAtMs DESC`
      )
      .all({ q: query.trim(), like })
    return rows.map(rowToRecord)
  }

  deleteRecord(requestId: string): void {
    const row = this.db
      .prepare('SELECT syncVersion FROM dictation_records WHERE requestId = ?')
      .get(requestId) as { syncVersion: number } | undefined
    if (row === undefined) return
    this.db.prepare('UPDATE dictation_records SET deleted = 1 WHERE requestId = ?').run(requestId)
    this.queueTombstone('history', requestId, row.syncVersion)
  }

  /**
   * Undo of a delete. Also withdraws the pending tombstone — leaving it queued
   * made the next sync delete the "restored" record everywhere, then locally.
   * Returns false once the deletion has already synced and the row is gone.
   */
  restoreRecord(requestId: string): boolean {
    const result = this.db
      .prepare('UPDATE dictation_records SET deleted = 0 WHERE requestId = ? AND deleted = 1')
      .run(requestId)
    this.clearTombstone('history', requestId)
    return Number(result.changes) === 1
  }

  /** Re-bases a local write onto the server's version so the next push applies. */
  rebaseHistory(requestId: string, version: number): void {
    this.db
      .prepare("UPDATE dictation_records SET syncVersion = ?, syncState = 'local' WHERE requestId = ?")
      .run(version, requestId)
  }

  rebaseDictionary(syncId: string, version: number): void {
    this.db
      .prepare("UPDATE dictionary_entries SET syncVersion = ?, syncState = 'local' WHERE syncId = ?")
      .run(version, syncId)
  }

  hasPendingTombstone(recordType: string, recordId: string): boolean {
    return (
      this.db
        .prepare('SELECT 1 FROM pending_tombstones WHERE recordType = ? AND recordId = ?')
        .get(recordType, recordId) !== undefined
    )
  }

  /** The server version this Mac already holds for a record, or null when it has none. */
  knownSyncVersion(recordType: string, recordId: string): number | null {
    const sql =
      recordType === 'history'
        ? 'SELECT syncVersion FROM dictation_records WHERE requestId = ?'
        : recordType === 'dictionary'
          ? 'SELECT syncVersion FROM dictionary_entries WHERE syncId = ?'
          : null
    if (sql === null) return null
    const row = this.db.prepare(sql).get(recordId) as { syncVersion: number } | undefined
    return row === undefined ? null : Number(row.syncVersion)
  }

  isHistoryDeleted(requestId: string): boolean | null {
    const row = this.db
      .prepare('SELECT deleted FROM dictation_records WHERE requestId = ?')
      .get(requestId) as { deleted: number } | undefined
    return row === undefined ? null : Number(row.deleted) === 1
  }

  queueTombstone(recordType: 'history' | 'dictionary', recordId: string, baseVersion: number): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO pending_tombstones(recordType, recordId, baseVersion, createdAtMs) VALUES (?, ?, ?, ?)'
      )
      .run(recordType, recordId, baseVersion, Date.now())
  }

  /**
   * Marks every local record as never uploaded and drops pending deletions. Used
   * when a new vault is created or the vault is reset: the server then holds
   * nothing, and rows marked synced to the old vault would never upload again.
   */
  resetSyncState(): void {
    this.db.exec(
      "UPDATE dictation_records SET syncState = 'local', syncVersion = 0;" +
        "UPDATE dictionary_entries SET syncState = 'local', syncVersion = 0;" +
        'DELETE FROM dictation_records WHERE deleted = 1;' +
        'DELETE FROM pending_tombstones;'
    )
  }

  /** History sync was turned off (its cloud copy deleted): re-upload it all if it comes back on. */
  markHistoryUnsynced(): void {
    this.db.exec(
      "UPDATE dictation_records SET syncState = 'local', syncVersion = 0;" +
        "DELETE FROM pending_tombstones WHERE recordType = 'history';"
    )
  }

  /** Local side of history retention; the server deletes its own expired copies. */
  deleteHistoryBefore(cutoffMs: number): void {
    this.db.prepare('DELETE FROM dictation_records WHERE createdAtMs < ?').run(cutoffMs)
    this.db
      .prepare(
        "DELETE FROM pending_tombstones WHERE recordType = 'history' AND recordId NOT IN (SELECT requestId FROM dictation_records)"
      )
      .run()
  }

  /** Removes every local record — used when a different account signs in on this Mac. */
  clearAllData(): void {
    this.db.exec('DELETE FROM dictation_records; DELETE FROM dictionary_entries; DELETE FROM pending_tombstones;')
  }

  localDataCounts(): { history: number; dictionary: number; unsynced: number } {
    const count = (sql: string): number => Number((this.db.prepare(sql).get() as { n: number }).n)
    return {
      history: count('SELECT COUNT(*) AS n FROM dictation_records WHERE deleted = 0'),
      dictionary: count('SELECT COUNT(*) AS n FROM dictionary_entries'),
      unsynced:
        count("SELECT COUNT(*) AS n FROM dictation_records WHERE deleted = 0 AND syncState = 'local'") +
        count("SELECT COUNT(*) AS n FROM dictionary_entries WHERE syncState = 'local'") +
        count('SELECT COUNT(*) AS n FROM pending_tombstones')
    }
  }

  clearHistory(): void {
    this.db.prepare("DELETE FROM dictation_records").run()
  }

  stats(sinceMs: number): HomeStats {
    const agg = this.db
      .prepare(
        `SELECT COUNT(*) AS dictations,
                COALESCE(SUM(audioDurationMs), 0) AS audioDurationMs,
                COALESCE(SUM(wordCount), 0) AS words
         FROM dictation_records
         WHERE deleted = 0 AND createdAtMs >= ?`
      )
      .get(sinceMs) as { dictations: number; audioDurationMs: number; words: number }
    const recent = this.db
      .prepare(
        `SELECT requestId, finalText, createdAtMs, wordCount, audioDurationMs
         FROM dictation_records
         WHERE deleted = 0
         ORDER BY createdAtMs DESC LIMIT 3`
      )
      .all() as HomeStats['recent']
    return { ...agg, recent }
  }

  // ---- Sync bookkeeping ----

  historyNeedingSync(): Array<DictationRecord & { syncVersion: number }> {
    const rows = this.db
      .prepare(
        `SELECT requestId, finalText, createdAtMs, zoneId, wordCount, audioDurationMs,
                asrModel, polished, asrMs, polishMs, totalMs, syncVersion
         FROM dictation_records WHERE deleted = 0 AND syncState = 'local'
         ORDER BY createdAtMs DESC LIMIT 100`
      )
      .all() as Array<Record<string, unknown>>
    return rows.map((row) => ({ ...rowToRecord(row), syncVersion: Number(row.syncVersion) }))
  }

  tombstones(): Array<{ recordType: string; recordId: string; baseVersion: number }> {
    return this.db
      .prepare("SELECT recordType, recordId, baseVersion FROM pending_tombstones LIMIT 100")
      .all() as Array<{ recordType: string; recordId: string; baseVersion: number }>
  }

  markHistorySynced(requestId: string, version: number): void {
    this.db
      .prepare("UPDATE dictation_records SET syncState = 'synced', syncVersion = ? WHERE requestId = ?")
      .run(version, requestId)
    this.rebaseTombstone('history', requestId, version)
  }

  /** A delete made while the record's own push was in flight must build on the version it produced. */
  private rebaseTombstone(recordType: string, recordId: string, version: number): void {
    this.db
      .prepare(
        'UPDATE pending_tombstones SET baseVersion = ? WHERE recordType = ? AND recordId = ? AND baseVersion < ?'
      )
      .run(version, recordType, recordId, version)
  }

  hardDeleteHistory(requestId: string): void {
    this.db.prepare("DELETE FROM dictation_records WHERE requestId = ?").run(requestId)
  }

  historyByRequestId(requestId: string): DictationRecord | null {
    const row = this.db
      .prepare(
        `SELECT requestId, finalText, createdAtMs, zoneId, wordCount, audioDurationMs,
                asrModel, polished, asrMs, polishMs, totalMs
         FROM dictation_records WHERE requestId = ?`
      )
      .get(requestId)
    return row === undefined ? null : rowToRecord(row as Record<string, unknown>)
  }

  upsertRemoteHistory(
    record: Omit<DictationRecord, 'deleted'>,
    version: number
  ): void {
    this.db
      .prepare(
        `INSERT INTO dictation_records
           (requestId, finalText, createdAtMs, zoneId, wordCount, audioDurationMs,
            asrModel, polished, asrMs, polishMs, totalMs, syncState, syncVersion)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?)
         ON CONFLICT(requestId) DO UPDATE SET
           finalText = excluded.finalText, syncVersion = excluded.syncVersion,
           syncState = 'synced'`
      )
      .run(
        record.requestId,
        record.finalText,
        record.createdAtMs,
        record.zoneId,
        record.wordCount,
        record.audioDurationMs,
        record.asrModel,
        record.polished ? 1 : 0,
        record.asrMs,
        record.polishMs,
        record.totalMs,
        version
      )
  }

  dictionaryNeedingSync(): Array<DictionaryEntry & { syncId: string; syncVersion: number }> {
    const rows = this.db
      .prepare(
        `SELECT id, term, normalizedTerm, status, source, createdAtMs, lastUsedAtMs, useCount, syncId, syncVersion
         FROM dictionary_entries WHERE syncState = 'local' LIMIT 100`
      )
      .all() as Array<Record<string, unknown>>
    return rows.map((row) => ({
      ...rowToEntry(row),
      syncId: String(row.syncId),
      syncVersion: Number(row.syncVersion)
    }))
  }

  markDictionarySynced(syncId: string, version: number): void {
    this.db
      .prepare("UPDATE dictionary_entries SET syncState = 'synced', syncVersion = ? WHERE syncId = ?")
      .run(version, syncId)
    this.rebaseTombstone('dictionary', syncId, version)
  }

  dictionaryBySyncId(syncId: string): (DictionaryEntry & { syncId: string }) | null {
    const row = this.db
      .prepare(
        `SELECT id, term, normalizedTerm, status, source, createdAtMs, lastUsedAtMs, useCount, syncId
         FROM dictionary_entries WHERE syncId = ?`
      )
      .get(syncId) as Record<string, unknown> | undefined
    return row === undefined ? null : { ...rowToEntry(row), syncId: String(row.syncId) }
  }

  upsertRemoteDictionary(
    entry: {
      term: string
      normalizedTerm: string
      status: string
      source: string
      createdAtMs: number
      lastUsedAtMs: number
      useCount: number
    },
    syncId: string,
    version: number
  ): void {
    // Match on the record's sync id first. Upserting on normalizedTerm alone
    // broke on a term renamed on the phone: the new spelling matched no row, the
    // insert hit the UNIQUE syncId, and the thrown error wedged every later pull.
    // A different local row holding the same term (added separately on two
    // devices) yields to the synced copy.
    this.db
      .prepare('DELETE FROM dictionary_entries WHERE normalizedTerm = ? AND syncId != ?')
      .run(entry.normalizedTerm, syncId)
    const updated = this.db
      .prepare(
        `UPDATE dictionary_entries SET
           term = ?, normalizedTerm = ?, status = ?, source = ?, createdAtMs = ?,
           lastUsedAtMs = ?, useCount = ?, syncState = 'synced', syncVersion = ?
         WHERE syncId = ?`
      )
      .run(
        entry.term,
        entry.normalizedTerm,
        entry.status,
        entry.source,
        entry.createdAtMs,
        entry.lastUsedAtMs,
        entry.useCount,
        version,
        syncId
      )
    if (Number(updated.changes) > 0) return
    this.db
      .prepare(
        `INSERT INTO dictionary_entries
           (term, normalizedTerm, status, source, createdAtMs, lastUsedAtMs, useCount, syncId, syncState, syncVersion)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?)`
      )
      .run(
        entry.term,
        entry.normalizedTerm,
        entry.status,
        entry.source,
        entry.createdAtMs,
        entry.lastUsedAtMs,
        entry.useCount,
        syncId,
        version
      )
  }

  deleteDictionaryBySyncId(syncId: string): void {
    this.db.prepare("DELETE FROM dictionary_entries WHERE syncId = ?").run(syncId)
  }

  applyTombstone(recordType: string, recordId: string): void {
    if (recordType === 'history') this.hardDeleteHistory(recordId)
    else if (recordType === 'dictionary') this.deleteDictionaryBySyncId(recordId)
  }

  clearTombstone(recordType: string, recordId: string): void {
    this.db
      .prepare("DELETE FROM pending_tombstones WHERE recordType = ? AND recordId = ?")
      .run(recordType, recordId)
  }

  // ---- Dictionary ----

  addTerm(rawTerm: string, source = 'manual'): boolean {
    const cleaned = cleanTerm(rawTerm)
    if (cleaned === null) return false
    const now = Date.now()
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO dictionary_entries
           (term, normalizedTerm, status, source, createdAtMs, lastUsedAtMs, syncId)
         VALUES (?, ?, 'confirmed', ?, ?, ?, ?)`
      )
      .run(cleaned, normalize(cleaned), source, now, now, randomUUID())
    return Number(result.changes) === 1
  }

  listTerms(query: string): DictionaryEntry[] {
    const like = `%${escapeLike(query.trim())}%`
    const rows = this.db
      .prepare(
        `SELECT id, term, normalizedTerm, status, source, createdAtMs, lastUsedAtMs, useCount
         FROM dictionary_entries
         WHERE status = 'confirmed' AND (:q = '' OR term LIKE :like ESCAPE '\\')
         ORDER BY CASE source WHEN 'manual' THEN 0 WHEN 'imported' THEN 1 ELSE 2 END,
                  useCount DESC, lastUsedAtMs DESC, term COLLATE NOCASE`
      )
      .all({ q: query.trim(), like }) as Array<Record<string, unknown>>
    return rows.map(rowToEntry)
  }

  deleteTerm(id: number): void {
    const row = this.db
      .prepare("SELECT syncId, syncVersion FROM dictionary_entries WHERE id = ?")
      .get(id) as { syncId: string; syncVersion: number } | undefined
    if (row === undefined) return
    this.db.prepare('DELETE FROM dictionary_entries WHERE id = ?').run(id)
    this.queueTombstone('dictionary', row.syncId, row.syncVersion)
  }

  bestGlossary(limit = 100): string[] {
    const rows = this.db
      .prepare(
        `SELECT term FROM dictionary_entries
         WHERE status = 'confirmed'
         ORDER BY CASE source WHEN 'manual' THEN 0 WHEN 'imported' THEN 1 ELSE 2 END,
                  useCount DESC, lastUsedAtMs DESC
         LIMIT ?`
      )
      .all(limit) as Array<{ term: string }>
    return rows.map((row) => row.term)
  }

  /** Bumps usage for every glossary term that appears in the committed text. */
  recordUsage(terms: string[], text: string): void {
    const lowered = text.toLowerCase()
    for (const term of terms) {
      if (!lowered.includes(term.toLowerCase())) continue
      this.db
        .prepare("UPDATE dictionary_entries SET useCount = useCount + 1, lastUsedAtMs = ? WHERE term = ?")
        .run(Date.now(), term)
    }
  }
}

function rowToRecord(row: Record<string, unknown>): DictationRecord {
  return {
    requestId: String(row.requestId),
    finalText: String(row.finalText),
    createdAtMs: Number(row.createdAtMs),
    zoneId: String(row.zoneId),
    wordCount: Number(row.wordCount),
    audioDurationMs: Number(row.audioDurationMs),
    asrModel: String(row.asrModel),
    polished: Number(row.polished) === 1,
    asrMs: Number(row.asrMs),
    polishMs: Number(row.polishMs),
    totalMs: Number(row.totalMs),
    deleted: false
  }
}

function rowToEntry(row: Record<string, unknown>): DictionaryEntry {
  return {
    id: Number(row.id),
    term: String(row.term),
    normalizedTerm: String(row.normalizedTerm),
    status: String(row.status),
    source: String(row.source),
    createdAtMs: Number(row.createdAtMs),
    lastUsedAtMs: Number(row.lastUsedAtMs),
    useCount: Number(row.useCount)
  }
}

/** Mirrors the phone's cleanTerm: trimmed, whitespace-collapsed, 2..80 chars, no newlines. */
export function cleanTerm(value: string): string | null {
  const cleaned = value.trim().replace(/\s+/g, ' ')
  return cleaned.length >= 2 && cleaned.length <= 80 && !cleaned.includes('\n') ? cleaned : null
}

/** Mirrors the phone's normalize: NFKC then lowercase. */
export function normalize(value: string): string {
  return value.trim().normalize('NFKC').toLowerCase()
}

export function escapeLike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

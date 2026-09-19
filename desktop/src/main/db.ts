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
  return new WoVoiceDb(db)
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
  syncState TEXT NOT NULL DEFAULT 'local',
  syncVersion INTEGER NOT NULL DEFAULT 0
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
    this.db
      .prepare("UPDATE dictation_records SET deleted = 1 WHERE requestId = ?")
      .run(requestId)
  }

  restoreRecord(requestId: string): void {
    this.db
      .prepare("UPDATE dictation_records SET deleted = 0 WHERE requestId = ?")
      .run(requestId)
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

  // ---- Dictionary ----

  addTerm(rawTerm: string, source = 'manual'): boolean {
    const cleaned = cleanTerm(rawTerm)
    if (cleaned === null) return false
    const now = Date.now()
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO dictionary_entries
           (term, normalizedTerm, status, source, createdAtMs, lastUsedAtMs)
         VALUES (?, ?, 'confirmed', ?, ?, ?)`
      )
      .run(cleaned, normalize(cleaned), source, now, now)
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
    this.db.prepare("DELETE FROM dictionary_entries WHERE id = ?").run(id)
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

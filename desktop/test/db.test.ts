import { strict as assert } from 'node:assert'
import { test, describe, beforeEach } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase, cleanTerm, normalize, escapeLike, type DictationRecord } from '../src/main/db'

function makeRecord(overrides: Partial<DictationRecord> = {}): DictationRecord {
  return {
    requestId: 'req-1',
    finalText: 'Hello from the desktop.',
    createdAtMs: Date.now(),
    zoneId: 'Asia/Shanghai',
    wordCount: 4,
    audioDurationMs: 2000,
    asrModel: 'whisper-large-v3-turbo',
    polished: true,
    asrMs: 500,
    polishMs: 300,
    totalMs: 800,
    deleted: false,
    ...overrides
  }
}

describe('dictation records', () => {
  let db: ReturnType<typeof openDatabase>
  beforeEach(() => {
    db = openDatabase(join(mkdtempSync(join(tmpdir(), 'wovoice-')), 'test.db'))
  })

  test('inserts and lists records newest-first', () => {
    db.insertRecord(makeRecord({ requestId: 'a', createdAtMs: 100 }))
    db.insertRecord(makeRecord({ requestId: 'b', createdAtMs: 200 }))
    const all = db.historySearch('')
    assert.equal(all.length, 2)
    assert.equal(all[0].requestId, 'b')
  })

  test('ignores duplicate requestIds (idempotent insert)', () => {
    db.insertRecord(makeRecord({ requestId: 'a', finalText: 'one' }))
    db.insertRecord(makeRecord({ requestId: 'a', finalText: 'two' }))
    assert.equal(db.historySearch('').length, 1)
    assert.equal(db.historySearch('')[0].finalText, 'one')
  })

  test('searches by substring with wildcards escaped', () => {
    db.insertRecord(makeRecord({ requestId: 'a', finalText: 'cost 100% today' }))
    db.insertRecord(makeRecord({ requestId: 'b', finalText: 'plain text' }))
    assert.equal(db.historySearch('100%').length, 1)
    assert.equal(db.historySearch('100').length, 1)
    assert.equal(db.historySearch('missing').length, 0)
  })

  test('soft delete hides and restore brings back', () => {
    db.insertRecord(makeRecord())
    db.deleteRecord('req-1')
    assert.equal(db.historySearch('').length, 0)
    db.restoreRecord('req-1')
    assert.equal(db.historySearch('').length, 1)
  })

  test('stats aggregate words and duration with recent list', () => {
    db.insertRecord(makeRecord({ requestId: 'a', wordCount: 10, audioDurationMs: 20_000, createdAtMs: 1_000 }))
    db.insertRecord(makeRecord({ requestId: 'b', wordCount: 30, audioDurationMs: 40_000, createdAtMs: 2_000 }))
    const stats = db.stats(0)
    assert.equal(stats.dictations, 2)
    assert.equal(stats.words, 40)
    assert.equal(stats.audioDurationMs, 60_000)
    assert.equal(stats.recent.length, 2)
    assert.equal(stats.recent[0].requestId, 'b')
  })

  test('stats exclude deleted records', () => {
    db.insertRecord(makeRecord({ requestId: 'a', wordCount: 10 }))
    db.deleteRecord('a')
    const stats = db.stats(0)
    assert.equal(stats.dictations, 0)
  })
})

describe('dictionary', () => {
  let db: ReturnType<typeof openDatabase>
  beforeEach(() => {
    db = openDatabase(':memory:')
  })

  test('adds, dedupes case-insensitively, and validates length', () => {
    assert.equal(db.addTerm('Alia Had'), true)
    assert.equal(db.addTerm('alia had'), false)
    assert.equal(db.addTerm('x'), false)
    assert.equal(db.addTerm('a'.repeat(81)), false)
    assert.equal(db.listTerms('').length, 1)
  })

  test('glossary ranks manual over learned, then usage', () => {
    db.addTerm('Zebra')
    db.addTerm('Alia Had')
    db.recordUsage(['Alia Had', 'Alia Had', 'Alia Had'], 'Hello Alia Had')
    const glossary = db.bestGlossary(10)
    // manual rank is equal; higher useCount first
    assert.equal(glossary[0], 'Alia Had')
  })

  test('deletes terms', () => {
    db.addTerm('WoVoice')
    const [entry] = db.listTerms('')
    db.deleteTerm(entry.id)
    assert.equal(db.listTerms('').length, 0)
  })

  test('recordUsage only bumps terms present in the text', () => {
    db.addTerm('Alpha')
    db.addTerm('Beta')
    db.recordUsage(['Alpha', 'Beta'], 'alpha only appears here')
    const entries = db.listTerms('')
    const alpha = entries.find((e) => e.term === 'Alpha')
    const beta = entries.find((e) => e.term === 'Beta')
    assert.equal(alpha?.useCount, 1)
    assert.equal(beta?.useCount, 0)
  })
})

describe('schema migration', () => {
  test('upgrades a database created before sync existed', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'wovoice-')), 'legacy.db')
    const legacy = new DatabaseSync(path)
    // The pre-sync (E5) shape: dictionary_entries had no syncId.
    legacy.exec(`
      CREATE TABLE dictation_records (
        requestId TEXT PRIMARY KEY, finalText TEXT NOT NULL, createdAtMs INTEGER NOT NULL,
        zoneId TEXT NOT NULL, wordCount INTEGER NOT NULL, audioDurationMs INTEGER NOT NULL,
        asrModel TEXT NOT NULL, polished INTEGER NOT NULL, asrMs INTEGER NOT NULL DEFAULT 0,
        polishMs INTEGER NOT NULL DEFAULT 0, totalMs INTEGER NOT NULL DEFAULT 0,
        deleted INTEGER NOT NULL DEFAULT 0, syncState TEXT NOT NULL DEFAULT 'local',
        syncVersion INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE dictionary_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT, term TEXT NOT NULL,
        normalizedTerm TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'confirmed',
        source TEXT NOT NULL DEFAULT 'manual', createdAtMs INTEGER NOT NULL,
        lastUsedAtMs INTEGER NOT NULL, useCount INTEGER NOT NULL DEFAULT 0,
        syncState TEXT NOT NULL DEFAULT 'local', syncVersion INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO dictionary_entries (term, normalizedTerm, createdAtMs, lastUsedAtMs)
        VALUES ('Rahim', 'rahim', 1, 1), ('Dhaka', 'dhaka', 1, 1);
    `)
    legacy.close()

    const db = openDatabase(path)
    const pending = db.dictionaryNeedingSync()
    assert.equal(pending.length, 2)
    assert.equal(new Set(pending.map((entry) => entry.syncId)).size, 2)
    assert.equal(db.addTerm('Chattogram'), true)
    assert.equal(db.dictionaryNeedingSync().length, 3)
    // Reopening an upgraded database is a no-op.
    assert.equal(openDatabase(path).listTerms('').length, 3)
  })
})

describe('term helpers', () => {
  test('cleanTerm mirrors the phone rules', () => {
    assert.equal(cleanTerm('  Hello   World  '), 'Hello World')
    assert.equal(cleanTerm('a'), null)
    // The phone collapses whitespace before its newline check, so embedded
    // newlines become spaces rather than a rejection — mirror that exactly.
    assert.equal(cleanTerm('line\nbreak'), 'line break')
    assert.equal(cleanTerm('a'.repeat(81)), null)
  })

  test('normalize is NFKC + lowercase', () => {
    assert.equal(normalize('Ｃａｆé'), 'café')
    assert.equal(normalize('  ABC  '), 'abc')
  })

  test('escapeLike escapes wildcard characters', () => {
    assert.equal(escapeLike('100%_done'), '100\\%\\_done')
  })
})

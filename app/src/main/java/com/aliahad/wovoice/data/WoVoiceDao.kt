package com.aliahad.wovoice.data

import androidx.room.Dao
import androidx.room.Delete
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import androidx.room.Update

@Dao
abstract class WoVoiceDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    abstract suspend fun insertRecord(record: DictationRecord): Long

    @Query(
        """SELECT * FROM dictation_records
           WHERE (:query = '' OR finalText LIKE '%' || :query || '%')
           ORDER BY createdAtMs DESC""",
    )
    abstract suspend fun history(query: String): List<DictationRecord>

    @Query("SELECT * FROM dictation_records ORDER BY createdAtMs DESC LIMIT :limit")
    abstract suspend fun recent(limit: Int): List<DictationRecord>

    @Delete
    abstract suspend fun deleteRecord(record: DictationRecord)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    abstract suspend fun restoreRecord(record: DictationRecord): Long

    @Query("DELETE FROM dictation_records")
    abstract suspend fun clearHistory()

    @Query("SELECT * FROM daily_usage WHERE dateKey = :key LIMIT 1")
    abstract suspend fun dailyUsage(key: String): DailyUsageAggregate?

    @Query("SELECT * FROM daily_usage WHERE lastEventAtMs >= :sinceMs ORDER BY lastEventAtMs DESC")
    abstract suspend fun usageSince(sinceMs: Long): List<DailyUsageAggregate>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    abstract suspend fun upsertUsage(value: DailyUsageAggregate)

    @Query("DELETE FROM daily_usage")
    abstract suspend fun resetAnalytics()

    @Query("UPDATE daily_usage SET correctionCount = correctionCount + 1 WHERE dateKey = :dateKey")
    abstract suspend fun noteCorrection(dateKey: String)

    @Query(
        """SELECT * FROM dictionary_entries
           WHERE status = :status AND (:query = '' OR term LIKE '%' || :query || '%')
           ORDER BY CASE source WHEN 'manual' THEN 0 WHEN 'imported' THEN 1 ELSE 2 END,
                    useCount DESC, lastUsedAtMs DESC, term COLLATE NOCASE""",
    )
    abstract suspend fun dictionary(status: String, query: String): List<DictionaryEntry>

    @Query("SELECT * FROM dictionary_entries WHERE normalizedTerm = :normalized LIMIT 1")
    abstract suspend fun dictionaryByNormalized(normalized: String): DictionaryEntry?

    @Query("SELECT COUNT(*) FROM dictionary_entries")
    abstract suspend fun dictionaryCount(): Int

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    abstract suspend fun insertDictionary(value: DictionaryEntry): Long

    @Update
    abstract suspend fun updateDictionary(value: DictionaryEntry)

    @Delete
    abstract suspend fun deleteDictionary(value: DictionaryEntry)

    @Query("DELETE FROM dictionary_entries")
    abstract suspend fun clearDictionary()

    @Query(
        """SELECT * FROM dictionary_entries WHERE status = 'confirmed'
           ORDER BY CASE source WHEN 'manual' THEN 0 WHEN 'imported' THEN 1 ELSE 2 END,
                    useCount DESC, lastUsedAtMs DESC LIMIT :limit""",
    )
    abstract suspend fun bestDictionary(limit: Int): List<DictionaryEntry>

    @Transaction
    open suspend fun recordSuccess(record: DictationRecord, seed: DailyUsageAggregate, keepHistory: Boolean) {
        if (keepHistory && insertRecord(record) == -1L) return
        val current = dailyUsage(seed.dateKey)
        if (current == null) {
            upsertUsage(seed)
            return
        }
        val samples = (current.processingSamplesMs.split(',').filter(String::isNotBlank) + record.totalMs.toString())
            .takeLast(MAX_DAILY_SAMPLES)
            .joinToString(",")
        upsertUsage(
            current.copy(
                lastEventAtMs = maxOf(current.lastEventAtMs, record.createdAtMs),
                dictationCount = current.dictationCount + 1,
                audioDurationMs = current.audioDurationMs + record.audioDurationMs,
                wordCount = current.wordCount + record.wordCount,
                processingTotalMs = current.processingTotalMs + record.totalMs,
                processingSamplesMs = samples,
                polishedCount = current.polishedCount + if (record.polished) 1 else 0,
                asrNeurons = current.asrNeurons + (record.asrNeurons ?: 0.0),
                polishNeurons = current.polishNeurons + (record.polishNeurons ?: 0.0),
                totalNeurons = current.totalNeurons + (record.totalNeurons ?: 0.0),
                estimatedCostUsd = current.estimatedCostUsd + (record.estimatedCostUsd ?: 0.0),
            ),
        )
    }

    companion object {
        private const val MAX_DAILY_SAMPLES = 2_000
    }
}

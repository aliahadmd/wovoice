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
           WHERE ownerAccountId IS :ownerAccountId
             AND (:query = '' OR finalText LIKE '%' || :query || '%')
           ORDER BY createdAtMs DESC""",
    )
    abstract suspend fun history(ownerAccountId: String?, query: String): List<DictationRecord>

    @Query("SELECT * FROM dictation_records WHERE ownerAccountId IS :ownerAccountId ORDER BY createdAtMs DESC LIMIT :limit")
    abstract suspend fun recent(ownerAccountId: String?, limit: Int): List<DictationRecord>

    @Delete
    abstract suspend fun deleteRecord(record: DictationRecord)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    abstract suspend fun restoreRecord(record: DictationRecord): Long

    @Query("DELETE FROM dictation_records WHERE ownerAccountId IS :ownerAccountId")
    abstract suspend fun clearHistory(ownerAccountId: String?)

    @Query("SELECT * FROM daily_usage WHERE dateKey = :key AND ownerAccountId IS :ownerAccountId LIMIT 1")
    abstract suspend fun dailyUsage(key: String, ownerAccountId: String?): DailyUsageAggregate?

    @Query("SELECT * FROM daily_usage WHERE ownerAccountId IS :ownerAccountId AND lastEventAtMs >= :sinceMs ORDER BY lastEventAtMs DESC")
    abstract suspend fun usageSince(ownerAccountId: String?, sinceMs: Long): List<DailyUsageAggregate>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    abstract suspend fun upsertUsage(value: DailyUsageAggregate)

    @Query("DELETE FROM daily_usage WHERE ownerAccountId IS :ownerAccountId")
    abstract suspend fun resetAnalytics(ownerAccountId: String?)

    @Query("UPDATE daily_usage SET correctionCount = correctionCount + 1 WHERE dateKey = :dateKey")
    abstract suspend fun noteCorrection(dateKey: String)

    @Query(
        """SELECT * FROM dictionary_entries
           WHERE ownerAccountId IS :ownerAccountId AND status = :status
             AND (:query = '' OR term LIKE '%' || :query || '%')
           ORDER BY CASE source WHEN 'manual' THEN 0 WHEN 'imported' THEN 1 ELSE 2 END,
                    useCount DESC, lastUsedAtMs DESC, term COLLATE NOCASE""",
    )
    abstract suspend fun dictionary(ownerAccountId: String?, status: String, query: String): List<DictionaryEntry>

    @Query("SELECT * FROM dictionary_entries WHERE ownerAccountId IS :ownerAccountId AND normalizedTerm = :normalized LIMIT 1")
    abstract suspend fun dictionaryByNormalized(ownerAccountId: String?, normalized: String): DictionaryEntry?

    @Query("SELECT COUNT(*) FROM dictionary_entries WHERE ownerAccountId IS :ownerAccountId")
    abstract suspend fun dictionaryCount(ownerAccountId: String?): Int

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    abstract suspend fun insertDictionary(value: DictionaryEntry): Long

    @Update
    abstract suspend fun updateDictionary(value: DictionaryEntry)

    @Delete
    abstract suspend fun deleteDictionary(value: DictionaryEntry)

    @Query("DELETE FROM dictionary_entries WHERE ownerAccountId IS :ownerAccountId")
    abstract suspend fun clearDictionary(ownerAccountId: String?)

    @Query(
        """SELECT * FROM dictionary_entries WHERE ownerAccountId IS :ownerAccountId AND status = 'confirmed'
           ORDER BY CASE source WHEN 'manual' THEN 0 WHEN 'imported' THEN 1 ELSE 2 END,
                    useCount DESC, lastUsedAtMs DESC LIMIT :limit""",
    )
    abstract suspend fun bestDictionary(ownerAccountId: String?, limit: Int): List<DictionaryEntry>

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    abstract suspend fun insertAnalyticsEvent(value: AnalyticsSyncEvent): Long

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    abstract suspend fun upsertOutbox(value: EncryptedSyncOutboxItem): Long

    @Query("SELECT * FROM encrypted_sync_outbox WHERE ownerAccountId = :ownerAccountId ORDER BY createdAtMs LIMIT :limit")
    abstract suspend fun outbox(ownerAccountId: String, limit: Int): List<EncryptedSyncOutboxItem>

    @Query("DELETE FROM encrypted_sync_outbox WHERE id IN (:ids)")
    abstract suspend fun deleteOutbox(ids: List<Long>)

    @Query("DELETE FROM encrypted_sync_outbox WHERE ownerAccountId = :ownerAccountId AND recordType = :type AND recordId = :recordId")
    abstract suspend fun deleteOutboxRecord(ownerAccountId: String, type: String, recordId: String)

    @Query("SELECT * FROM dictation_records WHERE ownerAccountId = :ownerAccountId AND syncState = 'local' LIMIT :limit")
    abstract suspend fun unsyncedHistory(ownerAccountId: String, limit: Int): List<DictationRecord>

    @Query("SELECT * FROM dictation_records WHERE ownerAccountId = :ownerAccountId AND syncId = :syncId LIMIT 1")
    abstract suspend fun historyBySyncId(ownerAccountId: String, syncId: String): DictationRecord?

    @Query("DELETE FROM dictation_records WHERE ownerAccountId = :ownerAccountId AND syncId = :syncId")
    abstract suspend fun deleteHistoryBySyncId(ownerAccountId: String, syncId: String)

    @Query("SELECT * FROM dictionary_entries WHERE ownerAccountId = :ownerAccountId AND status = 'confirmed' AND syncState = 'local' LIMIT :limit")
    abstract suspend fun unsyncedDictionary(ownerAccountId: String, limit: Int): List<DictionaryEntry>

    @Query("SELECT * FROM dictionary_entries WHERE ownerAccountId = :ownerAccountId AND syncId = :syncId LIMIT 1")
    abstract suspend fun dictionaryBySyncId(ownerAccountId: String, syncId: String): DictionaryEntry?

    @Query("DELETE FROM dictionary_entries WHERE ownerAccountId = :ownerAccountId AND syncId = :syncId")
    abstract suspend fun deleteDictionaryBySyncId(ownerAccountId: String, syncId: String)

    @Query("SELECT * FROM analytics_sync_events WHERE ownerAccountId = :ownerAccountId AND syncState = 'local' LIMIT :limit")
    abstract suspend fun unsyncedAnalytics(ownerAccountId: String, limit: Int): List<AnalyticsSyncEvent>

    @Query("SELECT * FROM analytics_sync_events WHERE ownerAccountId = :ownerAccountId AND syncId = :syncId LIMIT 1")
    abstract suspend fun analyticsBySyncId(ownerAccountId: String, syncId: String): AnalyticsSyncEvent?

    @Query("DELETE FROM analytics_sync_events WHERE ownerAccountId = :ownerAccountId AND syncId = :syncId")
    abstract suspend fun deleteAnalyticsBySyncId(ownerAccountId: String, syncId: String)

    @Query("SELECT * FROM analytics_sync_events WHERE ownerAccountId = :ownerAccountId")
    abstract suspend fun analyticsEvents(ownerAccountId: String): List<AnalyticsSyncEvent>

    @Query("DELETE FROM analytics_sync_events WHERE ownerAccountId = :ownerAccountId")
    abstract suspend fun deleteAnalyticsEvents(ownerAccountId: String)

    @Query("UPDATE dictation_records SET syncState = :state, syncVersion = :version WHERE ownerAccountId = :ownerAccountId AND syncId = :syncId")
    abstract suspend fun updateHistorySync(ownerAccountId: String, syncId: String, state: String, version: Int)

    @Query("UPDATE dictionary_entries SET syncState = :state, syncVersion = :version WHERE ownerAccountId = :ownerAccountId AND syncId = :syncId")
    abstract suspend fun updateDictionarySync(ownerAccountId: String, syncId: String, state: String, version: Int)

    @Query("UPDATE analytics_sync_events SET syncState = :state, syncVersion = :version WHERE ownerAccountId = :ownerAccountId AND syncId = :syncId")
    abstract suspend fun updateAnalyticsSync(ownerAccountId: String, syncId: String, state: String, version: Int)

    @Query("SELECT (SELECT COUNT(*) FROM dictation_records WHERE ownerAccountId IS NULL) + (SELECT COUNT(*) FROM daily_usage WHERE ownerAccountId IS NULL) + (SELECT COUNT(*) FROM dictionary_entries WHERE ownerAccountId IS NULL)")
    abstract suspend fun unassignedCount(): Int

    @Transaction
    open suspend fun assignUnassigned(ownerAccountId: String) {
        assignHistory(ownerAccountId)
        assignUsage(ownerAccountId)
        assignDictionary(ownerAccountId)
    }

    @Query("UPDATE dictation_records SET ownerAccountId = :ownerAccountId, syncId = CASE WHEN syncId = '' THEN requestId ELSE syncId END, syncState = 'local' WHERE ownerAccountId IS NULL")
    protected abstract suspend fun assignHistory(ownerAccountId: String)

    @Query("UPDATE daily_usage SET ownerAccountId = :ownerAccountId WHERE ownerAccountId IS NULL")
    protected abstract suspend fun assignUsage(ownerAccountId: String)

    @Query("UPDATE dictionary_entries SET ownerAccountId = :ownerAccountId, syncId = CASE WHEN syncId = '' THEN lower(hex(randomblob(16))) ELSE syncId END, syncState = 'local' WHERE ownerAccountId IS NULL")
    protected abstract suspend fun assignDictionary(ownerAccountId: String)

    @Transaction
    open suspend fun deleteUnassigned() {
        deleteUnassignedHistory()
        deleteUnassignedUsage()
        deleteUnassignedDictionary()
    }

    @Query("DELETE FROM dictation_records WHERE ownerAccountId IS NULL")
    protected abstract suspend fun deleteUnassignedHistory()

    @Query("DELETE FROM daily_usage WHERE ownerAccountId IS NULL")
    protected abstract suspend fun deleteUnassignedUsage()

    @Query("DELETE FROM dictionary_entries WHERE ownerAccountId IS NULL")
    protected abstract suspend fun deleteUnassignedDictionary()

    @Query("DELETE FROM dictation_records")
    abstract suspend fun clearAllHistory()

    @Query("DELETE FROM daily_usage")
    abstract suspend fun clearAllUsage()

    @Query("DELETE FROM dictionary_entries")
    abstract suspend fun clearAllDictionary()

    @Query("DELETE FROM analytics_sync_events")
    abstract suspend fun clearAllAnalyticsEvents()

    @Query("DELETE FROM encrypted_sync_outbox")
    abstract suspend fun clearAllOutbox()

    @Transaction
    open suspend fun deleteAccountPartition(ownerAccountId: String) {
        deleteAccountHistory(ownerAccountId)
        deleteAccountUsage(ownerAccountId)
        deleteAccountDictionary(ownerAccountId)
        deleteAnalyticsEvents(ownerAccountId)
        deleteAccountOutbox(ownerAccountId)
    }

    @Query("DELETE FROM dictation_records WHERE ownerAccountId = :ownerAccountId")
    protected abstract suspend fun deleteAccountHistory(ownerAccountId: String)

    @Query("DELETE FROM daily_usage WHERE ownerAccountId = :ownerAccountId")
    protected abstract suspend fun deleteAccountUsage(ownerAccountId: String)

    @Query("DELETE FROM dictionary_entries WHERE ownerAccountId = :ownerAccountId")
    protected abstract suspend fun deleteAccountDictionary(ownerAccountId: String)

    @Query("DELETE FROM encrypted_sync_outbox WHERE ownerAccountId = :ownerAccountId")
    protected abstract suspend fun deleteAccountOutbox(ownerAccountId: String)

    @Transaction
    open suspend fun recordSuccess(
        record: DictationRecord,
        seed: DailyUsageAggregate,
        event: AnalyticsSyncEvent?,
        keepHistory: Boolean,
    ) {
        if (keepHistory && insertRecord(record) == -1L) return
        if (event != null) insertAnalyticsEvent(event)
        val current = dailyUsage(seed.dateKey, seed.ownerAccountId)
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

    @Transaction
    open suspend fun mergeRemoteAnalytics(event: AnalyticsSyncEvent, seed: DailyUsageAggregate) {
        if (insertAnalyticsEvent(event) == -1L) return
        val current = dailyUsage(seed.dateKey, seed.ownerAccountId)
        if (current == null) {
            upsertUsage(seed)
            return
        }
        val samples = (current.processingSamplesMs.split(',').filter(String::isNotBlank) + event.processingMs.toString())
            .takeLast(MAX_DAILY_SAMPLES)
            .joinToString(",")
        upsertUsage(
            current.copy(
                lastEventAtMs = maxOf(current.lastEventAtMs, event.createdAtMs),
                dictationCount = current.dictationCount + 1,
                audioDurationMs = current.audioDurationMs + event.audioDurationMs,
                wordCount = current.wordCount + event.wordCount,
                processingTotalMs = current.processingTotalMs + event.processingMs,
                processingSamplesMs = samples,
                polishedCount = current.polishedCount + if (event.polished) 1 else 0,
                correctionCount = current.correctionCount + if (event.corrected) 1 else 0,
                asrNeurons = current.asrNeurons + event.asrNeurons,
                polishNeurons = current.polishNeurons + event.polishNeurons,
                totalNeurons = current.totalNeurons + event.asrNeurons + event.polishNeurons,
                estimatedCostUsd = current.estimatedCostUsd + event.estimatedCostUsd,
            ),
        )
    }

    companion object {
        private const val MAX_DAILY_SAMPLES = 2_000
    }
}

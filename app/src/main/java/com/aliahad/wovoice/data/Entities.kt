package com.aliahad.wovoice.data

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(
    tableName = "dictation_records",
    indices = [Index(value = ["requestId"], unique = true)],
)
data class DictationRecord(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val requestId: String,
    val finalText: String,
    val createdAtMs: Long,
    val zoneId: String,
    val offsetSeconds: Int,
    val wordCount: Int,
    val audioDurationMs: Long,
    val asrModel: String,
    val polished: Boolean,
    val asrMs: Long,
    val polishMs: Long,
    val totalMs: Long,
    val pricingVersion: String?,
    val inputTokens: Long?,
    val outputTokens: Long?,
    val asrNeurons: Double?,
    val polishNeurons: Double?,
    val totalNeurons: Double?,
    val estimatedCostUsd: Double?,
    val ownerAccountId: String? = null,
    val syncId: String = "",
    val syncVersion: Int = 0,
    val syncState: String = SYNC_LOCAL,
)

@Entity(tableName = "daily_usage")
data class DailyUsageAggregate(
    @PrimaryKey val dateKey: String,
    val localDate: String,
    val zoneId: String,
    val firstEventAtMs: Long,
    val lastEventAtMs: Long,
    val dictationCount: Long,
    val audioDurationMs: Long,
    val wordCount: Long,
    val processingTotalMs: Long,
    val processingSamplesMs: String,
    val polishedCount: Long,
    val correctionCount: Long,
    val asrNeurons: Double,
    val polishNeurons: Double,
    val totalNeurons: Double,
    val estimatedCostUsd: Double,
    val ownerAccountId: String? = null,
)

@Entity(
    tableName = "dictionary_entries",
    indices = [Index(value = ["ownerAccountId", "normalizedTerm"], unique = true)],
)
data class DictionaryEntry(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val term: String,
    val normalizedTerm: String,
    val status: String,
    val source: String,
    val createdAtMs: Long,
    val lastUsedAtMs: Long,
    val useCount: Long,
    val ownerAccountId: String? = null,
    val syncId: String = "",
    val syncVersion: Int = 0,
    val syncState: String = SYNC_LOCAL,
) {
    val isConfirmed: Boolean get() = status == STATUS_CONFIRMED

    companion object {
        const val STATUS_CONFIRMED = "confirmed"
        const val STATUS_SUGGESTED = "suggested"
        const val SOURCE_MANUAL = "manual"
        const val SOURCE_IMPORTED = "imported"
        const val SOURCE_LEARNED = "learned"
    }
}

@Entity(
    tableName = "analytics_sync_events",
    indices = [Index(value = ["syncId"], unique = true), Index(value = ["ownerAccountId", "syncState"])],
)
data class AnalyticsSyncEvent(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val syncId: String,
    val ownerAccountId: String,
    val createdAtMs: Long,
    val zoneId: String,
    val audioDurationMs: Long,
    val wordCount: Int,
    val processingMs: Long,
    val polished: Boolean,
    val corrected: Boolean,
    val asrNeurons: Double,
    val polishNeurons: Double,
    val estimatedCostUsd: Double,
    val syncVersion: Int = 0,
    val syncState: String = SYNC_LOCAL,
)

@Entity(
    tableName = "encrypted_sync_outbox",
    indices = [Index(value = ["ownerAccountId", "recordType", "recordId"], unique = true)],
)
data class EncryptedSyncOutboxItem(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val ownerAccountId: String,
    val recordType: String,
    val recordId: String,
    val baseVersion: Int,
    val keyVersion: Int,
    val nonce: String,
    val ciphertext: String,
    val deleted: Boolean,
    val createdAtMs: Long,
)

const val SYNC_LOCAL = "local"
const val SYNC_QUEUED = "queued"
const val SYNCED = "synced"

data class DashboardSnapshot(
    val aggregates: List<DailyUsageAggregate>,
    val recent: List<DictationRecord>,
)

data class DashboardMetrics(
    val dictations: Long,
    val audioDurationMs: Long,
    val words: Long,
    val wpm: Int,
    val medianProcessingMs: Long,
    val correctionRate: Int,
    val polishedRate: Int,
    val asrNeurons: Double,
    val polishNeurons: Double,
    val totalNeurons: Double,
    val estimatedCostUsd: Double,
)

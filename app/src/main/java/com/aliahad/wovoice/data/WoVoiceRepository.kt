package com.aliahad.wovoice.data

import android.content.Context
import com.aliahad.wovoice.network.TranscriptionClient
import java.text.Normalizer
import java.time.ZonedDateTime
import kotlin.math.roundToInt

class WoVoiceRepository(context: Context) {
    private val dao = WoVoiceDatabase.get(context).dao()

    suspend fun recordSuccessfulDictation(
        result: TranscriptionClient.Result.Success,
        committedText: String,
        audioDurationMs: Long,
        keepHistory: Boolean,
    ) {
        val now = ZonedDateTime.now()
        val usage = result.usage
        val record = DictationRecord(
            requestId = result.requestId.ifBlank { "local-${System.currentTimeMillis()}-${committedText.hashCode()}" },
            finalText = committedText.trim(),
            createdAtMs = now.toInstant().toEpochMilli(),
            zoneId = now.zone.id,
            offsetSeconds = now.offset.totalSeconds,
            wordCount = WordCounter.count(committedText),
            audioDurationMs = audioDurationMs,
            asrModel = result.model,
            polished = result.polished,
            asrMs = result.timings.asr,
            polishMs = result.timings.polish,
            totalMs = result.timings.total,
            pricingVersion = usage?.pricingVersion,
            inputTokens = usage?.inputTokens,
            outputTokens = usage?.outputTokens,
            asrNeurons = usage?.asrNeurons,
            polishNeurons = usage?.polishNeurons,
            totalNeurons = usage?.totalNeurons,
            estimatedCostUsd = usage?.estimatedCostUsd,
        )
        val key = "${now.toLocalDate()}|${now.zone.id}"
        val aggregate = DailyUsageAggregate(
            dateKey = key,
            localDate = now.toLocalDate().toString(),
            zoneId = now.zone.id,
            firstEventAtMs = record.createdAtMs,
            lastEventAtMs = record.createdAtMs,
            dictationCount = 1,
            audioDurationMs = audioDurationMs,
            wordCount = record.wordCount.toLong(),
            processingTotalMs = record.totalMs,
            processingSamplesMs = record.totalMs.toString(),
            polishedCount = if (record.polished) 1 else 0,
            correctionCount = 0,
            asrNeurons = usage?.asrNeurons ?: 0.0,
            polishNeurons = usage?.polishNeurons ?: 0.0,
            totalNeurons = usage?.totalNeurons ?: 0.0,
            estimatedCostUsd = usage?.estimatedCostUsd ?: 0.0,
        )
        dao.recordSuccess(record, aggregate, keepHistory)
    }

    suspend fun dashboard(period: AnalyticsPeriod): DashboardSnapshot = DashboardSnapshot(
        aggregates = dao.usageSince(period.sinceMs()),
        recent = dao.recent(3),
    )

    suspend fun metricsSince(sinceMs: Long): DashboardMetrics = metrics(dao.usageSince(sinceMs))

    suspend fun history(query: String = ""): List<DictationRecord> = dao.history(query.trim())

    suspend fun deleteHistory(record: DictationRecord) = dao.deleteRecord(record)
    suspend fun restoreHistory(record: DictationRecord) = dao.restoreRecord(record)
    suspend fun clearHistory() = dao.clearHistory()
    suspend fun resetAnalytics() = dao.resetAnalytics()

    suspend fun dictionary(confirmed: Boolean, query: String = ""): List<DictionaryEntry> =
        dao.dictionary(
            if (confirmed) DictionaryEntry.STATUS_CONFIRMED else DictionaryEntry.STATUS_SUGGESTED,
            query.trim(),
        )

    suspend fun addManualTerm(term: String): Boolean = addTerm(
        term,
        DictionaryEntry.STATUS_CONFIRMED,
        DictionaryEntry.SOURCE_MANUAL,
    )

    suspend fun addSuggestion(term: String): Boolean = addTerm(
        term,
        DictionaryEntry.STATUS_SUGGESTED,
        DictionaryEntry.SOURCE_LEARNED,
    )

    suspend fun acceptSuggestion(entry: DictionaryEntry) {
        dao.updateDictionary(
            entry.copy(
                status = DictionaryEntry.STATUS_CONFIRMED,
                source = DictionaryEntry.SOURCE_LEARNED,
                lastUsedAtMs = System.currentTimeMillis(),
            ),
        )
    }

    suspend fun renameTerm(entry: DictionaryEntry, newTerm: String): Boolean {
        val cleaned = cleanTerm(newTerm) ?: return false
        val normalized = normalize(cleaned)
        val duplicate = dao.dictionaryByNormalized(normalized)
        if (duplicate != null && duplicate.id != entry.id) return false
        dao.updateDictionary(entry.copy(term = cleaned, normalizedTerm = normalized, lastUsedAtMs = System.currentTimeMillis()))
        return true
    }

    suspend fun deleteDictionary(entry: DictionaryEntry) = dao.deleteDictionary(entry)
    suspend fun clearDictionary() = dao.clearDictionary()

    suspend fun bestGlossary(): List<String> = dao.bestDictionary(100).map(DictionaryEntry::term)

    suspend fun noteCorrection() {
        val now = ZonedDateTime.now()
        dao.noteCorrection("${now.toLocalDate()}|${now.zone.id}")
    }

    suspend fun importGlossary(values: List<String>) {
        values.forEach { addTerm(it, DictionaryEntry.STATUS_CONFIRMED, DictionaryEntry.SOURCE_IMPORTED) }
    }

    private suspend fun addTerm(term: String, status: String, source: String): Boolean {
        val cleaned = cleanTerm(term) ?: return false
        val normalized = normalize(cleaned)
        val existing = dao.dictionaryByNormalized(normalized)
        if (existing != null) {
            if (status == DictionaryEntry.STATUS_CONFIRMED && !existing.isConfirmed) {
                dao.updateDictionary(existing.copy(term = cleaned, status = status, source = source))
                return true
            }
            return false
        }
        if (dao.dictionaryCount() >= MAX_DICTIONARY_TERMS) return false
        val now = System.currentTimeMillis()
        return dao.insertDictionary(
            DictionaryEntry(
                term = cleaned,
                normalizedTerm = normalized,
                status = status,
                source = source,
                createdAtMs = now,
                lastUsedAtMs = now,
                useCount = 0,
            ),
        ) != -1L
    }

    companion object {
        private const val MAX_DICTIONARY_TERMS = 1_000

        fun metrics(values: List<DailyUsageAggregate>): DashboardMetrics {
            val dictations = values.sumOf(DailyUsageAggregate::dictationCount)
            val duration = values.sumOf(DailyUsageAggregate::audioDurationMs)
            val words = values.sumOf(DailyUsageAggregate::wordCount)
            val samples = values.flatMap { value ->
                value.processingSamplesMs.split(',').mapNotNull(String::toLongOrNull)
            }.sorted()
            val median = when {
                samples.isEmpty() -> 0
                samples.size % 2 == 1 -> samples[samples.size / 2]
                else -> (samples[samples.size / 2 - 1] + samples[samples.size / 2]) / 2
            }
            val corrections = values.sumOf(DailyUsageAggregate::correctionCount)
            val polished = values.sumOf(DailyUsageAggregate::polishedCount)
            return DashboardMetrics(
                dictations = dictations,
                audioDurationMs = duration,
                words = words,
                wpm = if (duration > 0) (words * 60_000.0 / duration).roundToInt() else 0,
                medianProcessingMs = median,
                correctionRate = if (dictations > 0) (corrections * 100.0 / dictations).roundToInt() else 0,
                polishedRate = if (dictations > 0) (polished * 100.0 / dictations).roundToInt() else 0,
                asrNeurons = values.sumOf(DailyUsageAggregate::asrNeurons),
                polishNeurons = values.sumOf(DailyUsageAggregate::polishNeurons),
                totalNeurons = values.sumOf(DailyUsageAggregate::totalNeurons),
                estimatedCostUsd = values.sumOf(DailyUsageAggregate::estimatedCostUsd),
            )
        }

        private fun cleanTerm(value: String): String? = value.trim()
            .replace(Regex("\\s+"), " ")
            .takeIf { it.length in 2..80 && !it.contains('\n') }

        fun normalize(value: String): String = Normalizer.normalize(value.trim(), Normalizer.Form.NFKC).lowercase()
    }
}

enum class AnalyticsPeriod {
    TODAY,
    SEVEN_DAYS,
    THIRTY_DAYS,
    ALL_TIME;

    fun sinceMs(now: ZonedDateTime = ZonedDateTime.now()): Long = when (this) {
        TODAY -> now.toLocalDate().atStartOfDay(now.zone).toInstant().toEpochMilli()
        SEVEN_DAYS -> now.toLocalDate().minusDays(6).atStartOfDay(now.zone).toInstant().toEpochMilli()
        THIRTY_DAYS -> now.toLocalDate().minusDays(29).atStartOfDay(now.zone).toInstant().toEpochMilli()
        ALL_TIME -> 0L
    }
}

object WordCounter {
    private val word = Regex("[\\p{L}\\p{N}]+(?:['’\u2010-\u2015-][\\p{L}\\p{N}]+)*")
    fun count(text: String): Int = word.findAll(text).count()
}

package com.aliahad.wovoice.data

import org.junit.Assert.assertEquals
import org.junit.Test

class DashboardMetricsTest {
    @Test
    fun countsUnicodeWordsAndContractions() {
        assertEquals(5, WordCounter.count("Rahim's résumé has 2 updates"))
    }

    @Test
    fun calculatesWpmMedianAndRates() {
        val values = listOf(
            DailyUsageAggregate(
                dateKey = "2026-08-04|Asia/Shanghai",
                localDate = "2026-08-04",
                zoneId = "Asia/Shanghai",
                firstEventAtMs = 1,
                lastEventAtMs = 2,
                dictationCount = 2,
                audioDurationMs = 60_000,
                wordCount = 120,
                processingTotalMs = 4_000,
                processingSamplesMs = "1000,3000",
                polishedCount = 1,
                correctionCount = 1,
                asrNeurons = 10.0,
                polishNeurons = 2.0,
                totalNeurons = 12.0,
                estimatedCostUsd = 0.001,
            ),
        )
        val result = WoVoiceRepository.metrics(values)
        assertEquals(120, result.wpm)
        assertEquals(2_000, result.medianProcessingMs)
        assertEquals(50, result.polishedRate)
        assertEquals(50, result.correctionRate)
    }
}

package com.aliahad.wovoice

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.aliahad.wovoice.data.DailyUsageAggregate
import com.aliahad.wovoice.data.DictationRecord
import com.aliahad.wovoice.data.WoVoiceDatabase
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DataPersistenceInstrumentedTest {
    private lateinit var database: WoVoiceDatabase

    @Before
    fun setUp() {
        database = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext<Context>(),
            WoVoiceDatabase::class.java,
        ).allowMainThreadQueries().build()
    }

    @After
    fun tearDown() = database.close()

    @Test
    fun deletingHistoryRetainsAnonymousAnalytics() = runBlocking {
        val record = DictationRecord(
            requestId = "request-1",
            finalText = "Hello from WoVoice.",
            createdAtMs = 100,
            zoneId = "Asia/Shanghai",
            offsetSeconds = 28_800,
            wordCount = 3,
            audioDurationMs = 2_000,
            asrModel = "whisper-large-v3-turbo",
            polished = true,
            asrMs = 500,
            polishMs = 300,
            totalMs = 800,
            pricingVersion = "2026-07-08",
            inputTokens = 20,
            outputTokens = 8,
            asrNeurons = 1.5,
            polishNeurons = 0.5,
            totalNeurons = 2.0,
            estimatedCostUsd = 0.00002,
        )
        val aggregate = DailyUsageAggregate(
            dateKey = "2026-08-04|Asia/Shanghai",
            localDate = "2026-08-04",
            zoneId = "Asia/Shanghai",
            firstEventAtMs = 100,
            lastEventAtMs = 100,
            dictationCount = 1,
            audioDurationMs = 2_000,
            wordCount = 3,
            processingTotalMs = 800,
            processingSamplesMs = "800",
            polishedCount = 1,
            correctionCount = 0,
            asrNeurons = 1.5,
            polishNeurons = 0.5,
            totalNeurons = 2.0,
            estimatedCostUsd = 0.00002,
        )

        database.dao().recordSuccess(record, aggregate, keepHistory = true)
        val stored = database.dao().history("").single()
        database.dao().deleteRecord(stored)

        assertEquals(0, database.dao().history("").size)
        assertEquals(1, database.dao().usageSince(0).single().dictationCount)
    }
}

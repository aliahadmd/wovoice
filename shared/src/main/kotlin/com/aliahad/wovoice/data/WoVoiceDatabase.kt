package com.aliahad.wovoice.data

import androidx.room.Database
import androidx.room.RoomDatabase

@Database(
    entities = [
        DictationRecord::class,
        DailyUsageAggregate::class,
        DictionaryEntry::class,
        AnalyticsSyncEvent::class,
        EncryptedSyncOutboxItem::class,
    ],
    version = 2,
    exportSchema = true,
)
abstract class WoVoiceDatabase : RoomDatabase() {
    abstract fun dao(): WoVoiceDao

    companion object {
        const val DB_NAME = "wovoice-local.db"
    }
}


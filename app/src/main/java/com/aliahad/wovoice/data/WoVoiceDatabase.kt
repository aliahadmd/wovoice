package com.aliahad.wovoice.data

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(
    entities = [
        DictationRecord::class,
        DailyUsageAggregate::class,
        DictionaryEntry::class,
        AnalyticsSyncEvent::class,
        EncryptedSyncOutboxItem::class,
    ],
    version = 2,
    exportSchema = false,
)
abstract class WoVoiceDatabase : RoomDatabase() {
    abstract fun dao(): WoVoiceDao

    companion object {
        @Volatile private var instance: WoVoiceDatabase? = null

        fun get(context: Context): WoVoiceDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(
                context.applicationContext,
                WoVoiceDatabase::class.java,
                "wovoice-local.db",
            ).addMigrations(MIGRATION_1_2).build().also { instance = it }
        }

        private val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE dictation_records ADD COLUMN ownerAccountId TEXT")
                db.execSQL("ALTER TABLE dictation_records ADD COLUMN syncId TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE dictation_records ADD COLUMN syncVersion INTEGER NOT NULL DEFAULT 0")
                db.execSQL("ALTER TABLE dictation_records ADD COLUMN syncState TEXT NOT NULL DEFAULT 'local'")
                db.execSQL("ALTER TABLE daily_usage ADD COLUMN ownerAccountId TEXT")
                db.execSQL("ALTER TABLE dictionary_entries ADD COLUMN ownerAccountId TEXT")
                db.execSQL("ALTER TABLE dictionary_entries ADD COLUMN syncId TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE dictionary_entries ADD COLUMN syncVersion INTEGER NOT NULL DEFAULT 0")
                db.execSQL("ALTER TABLE dictionary_entries ADD COLUMN syncState TEXT NOT NULL DEFAULT 'local'")
                db.execSQL("DROP INDEX IF EXISTS index_dictionary_entries_normalizedTerm")
                db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS index_dictionary_entries_ownerAccountId_normalizedTerm ON dictionary_entries(ownerAccountId, normalizedTerm)")
                db.execSQL(
                    """CREATE TABLE IF NOT EXISTS analytics_sync_events (
                        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
                        syncId TEXT NOT NULL,
                        ownerAccountId TEXT NOT NULL,
                        createdAtMs INTEGER NOT NULL,
                        zoneId TEXT NOT NULL,
                        audioDurationMs INTEGER NOT NULL,
                        wordCount INTEGER NOT NULL,
                        processingMs INTEGER NOT NULL,
                        polished INTEGER NOT NULL,
                        corrected INTEGER NOT NULL,
                        asrNeurons REAL NOT NULL,
                        polishNeurons REAL NOT NULL,
                        estimatedCostUsd REAL NOT NULL,
                        syncVersion INTEGER NOT NULL,
                        syncState TEXT NOT NULL
                    )""",
                )
                db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS index_analytics_sync_events_syncId ON analytics_sync_events(syncId)")
                db.execSQL("CREATE INDEX IF NOT EXISTS index_analytics_sync_events_ownerAccountId_syncState ON analytics_sync_events(ownerAccountId, syncState)")
                db.execSQL(
                    """CREATE TABLE IF NOT EXISTS encrypted_sync_outbox (
                        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
                        ownerAccountId TEXT NOT NULL,
                        recordType TEXT NOT NULL,
                        recordId TEXT NOT NULL,
                        baseVersion INTEGER NOT NULL,
                        keyVersion INTEGER NOT NULL,
                        nonce TEXT NOT NULL,
                        ciphertext TEXT NOT NULL,
                        deleted INTEGER NOT NULL,
                        createdAtMs INTEGER NOT NULL
                    )""",
                )
                db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS index_encrypted_sync_outbox_ownerAccountId_recordType_recordId ON encrypted_sync_outbox(ownerAccountId, recordType, recordId)")
            }
        }
    }
}

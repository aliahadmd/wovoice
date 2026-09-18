package com.aliahad.wovoice.data

import android.content.Context
import androidx.room.Room
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import com.aliahad.wovoice.settings.SecretStore
import com.aliahad.wovoice.settings.SettingsStore
import com.aliahad.wovoice.settings.androidDeviceName
import com.aliahad.wovoice.sync.SyncCoordinator

/** Android wiring for the shared data layer: Room on the framework SQLite stack. */
object AndroidGraph {
    @Volatile private var database: WoVoiceDatabase? = null

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

    fun database(context: Context): WoVoiceDatabase = database ?: synchronized(this) {
        database ?: Room.databaseBuilder(
            context.applicationContext,
            WoVoiceDatabase::class.java,
            WoVoiceDatabase.DB_NAME,
        ).addMigrations(MIGRATION_1_2).build().also { database = it }
    }

    fun repository(context: Context): WoVoiceRepository {
        val settings = SettingsStore(context)
        return WoVoiceRepository(database(context).dao(), settings)
    }

    fun sync(context: Context): SyncCoordinator {
        val settings = SettingsStore(context)
        return SyncCoordinator.get(
            secrets = SecretStore(context),
            settings = settings,
            baseUrlProvider = { settings.workerUrl },
            deviceNameProvider = ::androidDeviceName,
            dao = database(context).dao(),
        )
    }
}

package com.aliahad.wovoice.data

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(
    entities = [DictationRecord::class, DailyUsageAggregate::class, DictionaryEntry::class],
    version = 1,
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
            ).build().also { instance = it }
        }
    }
}

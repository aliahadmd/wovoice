package com.aliahad.wovoice.sync

import androidx.room.Room
import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import com.aliahad.wovoice.account.AccountResult
import com.aliahad.wovoice.account.AccountSettings
import com.aliahad.wovoice.account.SecretNames
import com.aliahad.wovoice.account.SecretsVault
import com.aliahad.wovoice.account.SyncAccount
import com.aliahad.wovoice.data.AnalyticsPeriod
import com.aliahad.wovoice.data.WoVoiceDatabase
import com.aliahad.wovoice.data.WoVoiceRepository
import com.aliahad.wovoice.network.TranscriptionClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SyncCoordinatorTest {
    private val cloud = FakeCloud()
    private val databases = mutableListOf<WoVoiceDatabase>()

    @After
    fun close() = databases.forEach(WoVoiceDatabase::close)

    @Test
    fun dictationsTermsAndTotalsFollowTheAccountToAnotherDevice() = runBlocking {
        val phone = device()
        val mac = device()
        phone.dictate("req-1", "Meet Rahim at the clinic.")
        phone.repository.addManualTerm("Rahim")
        assertEquals(SyncResult.Success(uploaded = 3, downloaded = 0), phone.sync.syncNow())

        val pulled = mac.sync.syncNow() as SyncResult.Success
        assertEquals(3, pulled.downloaded)
        assertEquals(listOf("Meet Rahim at the clinic."), mac.repository.history().map { it.finalText })
        assertEquals(listOf("Rahim"), mac.repository.dictionary(confirmed = true).map { it.term })
        assertEquals(1L, mac.repository.dashboard(AnalyticsPeriod.ALL_TIME).aggregates.sumOf { it.dictationCount })
        // Nothing echoes back as new work on the next sync.
        assertEquals(SyncResult.Success(0, 0), phone.sync.syncNow())
    }

    @Test
    fun anUploadWhoseResponseWasLostConverges() = runBlocking {
        val phone = device()
        phone.dictate("req-1", "Hello there.")
        cloud.dropNextPushResponse = true
        assertTrue(phone.sync.syncNow() is SyncResult.Error)
        assertTrue(phone.sync.syncNow() is SyncResult.Success)
        assertEquals(SyncResult.Success(0, 0), phone.sync.syncNow())
        assertEquals(2, cloud.records.size)
    }

    @Test
    fun deletesReachOtherDevicesAndUndoBeforeSyncKeepsTheRecord() = runBlocking {
        val phone = device()
        val mac = device()
        phone.dictate("req-1", "Keep me.")
        phone.dictate("req-2", "Delete me.")
        phone.sync.syncNow()
        mac.sync.syncNow()

        val records = phone.repository.history().associateBy { it.requestId }
        phone.repository.deleteHistory(records.getValue("req-1"))
        phone.repository.restoreHistory(records.getValue("req-1"))
        phone.repository.deleteHistory(records.getValue("req-2"))
        phone.sync.syncNow()
        mac.sync.syncNow()
        assertEquals(listOf("Keep me."), mac.repository.history().map { it.finalText })
    }

    @Test
    fun turningHistorySyncOffKeepsLocalCopiesAndStopsUploads() = runBlocking {
        val phone = device()
        val mac = device()
        phone.dictate("req-1", "Private note.")
        phone.sync.syncNow()
        mac.sync.syncNow()

        assertTrue(phone.sync.updateSettings(historySyncEnabled = false) is AccountResult.Success)
        assertTrue(cloud.records.keys.none { it.startsWith("history:") })
        mac.sync.syncNow()
        assertFalse(mac.settings.historySyncEnabled)
        mac.dictate("req-2", "Stays on the Mac.")
        mac.sync.syncNow()
        assertTrue(cloud.records.keys.none { it.startsWith("history:") })
        assertEquals(2, mac.repository.history().size)

        phone.sync.updateSettings(historySyncEnabled = true)
        mac.sync.syncNow()
        assertEquals(2, cloud.records.keys.count { it.startsWith("history:") })
    }

    @Test
    fun retentionRemovesOldLocalHistory() = runBlocking {
        val phone = device()
        phone.dictate("req-old", "Old note.", createdAtMs = System.currentTimeMillis() - 40 * 86_400_000L)
        phone.dictate("req-new", "New note.")
        phone.sync.updateSettings(historyRetentionDays = 30)
        assertEquals(listOf("New note."), phone.repository.history().map { it.finalText })
        assertEquals(30, phone.settings.historyRetentionDays)
    }

    @Test
    fun resetAnalyticsAndCorrectionsReachOtherDevices() = runBlocking {
        val phone = device()
        val mac = device()
        phone.dictate("req-1", "Meet Rahim.", analyticsId = "event-1")
        phone.sync.syncNow()
        mac.sync.syncNow()
        phone.repository.noteCorrection("event-1")
        phone.sync.syncNow()
        mac.sync.syncNow()
        assertEquals(1L, mac.repository.dashboard(AnalyticsPeriod.ALL_TIME).aggregates.sumOf { it.correctionCount })

        phone.repository.resetAnalytics()
        phone.sync.syncNow()
        mac.sync.syncNow()
        assertTrue(mac.repository.dashboard(AnalyticsPeriod.ALL_TIME).aggregates.isEmpty())
    }

    @Test
    fun aFullDictionaryDoesNotBlockHistory() = runBlocking {
        val phone = device()
        cloud.dictionaryLimit = 0
        phone.repository.addManualTerm("Rahim")
        phone.dictate("req-1", "Still syncs.")
        val result = phone.sync.syncNow() as SyncResult.Success
        assertEquals("Your dictionary is full.", result.warning)
        assertTrue("history:req-1" in cloud.records)
    }

    @Test
    fun theOldVaultIsImportedOnceAndRetired() = runBlocking {
        val vaultKey = VaultCrypto.newSecret()
        val recovery = VaultCrypto.newSecret()
        val sealed = VaultCrypto.encryptRecord(
            vaultKey,
            JSONObject()
                .put("schemaVersion", 1)
                .put("text", "Only in the old vault.")
                .put("createdAtMs", 1_790_000_000_000)
                .put("zoneId", "UTC")
                .put("offsetSeconds", 0)
                .put("wordCount", 5)
                .put("audioDurationMs", 2_000)
                .toString().toByteArray(),
            ACCOUNT,
            "history",
            "vault-only",
            1,
            1,
        )
        val legacy = FakeLegacy(
            vault = VaultCrypto.wrapVaultKey(vaultKey, recovery, ACCOUNT, 1),
            records = listOf(LegacyRecord("vault-only", "history", 1, sealed.nonce, sealed.ciphertext, deleted = false)),
        )
        val mac = device(legacy)
        mac.secrets.putString(SecretNames.VAULT_KEY, VaultCrypto.encodeSecret(vaultKey))
        mac.secrets.putString(SecretNames.RECOVERY_SECRET, VaultCrypto.encodeSecret(recovery))
        mac.dictate("req-1", "Already on this Mac.")

        assertTrue(mac.sync.syncNow() is SyncResult.Success)
        assertTrue(cloud.legacyMigrationCompleted)
        assertNull(mac.secrets.getString(SecretNames.VAULT_KEY))
        assertEquals(ACCOUNT, mac.settings.cloudSyncMigratedAccount)
        assertTrue("history:vault-only" in cloud.records)
        assertTrue("history:req-1" in cloud.records)
        assertEquals(2, mac.repository.history().size)
    }

    // ---- Harness ----

    private inner class Device(
        val repository: WoVoiceRepository,
        val sync: SyncCoordinator,
        val settings: FakeSettings,
        val secrets: MemorySecrets,
    ) {
        suspend fun dictate(
            requestId: String,
            text: String,
            createdAtMs: Long? = null,
            analyticsId: String = "analytics-$requestId",
        ) {
            repository.recordSuccessfulDictation(
                result = TranscriptionClient.Result.Success(text, text.lowercase(), true, "whisper-large-v3-turbo", requestId),
                committedText = text,
                audioDurationMs = 2_000,
                keepHistory = true,
                analyticsSyncId = analyticsId,
            )
            if (createdAtMs != null) {
                val stored = repository.history().first { it.requestId == requestId }
                databases.last().dao().updateRecord(stored.copy(createdAtMs = createdAtMs))
            }
        }
    }

    private fun device(legacy: LegacyVaultApi = FakeLegacy(null, emptyList())): Device {
        val database = Room.inMemoryDatabaseBuilder<WoVoiceDatabase>()
            .setDriver(BundledSQLiteDriver())
            .setQueryCoroutineContext(Dispatchers.IO)
            .build()
        databases += database
        val settings = FakeSettings()
        val secrets = MemorySecrets()
        val sync = SyncCoordinator(FakeAccount(), cloud, legacy, secrets, settings, database.dao())
        return Device(WoVoiceRepository(database.dao(), settings), sync, settings, secrets)
    }

    private class FakeCloud : CloudSyncApi {
        val records = linkedMapOf<String, CloudRecord>()
        private val feed = linkedMapOf<String, Long>()
        private var seq = 0L
        private var historySyncEnabled = true
        private var retention: Int? = null
        private var lastConflicts: List<CloudRecord> = emptyList()
        var dropNextPushResponse = false
        var dictionaryLimit = 1_000
        var legacyMigrationCompleted = false

        private fun write(record: CloudRecord) {
            val key = "${record.type}:${record.id}"
            records[key] = record
            feed.remove(key)
            feed[key] = ++seq
        }

        private fun settingsValue() = CloudSettings(historySyncEnabled, retention, legacyVault = false)

        override fun pull(token: String, cursor: Long): AccountResult<CloudPage> {
            val page = feed.entries.filter { it.value > cursor }.sortedBy { it.value }.take(50)
            return AccountResult.Success(
                CloudPage(
                    nextCursor = page.maxOfOrNull { it.value } ?: cursor,
                    hasMore = page.size == 50,
                    records = page.map { records.getValue(it.key) },
                    settings = settingsValue(),
                ),
            )
        }

        override fun push(token: String, writes: List<CloudWrite>): AccountResult<List<AppliedSyncItem>> {
            val keys = writes.map { "${it.type}:${it.id}" }
            check(keys.toSet().size == keys.size) { "client pushed the same record twice" }
            if (!historySyncEnabled && writes.any { it.type == "history" && it.payload != null }) {
                return AccountResult.Error("HISTORY_SYNC_DISABLED", "History sync is off.", false, 409)
            }
            val conflicts = writes.filter { (records["${it.type}:${it.id}"]?.version ?: 0) != it.baseVersion }
            if (conflicts.isNotEmpty()) {
                lastConflicts = conflicts.map { records["${it.type}:${it.id}"] ?: CloudRecord(it.id, it.type, 0, false, null) }
                return AccountResult.Error("SYNC_CONFLICT", "Conflict.", false, 409)
            }
            val newTerms = writes.count { it.type == "dictionary" && it.payload != null && records["dictionary:${it.id}"] == null }
            if (newTerms > 0 && records.values.count { it.type == "dictionary" && !it.deleted } + newTerms > dictionaryLimit) {
                return AccountResult.Error("STORAGE_LIMIT_REACHED", "Your dictionary is full.", false, 413)
            }
            val applied = writes.map { value ->
                val record = CloudRecord(value.id, value.type, value.baseVersion + 1, value.payload == null, value.payload?.let { JSONObject(it.toString()) })
                write(record)
                AppliedSyncItem(record.id, record.type, record.version)
            }
            if (dropNextPushResponse) {
                dropNextPushResponse = false
                return AccountResult.Error("NETWORK_UNAVAILABLE", "Offline.", true, 0)
            }
            return AccountResult.Success(applied)
        }

        override fun conflicts(error: AccountResult.Error): List<CloudRecord> = lastConflicts

        override fun settings(token: String): AccountResult<CloudSettings> = AccountResult.Success(settingsValue())

        override fun updateSettings(
            token: String,
            historySyncEnabled: Boolean?,
            historyRetentionDays: Int?,
            clearRetention: Boolean,
        ): AccountResult<CloudSettings> {
            if (historySyncEnabled == false && this.historySyncEnabled) {
                records.keys.filter { it.startsWith("history:") }.forEach { key ->
                    records.remove(key)
                    feed.remove(key)
                }
            }
            historySyncEnabled?.let { this.historySyncEnabled = it }
            if (clearRetention) retention = null else historyRetentionDays?.let { retention = it }
            return AccountResult.Success(settingsValue())
        }

        override fun completeLegacyMigration(token: String): AccountResult<Unit> {
            legacyMigrationCompleted = true
            return AccountResult.Success(Unit)
        }
    }

    private class FakeLegacy(private val vault: WrappedVaultKey?, private val records: List<LegacyRecord>) : LegacyVaultApi {
        override fun getVault(token: String): AccountResult<WrappedVaultKey?> = AccountResult.Success(vault)
        override fun pullLegacy(token: String, cursor: Long): AccountResult<LegacyPage> =
            AccountResult.Success(LegacyPage(nextCursor = records.size.toLong(), hasMore = false, records = if (cursor == 0L) records else emptyList()))
    }

    private class FakeAccount : SyncAccount {
        override val accountId: String = ACCOUNT
        override val cloudServicesAllowed: Boolean = true
        override val restrictionMessage: String = "Restricted."
        override suspend fun validAccessToken(): AccountResult<String> = AccountResult.Success("token")
        override suspend fun refreshAfterRejected(rejectedToken: String): AccountResult<String> = AccountResult.Success("token")
    }

    private class MemorySecrets : SecretsVault {
        private val values = mutableMapOf<String, String>()
        override fun putString(name: String, value: String?) {
            if (value == null) values.remove(name) else values[name] = value
        }
        override fun getString(name: String): String? = values[name]
        override fun remove(name: String) {
            values.remove(name)
        }
        override fun contains(name: String): Boolean = name in values
    }

    private class FakeSettings : AccountSettings {
        override var accountId: String? = ACCOUNT
        override val lastAccountId: String? = ACCOUNT
        override var accountEmail: String? = "person@example.com"
        override var accountRole: String = "user"
        override var accountState: String = "active"
        override var accountSuspendedUntilMs: Long? = null
        override var accountPublicMessage: String? = null
        override var accountSupportEmail: String = "support@example.com"
        override var syncCursor: Long = 0
        override var cloudSyncMigratedAccount: String? = null
        override var historySyncEnabled: Boolean = true
        override var historyRetentionDays: Int? = null
        override var lastSyncAtMs: Long = 0
        override fun isSignedIn(): Boolean = true
        override fun clearAccount() = Unit
    }

    private companion object {
        const val ACCOUNT = "account-1"
    }
}

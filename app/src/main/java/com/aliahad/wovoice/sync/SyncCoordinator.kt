package com.aliahad.wovoice.sync

import android.content.Context
import com.aliahad.wovoice.account.AccountResult
import com.aliahad.wovoice.account.SessionManager
import com.aliahad.wovoice.data.AnalyticsSyncEvent
import com.aliahad.wovoice.data.DictationRecord
import com.aliahad.wovoice.data.DictionaryEntry
import com.aliahad.wovoice.data.DailyUsageAggregate
import com.aliahad.wovoice.data.EncryptedSyncOutboxItem
import com.aliahad.wovoice.data.SYNCED
import com.aliahad.wovoice.data.SYNC_LOCAL
import com.aliahad.wovoice.data.SYNC_QUEUED
import com.aliahad.wovoice.data.WoVoiceDatabase
import com.aliahad.wovoice.settings.SecretStore
import com.aliahad.wovoice.settings.SettingsStore
import org.json.JSONObject
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.time.Instant
import java.time.ZoneId

sealed interface VaultSetupResult {
    data object Ready : VaultSetupResult
    data class Created(val recoveryKey: String) : VaultSetupResult
    data object NeedsRecovery : VaultSetupResult
    data class Error(val message: String) : VaultSetupResult
}

sealed interface SyncResult {
    data class Success(val uploaded: Int, val downloaded: Int) : SyncResult
    data object NeedsRecovery : SyncResult
    data class Error(val message: String, val retryable: Boolean) : SyncResult
}

class SyncCoordinator private constructor(context: Context) {
    private val appContext = context.applicationContext
    private val settings = SettingsStore(appContext)
    private val secrets = SecretStore(appContext)
    private val account = SessionManager.get(appContext)
    private val client = SyncClient(settings.workerUrl)
    private val dao = WoVoiceDatabase.get(appContext).dao()
    private val syncMutex = Mutex()

    suspend fun ensureVault(): VaultSetupResult {
        if (!account.cloudServicesAllowed) {
            return VaultSetupResult.Error(restrictedMessage())
        }
        val accountId = account.accountId ?: return VaultSetupResult.Error("Sign in before setting up encrypted sync.")
        val token = when (val auth = account.validAccessToken()) {
            is AccountResult.Success -> auth.value
            is AccountResult.Error -> return VaultSetupResult.Error(auth.message)
        }
        val remote = when (val result = client.getVault(token)) {
            is AccountResult.Success -> result.value
            is AccountResult.Error -> return VaultSetupResult.Error(result.message)
        }
        val localVault = secrets.getString(SecretStore.VAULT_KEY)?.let(VaultCrypto::decodeSecret)
        if (remote != null && localVault != null) return VaultSetupResult.Ready
        if (remote != null) return VaultSetupResult.NeedsRecovery

        val vaultKey = localVault ?: VaultCrypto.newSecret()
        val recoverySecret = secrets.getString(SecretStore.RECOVERY_SECRET)
            ?.let(VaultCrypto::decodeSecret)
            ?: VaultCrypto.newSecret()
        val wrapped = VaultCrypto.wrapVaultKey(vaultKey, recoverySecret, accountId, KEY_VERSION)
        return when (val stored = client.putVault(token, wrapped, null)) {
            is AccountResult.Success -> {
                secrets.putString(SecretStore.VAULT_KEY, VaultCrypto.encodeSecret(vaultKey))
                secrets.putString(SecretStore.RECOVERY_SECRET, VaultCrypto.encodeSecret(recoverySecret))
                VaultSetupResult.Created(VaultCrypto.encodeRecoveryKey(recoverySecret))
            }
            is AccountResult.Error -> {
                if (stored.code == "SYNC_CONFLICT") VaultSetupResult.NeedsRecovery
                else VaultSetupResult.Error(stored.message)
            }
        }
    }

    suspend fun importRecoveryKey(recoveryKey: String): VaultSetupResult {
        if (!account.cloudServicesAllowed) {
            return VaultSetupResult.Error(restrictedMessage())
        }
        val accountId = account.accountId ?: return VaultSetupResult.Error("Sign in first.")
        val recoverySecret = VaultCrypto.decodeRecoveryKey(recoveryKey)
            ?: return VaultSetupResult.Error("That recovery key is invalid or mistyped.")
        val token = when (val auth = account.validAccessToken()) {
            is AccountResult.Success -> auth.value
            is AccountResult.Error -> return VaultSetupResult.Error(auth.message)
        }
        val remote = when (val result = client.getVault(token)) {
            is AccountResult.Success -> result.value
            is AccountResult.Error -> return VaultSetupResult.Error(result.message)
        } ?: return VaultSetupResult.Error("This account does not have an encrypted vault yet.")
        val vaultKey = VaultCrypto.unwrapVaultKey(remote, recoverySecret, accountId)
            ?: return VaultSetupResult.Error("The recovery key does not match this account.")
        secrets.putString(SecretStore.VAULT_KEY, VaultCrypto.encodeSecret(vaultKey))
        secrets.putString(SecretStore.RECOVERY_SECRET, VaultCrypto.encodeSecret(recoverySecret))
        return VaultSetupResult.Ready
    }

    fun recoveryKey(): String? = secrets.getString(SecretStore.RECOVERY_SECRET)
        ?.let(VaultCrypto::decodeSecret)
        ?.let(VaultCrypto::encodeRecoveryKey)

    suspend fun syncNow(): SyncResult = syncMutex.withLock { syncLocked() }

    private suspend fun syncLocked(): SyncResult {
        if (!account.cloudServicesAllowed) {
            return SyncResult.Error(restrictedMessage(), false)
        }
        val accountId = account.accountId ?: return SyncResult.Error("Sign in to synchronize.", false)
        when (val vault = ensureVault()) {
            VaultSetupResult.NeedsRecovery -> return SyncResult.NeedsRecovery
            is VaultSetupResult.Error -> return SyncResult.Error(vault.message, true)
            else -> Unit
        }
        val vaultKey = secrets.getString(SecretStore.VAULT_KEY)?.let(VaultCrypto::decodeSecret)
            ?: return SyncResult.NeedsRecovery
        var token = when (val auth = account.validAccessToken()) {
            is AccountResult.Success -> auth.value
            is AccountResult.Error -> return SyncResult.Error(auth.message, auth.retryable)
        }

        var downloaded = 0
        while (true) {
            val pageResult = client.pull(token, settings.syncCursor)
            val page = when (pageResult) {
                is AccountResult.Success -> pageResult.value
                is AccountResult.Error -> {
                    if (pageResult.code == "TOKEN_EXPIRED") {
                        token = when (val refreshed = account.refreshAfterRejected(token)) {
                            is AccountResult.Success -> refreshed.value
                            is AccountResult.Error -> return SyncResult.Error(refreshed.message, refreshed.retryable)
                        }
                        continue
                    }
                    return SyncResult.Error(pageResult.message, pageResult.retryable)
                }
            }
            page.items.forEach { item ->
                if (applyRemote(accountId, vaultKey, item)) downloaded++
            }
            settings.syncCursor = page.nextCursor
            if (!page.hasMore) break
        }

        stageLocal(accountId, vaultKey)
        val pending = dao.outbox(accountId, MAX_BATCH)
        if (pending.isEmpty()) return SyncResult.Success(0, downloaded)
        val payload = pending.map { item ->
            JSONObject()
                .put("id", item.recordId)
                .put("type", item.recordType)
                .put("baseVersion", item.baseVersion)
                .put("keyVersion", item.keyVersion)
                .put("nonce", item.nonce)
                .put("ciphertext", item.ciphertext)
                .put("deleted", item.deleted)
        }
        val pushed = client.push(token, payload)
        return when (pushed) {
            is AccountResult.Success -> {
                pushed.value.forEach { applied -> markSynced(accountId, applied) }
                dao.deleteOutbox(pending.map(EncryptedSyncOutboxItem::id))
                SyncResult.Success(pushed.value.size, downloaded)
            }
            is AccountResult.Error -> {
                if (pushed.code == "SYNC_CONFLICT") {
                    val conflicts = client.conflicts(pushed)
                    conflicts.forEach { conflict ->
                        dao.deleteOutboxRecord(accountId, conflict.type, conflict.id)
                        applyRemote(accountId, vaultKey, conflict, force = true)
                    }
                    SyncResult.Error("Encrypted changes were reconciled with another device. Sync again to continue.", true)
                } else SyncResult.Error(pushed.message, pushed.retryable)
            }
        }
    }

    private fun restrictedMessage(): String = account.accountStatus.publicMessage
        ?: "This account cannot use encrypted sync right now. Contact ${account.accountStatus.supportEmail} for help."

    private suspend fun stageLocal(accountId: String, vaultKey: ByteArray) {
        var remaining = MAX_BATCH - dao.outbox(accountId, MAX_BATCH).size
        if (remaining <= 0) return
        dao.unsyncedHistory(accountId, remaining).forEach { value ->
            stage(accountId, vaultKey, "history", value.syncId, value.syncVersion, historyJson(value))
            dao.updateHistorySync(accountId, value.syncId, SYNC_QUEUED, value.syncVersion)
            remaining--
        }
        if (remaining <= 0) return
        dao.unsyncedDictionary(accountId, remaining).forEach { value ->
            stage(accountId, vaultKey, "dictionary", value.syncId, value.syncVersion, dictionaryJson(value))
            dao.updateDictionarySync(accountId, value.syncId, SYNC_QUEUED, value.syncVersion)
            remaining--
        }
        if (remaining <= 0) return
        dao.unsyncedAnalytics(accountId, remaining).forEach { value ->
            stage(accountId, vaultKey, "analytics", value.syncId, value.syncVersion, analyticsJson(value))
            dao.updateAnalyticsSync(accountId, value.syncId, SYNC_QUEUED, value.syncVersion)
        }
    }

    private suspend fun stage(
        accountId: String,
        vaultKey: ByteArray,
        type: String,
        id: String,
        baseVersion: Int,
        json: JSONObject,
    ) {
        if (id.isBlank()) return
        val encrypted = VaultCrypto.encryptRecord(
            vaultKey,
            json.toString().toByteArray(Charsets.UTF_8),
            accountId,
            type,
            id,
            KEY_VERSION,
            SCHEMA_VERSION,
        )
        dao.upsertOutbox(
            EncryptedSyncOutboxItem(
                ownerAccountId = accountId,
                recordType = type,
                recordId = id,
                baseVersion = baseVersion,
                keyVersion = KEY_VERSION,
                nonce = encrypted.nonce,
                ciphertext = encrypted.ciphertext,
                deleted = false,
                createdAtMs = System.currentTimeMillis(),
            ),
        )
    }

    private suspend fun applyRemote(
        accountId: String,
        vaultKey: ByteArray,
        item: RemoteSyncItem,
        force: Boolean = false,
    ): Boolean {
        if (item.deleted) {
            dao.deleteOutboxRecord(accountId, item.type, item.id)
            when (item.type) {
                "history" -> dao.deleteHistoryBySyncId(accountId, item.id)
                "dictionary" -> dao.deleteDictionaryBySyncId(accountId, item.id)
                "analytics" -> dao.deleteAnalyticsBySyncId(accountId, item.id)
            }
            return true
        }
        if (item.keyVersion != KEY_VERSION || item.nonce == null || item.ciphertext == null) return false
        val plaintext = VaultCrypto.decryptRecord(
            vaultKey,
            EncryptedRecord(item.nonce, item.ciphertext),
            accountId,
            item.type,
            item.id,
            item.keyVersion,
            SCHEMA_VERSION,
        ) ?: return false
        val json = runCatching { JSONObject(plaintext.toString(Charsets.UTF_8)) }.getOrNull() ?: return false
        return when (item.type) {
            "history" -> applyHistory(accountId, item, json)
            "dictionary" -> applyDictionary(accountId, item, json, force)
            "analytics" -> applyAnalytics(accountId, item, json)
            else -> false
        }
    }

    private suspend fun applyHistory(accountId: String, remote: RemoteSyncItem, json: JSONObject): Boolean {
        val existing = dao.historyBySyncId(accountId, remote.id)
        if (existing != null) return true
        dao.insertRecord(
            DictationRecord(
                requestId = remote.id,
                finalText = json.getString("text"),
                createdAtMs = json.getLong("createdAtMs"),
                zoneId = json.getString("zoneId"),
                offsetSeconds = json.getInt("offsetSeconds"),
                wordCount = json.getInt("wordCount"),
                audioDurationMs = json.getLong("audioDurationMs"),
                asrModel = json.optString("asrModel"),
                polished = json.optBoolean("polished"),
                asrMs = json.optLong("asrMs"),
                polishMs = json.optLong("polishMs"),
                totalMs = json.optLong("totalMs"),
                pricingVersion = json.optNullableString("pricingVersion"),
                inputTokens = json.optNullableLong("inputTokens"),
                outputTokens = json.optNullableLong("outputTokens"),
                asrNeurons = json.optNullableDouble("asrNeurons"),
                polishNeurons = json.optNullableDouble("polishNeurons"),
                totalNeurons = json.optNullableDouble("totalNeurons"),
                estimatedCostUsd = json.optNullableDouble("estimatedCostUsd"),
                ownerAccountId = accountId,
                syncId = remote.id,
                syncVersion = remote.version,
                syncState = SYNCED,
            ),
        )
        return true
    }

    private suspend fun applyDictionary(
        accountId: String,
        remote: RemoteSyncItem,
        json: JSONObject,
        force: Boolean,
    ): Boolean {
        val existing = dao.dictionaryBySyncId(accountId, remote.id)
        if (!force && (existing?.syncState == SYNC_LOCAL || existing?.syncState == SYNC_QUEUED)) return false
        val term = json.getString("term")
        val value = DictionaryEntry(
            id = existing?.id ?: 0,
            term = term,
            normalizedTerm = json.getString("normalizedTerm"),
            status = json.getString("status"),
            source = json.getString("source"),
            createdAtMs = json.getLong("createdAtMs"),
            lastUsedAtMs = json.getLong("lastUsedAtMs"),
            useCount = json.getLong("useCount"),
            ownerAccountId = accountId,
            syncId = remote.id,
            syncVersion = remote.version,
            syncState = SYNCED,
        )
        if (existing == null) dao.insertDictionary(value) else dao.updateDictionary(value)
        return true
    }

    private suspend fun applyAnalytics(accountId: String, remote: RemoteSyncItem, json: JSONObject): Boolean {
        if (dao.analyticsBySyncId(accountId, remote.id) != null) return true
        val event = AnalyticsSyncEvent(
                syncId = remote.id,
                ownerAccountId = accountId,
                createdAtMs = json.getLong("createdAtMs"),
                zoneId = json.getString("zoneId"),
                audioDurationMs = json.getLong("audioDurationMs"),
                wordCount = json.getInt("wordCount"),
                processingMs = json.getLong("processingMs"),
                polished = json.optBoolean("polished"),
                corrected = json.optBoolean("corrected"),
                asrNeurons = json.optDouble("asrNeurons"),
                polishNeurons = json.optDouble("polishNeurons"),
                estimatedCostUsd = json.optDouble("estimatedCostUsd"),
                syncVersion = remote.version,
                syncState = SYNCED,
            )
        val zone = runCatching { ZoneId.of(event.zoneId) }.getOrDefault(ZoneId.systemDefault())
        val local = Instant.ofEpochMilli(event.createdAtMs).atZone(zone)
        dao.mergeRemoteAnalytics(
            event,
            DailyUsageAggregate(
                dateKey = "$accountId|${local.toLocalDate()}|${zone.id}",
                localDate = local.toLocalDate().toString(),
                zoneId = zone.id,
                firstEventAtMs = event.createdAtMs,
                lastEventAtMs = event.createdAtMs,
                dictationCount = 1,
                audioDurationMs = event.audioDurationMs,
                wordCount = event.wordCount.toLong(),
                processingTotalMs = event.processingMs,
                processingSamplesMs = event.processingMs.toString(),
                polishedCount = if (event.polished) 1 else 0,
                correctionCount = if (event.corrected) 1 else 0,
                asrNeurons = event.asrNeurons,
                polishNeurons = event.polishNeurons,
                totalNeurons = event.asrNeurons + event.polishNeurons,
                estimatedCostUsd = event.estimatedCostUsd,
                ownerAccountId = accountId,
            ),
        )
        return true
    }

    private suspend fun markSynced(accountId: String, value: AppliedSyncItem) {
        when (value.type) {
            "history" -> dao.updateHistorySync(accountId, value.id, SYNCED, value.version)
            "dictionary" -> dao.updateDictionarySync(accountId, value.id, SYNCED, value.version)
            "analytics" -> dao.updateAnalyticsSync(accountId, value.id, SYNCED, value.version)
        }
    }

    private fun historyJson(value: DictationRecord) = JSONObject()
        .put("schemaVersion", SCHEMA_VERSION)
        .put("text", value.finalText)
        .put("createdAtMs", value.createdAtMs)
        .put("zoneId", value.zoneId)
        .put("offsetSeconds", value.offsetSeconds)
        .put("wordCount", value.wordCount)
        .put("audioDurationMs", value.audioDurationMs)
        .put("asrModel", value.asrModel)
        .put("polished", value.polished)
        .put("asrMs", value.asrMs)
        .put("polishMs", value.polishMs)
        .put("totalMs", value.totalMs)
        .putNullable("pricingVersion", value.pricingVersion)
        .putNullable("inputTokens", value.inputTokens)
        .putNullable("outputTokens", value.outputTokens)
        .putNullable("asrNeurons", value.asrNeurons)
        .putNullable("polishNeurons", value.polishNeurons)
        .putNullable("totalNeurons", value.totalNeurons)
        .putNullable("estimatedCostUsd", value.estimatedCostUsd)

    private fun dictionaryJson(value: DictionaryEntry) = JSONObject()
        .put("schemaVersion", SCHEMA_VERSION)
        .put("term", value.term)
        .put("normalizedTerm", value.normalizedTerm)
        .put("status", value.status)
        .put("source", value.source)
        .put("createdAtMs", value.createdAtMs)
        .put("lastUsedAtMs", value.lastUsedAtMs)
        .put("useCount", value.useCount)

    private fun analyticsJson(value: AnalyticsSyncEvent) = JSONObject()
        .put("schemaVersion", SCHEMA_VERSION)
        .put("createdAtMs", value.createdAtMs)
        .put("zoneId", value.zoneId)
        .put("audioDurationMs", value.audioDurationMs)
        .put("wordCount", value.wordCount)
        .put("processingMs", value.processingMs)
        .put("polished", value.polished)
        .put("corrected", value.corrected)
        .put("asrNeurons", value.asrNeurons)
        .put("polishNeurons", value.polishNeurons)
        .put("estimatedCostUsd", value.estimatedCostUsd)

    private fun JSONObject.putNullable(name: String, value: Any?): JSONObject = put(name, value ?: JSONObject.NULL)
    private fun JSONObject.optNullableString(name: String): String? = if (isNull(name)) null else getString(name)
    private fun JSONObject.optNullableLong(name: String): Long? = if (isNull(name)) null else getLong(name)
    private fun JSONObject.optNullableDouble(name: String): Double? = if (isNull(name)) null else getDouble(name)

    companion object {
        private const val KEY_VERSION = 1
        private const val SCHEMA_VERSION = 1
        private const val MAX_BATCH = 100
        @Volatile private var instance: SyncCoordinator? = null

        fun get(context: Context): SyncCoordinator = instance ?: synchronized(this) {
            instance ?: SyncCoordinator(context).also { instance = it }
        }
    }
}

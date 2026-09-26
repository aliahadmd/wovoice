package com.aliahad.wovoice.sync

import com.aliahad.wovoice.account.AccountResult
import com.aliahad.wovoice.account.AccountSettings
import com.aliahad.wovoice.account.SecretNames
import com.aliahad.wovoice.account.SecretsVault
import com.aliahad.wovoice.account.SessionManager
import com.aliahad.wovoice.account.SyncAccount
import com.aliahad.wovoice.data.AnalyticsSyncEvent
import com.aliahad.wovoice.data.DailyUsageAggregate
import com.aliahad.wovoice.data.DictationRecord
import com.aliahad.wovoice.data.DictionaryEntry
import com.aliahad.wovoice.data.EncryptedSyncOutboxItem
import com.aliahad.wovoice.data.SYNCED
import com.aliahad.wovoice.data.SYNC_LOCAL
import com.aliahad.wovoice.data.SYNC_QUEUED
import com.aliahad.wovoice.data.WoVoiceDao
import com.aliahad.wovoice.data.analyticsDateKey
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject

sealed interface SyncResult {
    data class Success(val uploaded: Int, val downloaded: Int, val warning: String? = null) : SyncResult
    data class Error(val message: String, val retryable: Boolean) : SyncResult
}

/**
 * Cloud sync: history, dictionary, and analytics follow the signed-in account.
 * Records travel as plain JSON over TLS and the Worker encrypts them with the
 * account's key, so there is no vault, recovery key, or device-to-device setup.
 *
 * Each device keeps working offline; local changes are marked 'local', uploaded
 * with the version they were based on, and conflicts resolve server-wins, except
 * that a delete or an undo made on this device is re-based so it still lands.
 */
class SyncCoordinator internal constructor(
    private val account: SyncAccount,
    private val api: CloudSyncApi,
    private val legacy: LegacyVaultApi,
    private val secrets: SecretsVault,
    private val settings: AccountSettings,
    private val dao: WoVoiceDao,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val syncMutex = Mutex()

    suspend fun syncNow(): SyncResult = syncMutex.withLock { syncLocked() }

    /** Changes the account's history choices; turning history off deletes its cloud copy. */
    suspend fun updateSettings(
        historySyncEnabled: Boolean? = null,
        historyRetentionDays: Int? = null,
        clearRetention: Boolean = false,
    ): AccountResult<CloudSettings> = syncMutex.withLock {
        val accountId = account.accountId
            ?: return@withLock AccountResult.Error("AUTH_REQUIRED", "Sign in first.", false, 401)
        val session = when (val auth = account.validAccessToken()) {
            is AccountResult.Success -> Session(auth.value)
            is AccountResult.Error -> return@withLock auth
        }
        val result = session.call { api.updateSettings(it, historySyncEnabled, historyRetentionDays, clearRetention) }
        if (result is AccountResult.Success) applySettings(accountId, result.value)
        result
    }

    private suspend fun syncLocked(): SyncResult {
        if (!account.cloudServicesAllowed) return SyncResult.Error(account.restrictionMessage, false)
        val accountId = account.accountId ?: return SyncResult.Error("Sign in to sync.", false)
        val session = when (val auth = account.validAccessToken()) {
            is AccountResult.Success -> Session(auth.value)
            is AccountResult.Error -> return SyncResult.Error(auth.message, auth.retryable)
        }
        if (settings.cloudSyncMigratedAccount != accountId) {
            importLegacyVault(accountId, session)?.let { return it }
        }

        var downloaded = 0
        while (true) {
            val page = when (val result = session.call { api.pull(it, settings.syncCursor) }) {
                is AccountResult.Success -> result.value
                is AccountResult.Error -> return SyncResult.Error(result.message, result.retryable)
            }
            // Settings arrive before any upload, so a history-off choice made on
            // another device is honoured before this one sends history.
            page.settings?.let { applySettings(accountId, it) }
            page.records.forEach { record ->
                // One record that cannot be applied must not stall the feed.
                if (runCatching { applyRecord(accountId, record, force = false) }.getOrDefault(false)) downloaded++
            }
            settings.syncCursor = page.nextCursor
            if (!page.hasMore) break
        }

        val pushed = pushLocal(accountId, session)
        if (pushed is SyncResult.Success) settings.lastSyncAtMs = clock()
        return when (pushed) {
            is SyncResult.Success -> pushed.copy(downloaded = downloaded)
            is SyncResult.Error -> pushed
        }
    }

    // ---- Uploads ----

    private class Batch(
        val writes: List<CloudWrite>,
        /** The outbox row behind each tombstone in the batch, keyed by "type:id". */
        val tombstones: Map<String, EncryptedSyncOutboxItem>,
    )

    private suspend fun pushLocal(accountId: String, session: Session): SyncResult {
        var uploaded = 0
        var conflictRounds = 0
        var skipNewTerms = false
        var warning: String? = null
        repeat(MAX_PUSH_ROUNDS) {
            val batch = stageBatch(accountId, skipNewTerms)
            if (batch.writes.isEmpty()) return SyncResult.Success(uploaded, 0, warning)
            when (val result = session.call { api.push(it, batch.writes) }) {
                is AccountResult.Success -> {
                    result.value.forEach { applied -> settlePushed(accountId, batch, applied) }
                    uploaded += result.value.size
                }
                is AccountResult.Error -> {
                    // The whole batch was refused: every staged row goes back to 'local'.
                    dao.returnQueuedToLocal(accountId)
                    when (result.code) {
                        "SYNC_CONFLICT" -> {
                            val conflicts = api.conflicts(result)
                            if (conflicts.isEmpty() || ++conflictRounds > MAX_CONFLICT_ROUNDS) {
                                return SyncResult.Error("Changes from another device were merged. Sync again to finish.", true)
                            }
                            conflicts.forEach { reconcile(accountId, it, batch) }
                        }
                        "STORAGE_LIMIT_REACHED" -> {
                            // The dictionary is full: keep syncing everything else.
                            skipNewTerms = true
                            warning = result.message
                        }
                        "HISTORY_SYNC_DISABLED" -> applyHistorySyncDisabled(accountId)
                        else -> return SyncResult.Error(result.message, result.retryable)
                    }
                }
            }
        }
        return SyncResult.Success(uploaded, 0, warning)
    }

    private suspend fun stageBatch(accountId: String, skipNewTerms: Boolean): Batch {
        val writes = mutableListOf<CloudWrite>()
        val tombstones = mutableMapOf<String, EncryptedSyncOutboxItem>()
        dao.outboxTombstones(accountId, MAX_BATCH).forEach { item ->
            if (item.recordType == TYPE_HISTORY && !settings.historySyncEnabled) {
                // The account keeps no history in the cloud; there is nothing to delete.
                dao.deleteOutbox(listOf(item.id))
                return@forEach
            }
            writes += CloudWrite(item.recordId, item.recordType, item.baseVersion, null)
            tombstones["${item.recordType}:${item.recordId}"] = item
        }
        fun room() = MAX_BATCH - writes.size
        fun queued(type: String, id: String) = "$type:$id" in tombstones
        if (settings.historySyncEnabled && room() > 0) {
            dao.unsyncedHistory(accountId, room()).filterNot { queued(TYPE_HISTORY, it.syncId) }.forEach { value ->
                if (value.syncId.isBlank()) return@forEach
                dao.updateHistorySync(accountId, value.syncId, SYNC_QUEUED, value.syncVersion)
                writes += CloudWrite(value.syncId, TYPE_HISTORY, value.syncVersion, historyJson(value))
            }
        }
        if (room() > 0) {
            dao.unsyncedDictionary(accountId, room())
                .filterNot { queued(TYPE_DICTIONARY, it.syncId) || (skipNewTerms && it.syncVersion == 0) }
                .forEach { value ->
                    if (value.syncId.isBlank()) return@forEach
                    dao.updateDictionarySync(accountId, value.syncId, SYNC_QUEUED, value.syncVersion)
                    writes += CloudWrite(value.syncId, TYPE_DICTIONARY, value.syncVersion, dictionaryJson(value))
                }
        }
        if (room() > 0) {
            dao.unsyncedAnalytics(accountId, room()).filterNot { queued(TYPE_ANALYTICS, it.syncId) }.forEach { value ->
                dao.updateAnalyticsSync(accountId, value.syncId, SYNC_QUEUED, value.syncVersion)
                writes += CloudWrite(value.syncId, TYPE_ANALYTICS, value.syncVersion, analyticsJson(value))
            }
        }
        return Batch(writes, tombstones)
    }

    private suspend fun settlePushed(accountId: String, batch: Batch, applied: AppliedSyncItem) {
        batch.tombstones["${applied.type}:${applied.id}"]?.let { tombstone ->
            dao.deleteOutbox(listOf(tombstone.id))
            return
        }
        when (applied.type) {
            TYPE_HISTORY -> dao.markHistoryPushed(accountId, applied.id, applied.version)
            TYPE_DICTIONARY -> dao.markDictionaryPushed(accountId, applied.id, applied.version)
            TYPE_ANALYTICS -> dao.markAnalyticsPushed(accountId, applied.id, applied.version)
        }
    }

    /** Resolves one refused write against the server's current copy of the record. */
    private suspend fun reconcile(accountId: String, remote: CloudRecord, batch: Batch) {
        val tombstone = batch.tombstones["${remote.type}:${remote.id}"]
        if (tombstone != null) {
            if (remote.version > 0 && !remote.deleted) {
                // The user deleted it here: re-base the deletion so it still lands.
                dao.upsertOutbox(tombstone.copy(id = 0, baseVersion = remote.version))
            } else {
                dao.deleteOutbox(listOf(tombstone.id))
            }
            return
        }
        when {
            // The server has no copy: upload again as a new record.
            remote.version == 0 -> setSyncState(accountId, remote.type, remote.id, SYNC_LOCAL, 0)
            // A local write against a server deletion is an undo or edit made here: keep it.
            remote.deleted -> setSyncState(accountId, remote.type, remote.id, SYNC_LOCAL, remote.version)
            else -> applyRecord(accountId, remote, force = true)
        }
    }

    private suspend fun setSyncState(accountId: String, type: String, id: String, state: String, version: Int) {
        when (type) {
            TYPE_HISTORY -> dao.updateHistorySync(accountId, id, state, version)
            TYPE_DICTIONARY -> dao.updateDictionarySync(accountId, id, state, version)
            TYPE_ANALYTICS -> dao.updateAnalyticsSync(accountId, id, state, version)
        }
    }

    // ---- Settings ----

    private suspend fun applySettings(accountId: String, value: CloudSettings) {
        if (settings.historySyncEnabled && !value.historySyncEnabled) applyHistorySyncDisabled(accountId)
        settings.historySyncEnabled = value.historySyncEnabled
        settings.historyRetentionDays = value.historyRetentionDays
        // The server deletes expired cloud history itself; this covers copies that
        // were never uploaded (or when history sync is off).
        value.historyRetentionDays?.let { days -> dao.deleteHistoryBefore(accountId, clock() - days * DAY_MS) }
    }

    private suspend fun applyHistorySyncDisabled(accountId: String) {
        settings.historySyncEnabled = false
        // The cloud copy is gone; mark local history unsynced so turning the
        // setting back on uploads it again.
        dao.markHistoryUnsynced(accountId)
        dao.deleteOutboxType(accountId, TYPE_HISTORY)
    }

    // ---- Downloads ----

    private suspend fun applyRecord(accountId: String, record: CloudRecord, force: Boolean): Boolean {
        if (record.deleted) {
            dao.deleteOutboxRecord(accountId, record.type, record.id)
            when (record.type) {
                TYPE_HISTORY -> {
                    dao.historyBySyncId(accountId, record.id) ?: return false
                    dao.deleteHistoryBySyncId(accountId, record.id)
                }
                TYPE_DICTIONARY -> {
                    dao.dictionaryBySyncId(accountId, record.id) ?: return false
                    dao.deleteDictionaryBySyncId(accountId, record.id)
                }
                TYPE_ANALYTICS -> {
                    val event = dao.analyticsBySyncId(accountId, record.id) ?: return false
                    dao.removeAnalyticsEvent(event, analyticsDateKey(accountId, event.createdAtMs, event.zoneId))
                }
                else -> return false
            }
            return true
        }
        val json = record.payload ?: return false
        // A delete made here and not yet uploaded outranks incoming content; the
        // upload re-bases it if the server moved on.
        if (!force && dao.outboxRecord(accountId, record.type, record.id)?.deleted == true) return false
        return when (record.type) {
            TYPE_HISTORY -> applyHistory(accountId, record.id, record.version, json, force)
            TYPE_DICTIONARY -> applyDictionary(accountId, record.id, record.version, json, force)
            TYPE_ANALYTICS -> applyAnalytics(accountId, record.id, record.version, json, force)
            else -> false
        }
    }

    private suspend fun applyHistory(accountId: String, id: String, version: Int, json: JSONObject, force: Boolean): Boolean {
        if (!settings.historySyncEnabled && !force) return false
        val existing = dao.historyBySyncId(accountId, id)
        if (existing != null && !force) {
            // Equal means this device already holds that version (often its own upload echoing back).
            if (version == existing.syncVersion) return false
            // A local edit not yet uploaded keeps its content until the upload settles.
            if (existing.syncState == SYNC_LOCAL || existing.syncState == SYNC_QUEUED) return false
        }
        val record = DictationRecord(
            id = existing?.id ?: 0,
            requestId = id,
            finalText = json.getString("text"),
            createdAtMs = json.getLong("createdAtMs"),
            zoneId = json.optString("zoneId", "UTC"),
            offsetSeconds = json.optInt("offsetSeconds"),
            wordCount = json.optInt("wordCount"),
            audioDurationMs = json.optLong("audioDurationMs"),
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
            syncId = id,
            syncVersion = version,
            syncState = SYNCED,
        )
        if (existing == null) dao.insertRecord(record) else dao.updateRecord(record)
        return true
    }

    private suspend fun applyDictionary(accountId: String, id: String, version: Int, json: JSONObject, force: Boolean): Boolean {
        val existing = dao.dictionaryBySyncId(accountId, id)
        if (existing != null && !force) {
            if (version == existing.syncVersion) return false
            if (existing.syncState == SYNC_LOCAL || existing.syncState == SYNC_QUEUED) return false
        }
        val normalizedTerm = json.getString("normalizedTerm")
        val clash = dao.dictionaryByNormalized(accountId, normalizedTerm)?.takeIf { it.syncId != id }
        if (clash != null) {
            // The same term already exists here under another sync id (added on two
            // devices, or the target of a rename). A never-uploaded local copy yields
            // to the synced one; a synced one stays, since both can't share the index.
            if (clash.syncVersion > 0) return false
            dao.deleteOutboxRecord(accountId, TYPE_DICTIONARY, clash.syncId)
            dao.deleteDictionary(clash)
        }
        val value = DictionaryEntry(
            id = existing?.id ?: 0,
            term = json.getString("term"),
            normalizedTerm = normalizedTerm,
            status = json.optString("status", DictionaryEntry.STATUS_CONFIRMED),
            source = json.optString("source", DictionaryEntry.SOURCE_MANUAL),
            createdAtMs = json.optLong("createdAtMs"),
            lastUsedAtMs = json.optLong("lastUsedAtMs"),
            useCount = json.optLong("useCount"),
            ownerAccountId = accountId,
            syncId = id,
            syncVersion = version,
            syncState = SYNCED,
        )
        if (existing == null) dao.insertDictionary(value) else dao.updateDictionary(value)
        return true
    }

    private suspend fun applyAnalytics(accountId: String, id: String, version: Int, json: JSONObject, force: Boolean): Boolean {
        val existing = dao.analyticsBySyncId(accountId, id)
        if (existing != null) {
            if (!force && (existing.syncState == SYNC_LOCAL || existing.syncState == SYNC_QUEUED)) return false
            if (!force && version == existing.syncVersion) return false
            // The event already counts in daily_usage; only its correction flag can
            // change later, and the day's correction count moves with it.
            dao.setEventCorrected(
                existing.copy(syncVersion = version),
                corrected = json.optBoolean("corrected"),
                dateKey = analyticsDateKey(accountId, existing.createdAtMs, existing.zoneId),
                syncState = SYNCED,
            )
            return true
        }
        val event = AnalyticsSyncEvent(
            syncId = id,
            ownerAccountId = accountId,
            createdAtMs = json.getLong("createdAtMs"),
            zoneId = json.optString("zoneId", "UTC"),
            audioDurationMs = json.optLong("audioDurationMs"),
            wordCount = json.optInt("wordCount"),
            processingMs = json.optLong("processingMs"),
            polished = json.optBoolean("polished"),
            corrected = json.optBoolean("corrected"),
            // optDouble without a fallback yields NaN for a missing key, which
            // would poison every dashboard total for that day.
            asrNeurons = json.optDouble("asrNeurons", 0.0),
            polishNeurons = json.optDouble("polishNeurons", 0.0),
            estimatedCostUsd = json.optDouble("estimatedCostUsd", 0.0),
            syncVersion = version,
            syncState = SYNCED,
        )
        val dateKey = analyticsDateKey(accountId, event.createdAtMs, event.zoneId)
        val (_, localDate, zoneId) = dateKey.split('|', limit = 3)
        dao.mergeRemoteAnalytics(
            event,
            DailyUsageAggregate(
                dateKey = dateKey,
                localDate = localDate,
                zoneId = zoneId,
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

    // ---- One-time import of the old recovery-key vault ----

    /**
     * Moves this device onto cloud sync once per account. A device that still
     * holds the old vault key first merges the vault's records into local data
     * (the only copy of records made on devices that are gone), reports the move
     * so the server can retire the vault, and forgets the key. Every local record
     * is then uploaded fresh, since the cloud starts empty.
     */
    private suspend fun importLegacyVault(accountId: String, session: Session): SyncResult.Error? {
        val vaultKey = secrets.getString(SecretNames.VAULT_KEY)?.let(VaultCrypto::decodeSecret)
        val recovery = secrets.getString(SecretNames.RECOVERY_SECRET)?.let(VaultCrypto::decodeSecret)
        var imported = false
        if (vaultKey != null && recovery != null) {
            when (val vault = session.call { legacy.getVault(it) }) {
                is AccountResult.Success -> {
                    val unwrapped = vault.value?.let { VaultCrypto.unwrapVaultKey(it, recovery, accountId) }
                    if (unwrapped != null && unwrapped.contentEquals(vaultKey)) {
                        var cursor = 0L
                        while (true) {
                            val page = when (val result = session.call { legacy.pullLegacy(it, cursor) }) {
                                is AccountResult.Success -> result.value
                                is AccountResult.Error -> return SyncResult.Error(result.message, result.retryable)
                            }
                            page.records.forEach { runCatching { importLegacyRecord(accountId, vaultKey, it) } }
                            cursor = page.nextCursor
                            if (!page.hasMore) break
                        }
                        imported = true
                    }
                }
                // Another device already moved this account; the vault is closed.
                is AccountResult.Error -> if (vault.code != "UPGRADE_REQUIRED") {
                    return SyncResult.Error(vault.message, vault.retryable)
                }
            }
        }
        if (imported) {
            when (val done = session.call { api.completeLegacyMigration(it) }) {
                is AccountResult.Success -> Unit
                is AccountResult.Error -> return SyncResult.Error(done.message, done.retryable)
            }
        }
        dao.resetSyncState(accountId)
        settings.syncCursor = 0
        secrets.remove(SecretNames.VAULT_KEY)
        secrets.remove(SecretNames.RECOVERY_SECRET)
        settings.cloudSyncMigratedAccount = accountId
        return null
    }

    private suspend fun importLegacyRecord(accountId: String, vaultKey: ByteArray, record: LegacyRecord) {
        if (record.deleted) {
            applyRecord(accountId, CloudRecord(record.id, record.type, 0, deleted = true, payload = null), force = true)
            return
        }
        if (record.keyVersion != LEGACY_KEY_VERSION || record.nonce == null || record.ciphertext == null) return
        val plaintext = VaultCrypto.decryptRecord(
            vaultKey,
            EncryptedRecord(record.nonce, record.ciphertext),
            accountId,
            record.type,
            record.id,
            record.keyVersion,
            LEGACY_SCHEMA_VERSION,
        ) ?: return
        val json = JSONObject(plaintext.toString(Charsets.UTF_8))
        // Local copies win: they are at least as new as anything in the vault.
        when (record.type) {
            TYPE_HISTORY -> if (dao.historyBySyncId(accountId, record.id) == null) {
                applyHistory(accountId, record.id, 0, json, force = true)
            }
            TYPE_DICTIONARY -> if (dao.dictionaryBySyncId(accountId, record.id) == null) {
                applyDictionary(accountId, record.id, 0, json, force = false)
            }
            TYPE_ANALYTICS -> if (dao.analyticsBySyncId(accountId, record.id) == null) {
                applyAnalytics(accountId, record.id, 0, json, force = false)
            }
        }
    }

    // ---- Tokens ----

    private inner class Session(var token: String) {
        /** Runs [request]; an expired access token is refreshed once and the request retried. */
        suspend fun <T> call(request: (String) -> AccountResult<T>): AccountResult<T> {
            val first = request(token)
            if (first !is AccountResult.Error || first.code != "TOKEN_EXPIRED") return first
            return when (val refreshed = account.refreshAfterRejected(token)) {
                is AccountResult.Success -> {
                    token = refreshed.value
                    request(token)
                }
                is AccountResult.Error -> refreshed
            }
        }
    }

    // ---- Payloads ----

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
    private fun JSONObject.optNullableString(name: String): String? = if (!has(name) || isNull(name)) null else getString(name)
    private fun JSONObject.optNullableLong(name: String): Long? = if (!has(name) || isNull(name)) null else getLong(name)
    private fun JSONObject.optNullableDouble(name: String): Double? = if (!has(name) || isNull(name)) null else getDouble(name)

    companion object {
        private const val TYPE_HISTORY = "history"
        private const val TYPE_DICTIONARY = "dictionary"
        private const val TYPE_ANALYTICS = "analytics"
        private const val SCHEMA_VERSION = 1
        private const val LEGACY_KEY_VERSION = 1
        private const val LEGACY_SCHEMA_VERSION = 1
        private const val MAX_BATCH = 100
        // Up to 2,000 uploads per sync; anything beyond waits for the next one.
        private const val MAX_PUSH_ROUNDS = 20
        private const val MAX_CONFLICT_ROUNDS = 3
        private const val DAY_MS = 86_400_000L

        @Volatile private var instance: SyncCoordinator? = null

        /**
         * Idempotent singleton; each platform supplies its own secure storage,
         * settings, worker/device identity, and Room DAO.
         */
        fun get(
            secrets: SecretsVault,
            settings: AccountSettings,
            baseUrlProvider: () -> String,
            deviceNameProvider: () -> String,
            dao: WoVoiceDao,
        ): SyncCoordinator = instance ?: synchronized(this) {
            instance ?: run {
                val client = SyncClient(baseUrlProvider)
                SyncCoordinator(
                    account = SessionManager.get(settings, secrets, baseUrlProvider, deviceNameProvider),
                    api = client,
                    legacy = client,
                    secrets = secrets,
                    settings = settings,
                    dao = dao,
                )
            }.also { instance = it }
        }
    }
}

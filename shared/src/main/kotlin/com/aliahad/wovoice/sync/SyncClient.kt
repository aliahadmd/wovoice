package com.aliahad.wovoice.sync

import com.aliahad.wovoice.account.AccountResult
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL

/** One cloud-sync record as the server returns it: plain payload, or null when deleted. */
data class CloudRecord(
    val id: String,
    val type: String,
    val version: Int,
    val deleted: Boolean,
    val payload: JSONObject?,
)

data class CloudSettings(
    val historySyncEnabled: Boolean,
    val historyRetentionDays: Int?,
    /** The account still has an old recovery-key vault that no device has imported. */
    val legacyVault: Boolean,
)

data class CloudPage(
    val nextCursor: Long,
    val hasMore: Boolean,
    val records: List<CloudRecord>,
    val settings: CloudSettings?,
)

data class AppliedSyncItem(val id: String, val type: String, val version: Int)

/** A record to upload: a payload, or a deletion when [payload] is null. */
data class CloudWrite(val id: String, val type: String, val baseVersion: Int, val payload: JSONObject?)

/** Cloud sync (v2): the Worker encrypts records with the account's key; devices only sign in. */
interface CloudSyncApi {
    fun pull(token: String, cursor: Long): AccountResult<CloudPage>
    fun push(token: String, writes: List<CloudWrite>): AccountResult<List<AppliedSyncItem>>
    fun conflicts(error: AccountResult.Error): List<CloudRecord>
    fun settings(token: String): AccountResult<CloudSettings>
    fun updateSettings(token: String, historySyncEnabled: Boolean?, historyRetentionDays: Int?, clearRetention: Boolean): AccountResult<CloudSettings>
    fun completeLegacyMigration(token: String): AccountResult<Unit>
}

// Old recovery-key vault (v1), read once per device to import its records.
data class LegacyRecord(
    val id: String,
    val type: String,
    val keyVersion: Int,
    val nonce: String?,
    val ciphertext: String?,
    val deleted: Boolean,
)
data class LegacyPage(val nextCursor: Long, val hasMore: Boolean, val records: List<LegacyRecord>)

interface LegacyVaultApi {
    fun getVault(token: String): AccountResult<WrappedVaultKey?>
    fun pullLegacy(token: String, cursor: Long): AccountResult<LegacyPage>
}

class SyncClient(private val baseUrlProvider: () -> String) : CloudSyncApi, LegacyVaultApi {
    override fun pull(token: String, cursor: Long): AccountResult<CloudPage> = request(
        "/v2/sync?cursor=${cursor.coerceAtLeast(0)}&limit=$PULL_PAGE_SIZE",
        "GET",
        token,
    ) { json ->
        val array = json.getJSONArray("items")
        CloudPage(
            nextCursor = json.getLong("nextCursor"),
            hasMore = json.optBoolean("hasMore"),
            records = buildList(array.length()) {
                repeat(array.length()) { index -> add(parseRecord(array.getJSONObject(index))) }
            },
            settings = json.optJSONObject("settings")?.let(::parseSettings),
        )
    }

    override fun push(token: String, writes: List<CloudWrite>): AccountResult<List<AppliedSyncItem>> = request(
        "/v2/sync/batch",
        "POST",
        token,
        JSONObject().put(
            "items",
            JSONArray(
                writes.map { write ->
                    JSONObject()
                        .put("id", write.id)
                        .put("type", write.type)
                        .put("baseVersion", write.baseVersion)
                        .put("deleted", write.payload == null)
                        .apply { write.payload?.let { put("payload", it) } }
                },
            ),
        ),
    ) { json ->
        val array = json.getJSONArray("applied")
        buildList(array.length()) {
            repeat(array.length()) { index ->
                val value = array.getJSONObject(index)
                add(AppliedSyncItem(value.getString("id"), value.getString("type"), value.getInt("version")))
            }
        }
    }

    override fun conflicts(error: AccountResult.Error): List<CloudRecord> = runCatching {
        val array = JSONObject(error.payload ?: return emptyList()).getJSONArray("conflicts")
        buildList(array.length()) { repeat(array.length()) { index -> add(parseRecord(array.getJSONObject(index))) } }
    }.getOrDefault(emptyList())

    override fun settings(token: String): AccountResult<CloudSettings> =
        request("/v2/sync/settings", "GET", token) { parseSettings(it.getJSONObject("settings")) }

    override fun updateSettings(
        token: String,
        historySyncEnabled: Boolean?,
        historyRetentionDays: Int?,
        clearRetention: Boolean,
    ): AccountResult<CloudSettings> = request(
        "/v2/sync/settings",
        "PUT",
        token,
        JSONObject().apply {
            historySyncEnabled?.let { put("historySyncEnabled", it) }
            if (clearRetention) put("historyRetentionDays", JSONObject.NULL)
            else historyRetentionDays?.let { put("historyRetentionDays", it) }
        },
    ) { parseSettings(it.getJSONObject("settings")) }

    override fun completeLegacyMigration(token: String): AccountResult<Unit> =
        request("/v2/sync/migration", "POST", token, JSONObject()) { }

    override fun getVault(token: String): AccountResult<WrappedVaultKey?> = request("/v1/sync/vault", "GET", token) { json ->
        if (json.isNull("vault")) null else json.getJSONObject("vault").let {
            WrappedVaultKey(it.getString("wrappedKey"), it.getString("nonce"), it.getInt("keyVersion"))
        }
    }

    override fun pullLegacy(token: String, cursor: Long): AccountResult<LegacyPage> = request(
        "/v1/sync?cursor=${cursor.coerceAtLeast(0)}&limit=$LEGACY_PAGE_SIZE",
        "GET",
        token,
    ) { json ->
        val array = json.getJSONArray("items")
        LegacyPage(
            nextCursor = json.getLong("nextCursor"),
            hasMore = json.optBoolean("hasMore"),
            records = buildList(array.length()) {
                repeat(array.length()) { index ->
                    val value = array.getJSONObject(index)
                    add(
                        LegacyRecord(
                            id = value.getString("id"),
                            type = value.getString("type"),
                            keyVersion = value.getInt("keyVersion"),
                            nonce = value.optString("nonce").takeIf(String::isNotBlank),
                            ciphertext = value.optString("ciphertext").takeIf(String::isNotBlank),
                            deleted = value.optBoolean("deleted"),
                        ),
                    )
                }
            },
        )
    }

    private fun parseRecord(value: JSONObject) = CloudRecord(
        id = value.getString("id"),
        type = value.getString("type"),
        version = value.optInt("version"),
        deleted = value.optBoolean("deleted"),
        payload = value.optJSONObject("payload"),
    )

    private fun parseSettings(value: JSONObject) = CloudSettings(
        historySyncEnabled = value.optBoolean("historySyncEnabled", true),
        historyRetentionDays = if (value.isNull("historyRetentionDays")) null else value.optInt("historyRetentionDays"),
        legacyVault = value.optBoolean("legacyVault"),
    )

    private fun <T> request(
        path: String,
        method: String,
        token: String,
        body: JSONObject? = null,
        parser: (JSONObject) -> T,
    ): AccountResult<T> {
        var connection: HttpURLConnection? = null
        return try {
            connection = endpoint(path).openConnection() as HttpURLConnection
            connection.requestMethod = method
            connection.connectTimeout = 15_000
            connection.readTimeout = 25_000
            connection.useCaches = false
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("Authorization", "Bearer $token")
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            }
            val status = connection.responseCode
            val text = read(connection, status)
            if (status in 200..299) {
                AccountResult.Success(parser(if (text.isBlank()) JSONObject() else JSONObject(text)))
            } else parseError(text, status)
        } catch (_: Exception) {
            AccountResult.Error("NETWORK_UNAVAILABLE", "Sync could not reach WoVoice.", true, 0)
        } finally {
            connection?.disconnect()
        }
    }

    private fun endpoint(path: String): URL {
        val base = URI(baseUrlProvider().trimEnd('/'))
        require(base.scheme.equals("https", true) && !base.host.isNullOrBlank())
        return URI("${base.toASCIIString()}$path").toURL()
    }

    private fun read(connection: HttpURLConnection, status: Int): String {
        val stream = if (status in 200..299) connection.inputStream else connection.errorStream
        stream ?: return ""
        return BufferedInputStream(stream).reader(Charsets.UTF_8).use { reader ->
            val output = StringBuilder()
            val buffer = CharArray(4_096)
            while (true) {
                val count = reader.read(buffer, 0, buffer.size)
                if (count < 0) break
                output.append(buffer, 0, count)
                check(output.length <= MAX_RESPONSE_CHARS) { "Sync response exceeds $MAX_RESPONSE_CHARS characters" }
            }
            output.toString()
        }
    }

    private fun parseError(body: String, status: Int): AccountResult.Error = runCatching {
        val error = JSONObject(body).optJSONObject("error")
        AccountResult.Error(
            // optString returns "" (not null) for a missing key, which used to
            // surface as an empty error code nothing could match on.
            error?.optString("code")?.takeIf(String::isNotBlank) ?: "HTTP_$status",
            error?.optString("message")?.takeIf(String::isNotBlank) ?: "Sync failed ($status).",
            error?.optBoolean("retryable", status >= 500) ?: (status >= 500),
            status,
            body,
        )
    }.getOrElse { AccountResult.Error("HTTP_$status", "Sync failed ($status).", status >= 500, status) }

    private companion object {
        // Pages are sized so a page of maximum-size records (32 KB payloads, or 90,000
        // ciphertext chars in the old vault) fits the response cap; an oversized page
        // failed to parse on every retry and wedged the cursor for good.
        const val PULL_PAGE_SIZE = 50
        const val LEGACY_PAGE_SIZE = 40
        const val MAX_RESPONSE_CHARS = 4_194_304
    }
}

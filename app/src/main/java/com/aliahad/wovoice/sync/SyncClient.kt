package com.aliahad.wovoice.sync

import com.aliahad.wovoice.account.AccountResult
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL

data class RemoteSyncItem(
    val id: String,
    val type: String,
    val version: Int,
    val keyVersion: Int,
    val nonce: String?,
    val ciphertext: String?,
    val deleted: Boolean,
)

data class SyncPage(val nextCursor: Long, val hasMore: Boolean, val items: List<RemoteSyncItem>)
data class AppliedSyncItem(val id: String, val type: String, val version: Int)

class SyncClient(private val baseUrl: String) {
    fun getVault(token: String): AccountResult<WrappedVaultKey?> = request("/v1/sync/vault", "GET", token) { json ->
        if (json.isNull("vault")) null else json.getJSONObject("vault").let {
            WrappedVaultKey(it.getString("wrappedKey"), it.getString("nonce"), it.getInt("keyVersion"))
        }
    }

    fun putVault(token: String, value: WrappedVaultKey, expectedKeyVersion: Int?): AccountResult<Int> = request(
        "/v1/sync/vault",
        "PUT",
        token,
        JSONObject()
            .put("wrappedKey", value.wrappedKey)
            .put("nonce", value.nonce)
            .put("keyVersion", value.keyVersion)
            .put("expectedKeyVersion", expectedKeyVersion),
    ) { it.getInt("keyVersion") }

    fun pull(token: String, cursor: Long): AccountResult<SyncPage> = request(
        "/v1/sync?cursor=${cursor.coerceAtLeast(0)}&limit=100",
        "GET",
        token,
    ) { json ->
        val array = json.getJSONArray("items")
        SyncPage(
            nextCursor = json.getLong("nextCursor"),
            hasMore = json.optBoolean("hasMore"),
            items = buildList(array.length()) {
                repeat(array.length()) { index -> add(parseRemote(array.getJSONObject(index))) }
            },
        )
    }

    fun push(token: String, items: List<JSONObject>): AccountResult<List<AppliedSyncItem>> = request(
        "/v1/sync/batch",
        "POST",
        token,
        JSONObject().put("items", JSONArray(items)),
    ) { json ->
        val array = json.getJSONArray("applied")
        buildList(array.length()) {
            repeat(array.length()) { index ->
                val value = array.getJSONObject(index)
                add(AppliedSyncItem(value.getString("id"), value.getString("type"), value.getInt("version")))
            }
        }
    }

    fun conflicts(error: AccountResult.Error): List<RemoteSyncItem> = runCatching {
        val array = JSONObject(error.payload ?: return emptyList()).getJSONArray("conflicts")
        buildList(array.length()) {
            repeat(array.length()) { index ->
                val value = array.getJSONObject(index)
                if (value.optInt("version") > 0 && value.has("keyVersion")) add(parseRemote(value))
            }
        }
    }.getOrDefault(emptyList())

    private fun parseRemote(value: JSONObject) = RemoteSyncItem(
        id = value.getString("id"),
        type = value.getString("type"),
        version = value.getInt("version"),
        keyVersion = value.getInt("keyVersion"),
        nonce = value.optString("nonce").takeIf(String::isNotBlank),
        ciphertext = value.optString("ciphertext").takeIf(String::isNotBlank),
        deleted = value.optBoolean("deleted"),
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
                connection.outputStream.use { it.write(body.toString().toByteArray()) }
            }
            val status = connection.responseCode
            val text = read(connection, status)
            if (status in 200..299) AccountResult.Success(parser(JSONObject(text))) else parseError(text, status)
        } catch (_: Exception) {
            AccountResult.Error("NETWORK_UNAVAILABLE", "Encrypted sync could not reach WoVoice.", true, 0)
        } finally {
            connection?.disconnect()
        }
    }

    private fun endpoint(path: String): URL {
        val base = URI(baseUrl.trimEnd('/'))
        require(base.scheme.equals("https", true) && !base.host.isNullOrBlank())
        return URI("${base.toASCIIString()}$path").toURL()
    }

    private fun read(connection: HttpURLConnection, status: Int): String {
        val stream = if (status in 200..299) connection.inputStream else connection.errorStream
        stream ?: return "{}"
        return BufferedInputStream(stream).reader(Charsets.UTF_8).use { reader ->
            val output = StringBuilder()
            val buffer = CharArray(4_096)
            while (output.length < MAX_RESPONSE_CHARS) {
                val count = reader.read(buffer, 0, minOf(buffer.size, MAX_RESPONSE_CHARS - output.length))
                if (count < 0) break
                output.append(buffer, 0, count)
            }
            output.toString()
        }
    }

    private fun parseError(body: String, status: Int): AccountResult.Error = runCatching {
        val error = JSONObject(body).optJSONObject("error")
        AccountResult.Error(
            error?.optString("code") ?: "HTTP_$status",
            error?.optString("message") ?: "Encrypted sync failed ($status).",
            error?.optBoolean("retryable", status >= 500) ?: (status >= 500),
            status,
            body,
        )
    }.getOrElse { AccountResult.Error("HTTP_$status", "Encrypted sync failed ($status).", status >= 500, status) }

    private companion object {
        const val MAX_RESPONSE_CHARS = 1_048_576
    }
}

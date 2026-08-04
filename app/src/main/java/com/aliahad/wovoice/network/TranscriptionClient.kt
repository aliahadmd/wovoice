package com.aliahad.wovoice.network

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference

class TranscriptionClient {
    private val activeConnection = AtomicReference<HttpURLConnection?>()

    sealed interface Result {
        data class Success(
            val text: String,
            val rawText: String,
            val polished: Boolean,
            val model: String,
            val requestId: String = "",
            val timings: Timings = Timings(),
            val usage: Usage? = null,
        ) : Result

        data class Error(val message: String, val retryable: Boolean) : Result
    }

    data class Timings(
        val asr: Long = 0,
        val polish: Long = 0,
        val total: Long = 0,
    )

    data class Usage(
        val pricingVersion: String,
        val audioSeconds: Double,
        val inputTokens: Long,
        val outputTokens: Long,
        val asrNeurons: Double,
        val polishNeurons: Double,
        val totalNeurons: Double,
        val estimatedCostUsd: Double,
    )

    fun testConnection(baseUrl: String, token: String): Result {
        val url = endpoint(baseUrl, "/v1/health") ?: return invalidUrl()
        val connection = open(url, token, "GET") ?: return invalidUrl()
        return execute(connection) { responseCode, body ->
            if (responseCode in 200..299 && JSONObject(body).optBoolean("ok")) {
                Result.Success("Connected", "", false, "")
            } else parseError(body, responseCode)
        }
    }

    fun transcribe(
        baseUrl: String,
        token: String,
        audioFile: File,
        sentenceStart: Boolean,
        glossary: List<String>,
    ): Result {
        val url = endpoint(baseUrl, "/v1/transcriptions") ?: return invalidUrl()
        val boundary = "WoVoice-${UUID.randomUUID()}"
        val connection = open(url, token, "POST") ?: return invalidUrl()
        connection.setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
        connection.doOutput = true
        connection.setChunkedStreamingMode(32 * 1024)

        return try {
            activeConnection.set(connection)
            BufferedOutputStream(connection.outputStream).use { output ->
                writeTextPart(
                    output,
                    boundary,
                    "options",
                    JSONObject()
                        .put("locale", "en-IN")
                        .put("polish", "light")
                        .put("sentenceStart", sentenceStart)
                        .put("commands", JSONArray(listOf("new_line", "new_paragraph")))
                        .put("glossary", JSONArray(glossary.take(100)))
                        .toString(),
                )
                output.write("--$boundary\r\n".toByteArray())
                output.write("Content-Disposition: form-data; name=\"audio\"; filename=\"voice.wav\"\r\n".toByteArray())
                output.write("Content-Type: audio/wav\r\n\r\n".toByteArray())
                audioFile.inputStream().buffered().use { it.copyTo(output) }
                output.write("\r\n--$boundary--\r\n".toByteArray())
            }
            val code = connection.responseCode
            val body = readResponse(connection, code)
            if (code in 200..299) {
                val json = JSONObject(body)
                val text = json.optString("text").trim()
                if (text.isEmpty()) Result.Error("The transcription was empty. Please try again.", true)
                else Result.Success(
                    text = text,
                    rawText = json.optString("rawText"),
                    polished = json.optBoolean("polished"),
                    model = json.optString("asrModel"),
                    requestId = json.optString("requestId"),
                    timings = json.optJSONObject("timingsMs")?.let {
                        Timings(
                            asr = it.optLong("asr"),
                            polish = it.optLong("polish"),
                            total = it.optLong("total"),
                        )
                    } ?: Timings(),
                    usage = parseUsage(json.optJSONObject("usage")),
                )
            } else parseError(body, code)
        } catch (_: Exception) {
            Result.Error("Could not reach WoVoice. Check the VPN and try again.", true)
        } finally {
            activeConnection.compareAndSet(connection, null)
            connection.disconnect()
        }
    }

    fun cancel() {
        activeConnection.getAndSet(null)?.disconnect()
    }

    private fun open(url: URL, token: String, method: String): HttpURLConnection? = runCatching {
        (url.openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 15_000
            readTimeout = 35_000
            useCaches = false
            setRequestProperty("Accept", "application/json")
            setRequestProperty("Authorization", "Bearer $token")
        }
    }.getOrNull()

    private fun <T : Result> execute(
        connection: HttpURLConnection,
        block: (Int, String) -> T,
    ): Result = try {
        activeConnection.set(connection)
        val code = connection.responseCode
        block(code, readResponse(connection, code))
    } catch (_: Exception) {
        Result.Error("Could not reach WoVoice. Check the VPN and try again.", true)
    } finally {
        activeConnection.compareAndSet(connection, null)
        connection.disconnect()
    }

    private fun readResponse(connection: HttpURLConnection, code: Int): String {
        val stream = if (code in 200..299) connection.inputStream else connection.errorStream
        if (stream == null) return ""
        return BufferedInputStream(stream).reader(Charsets.UTF_8).use { reader ->
            val buffer = CharArray(8_192)
            val text = StringBuilder()
            while (text.length < MAX_RESPONSE_CHARS) {
                val count = reader.read(buffer, 0, minOf(buffer.size, MAX_RESPONSE_CHARS - text.length))
                if (count < 0) break
                text.append(buffer, 0, count)
            }
            text.toString()
        }
    }

    private fun parseError(body: String, code: Int): Result.Error = runCatching {
        val error = JSONObject(body).optJSONObject("error")
        Result.Error(
            error?.optString("message")?.takeIf(String::isNotBlank) ?: "Transcription failed ($code).",
            error?.optBoolean("retryable", code >= 500) ?: (code >= 500),
        )
    }.getOrElse { Result.Error("Transcription failed ($code).", code >= 500) }

    private fun parseUsage(value: JSONObject?): Usage? {
        value ?: return null
        if (!value.optBoolean("estimated") || value.optString("currency") != "USD") return null
        return runCatching {
            Usage(
                pricingVersion = value.getString("pricingVersion"),
                audioSeconds = value.getDouble("audioSeconds"),
                inputTokens = value.getLong("inputTokens"),
                outputTokens = value.getLong("outputTokens"),
                asrNeurons = value.getDouble("asrNeurons"),
                polishNeurons = value.getDouble("polishNeurons"),
                totalNeurons = value.getDouble("totalNeurons"),
                estimatedCostUsd = value.getDouble("estimatedCostUsd"),
            )
        }.getOrNull()
    }

    private fun writeTextPart(
        output: BufferedOutputStream,
        boundary: String,
        name: String,
        value: String,
    ) {
        output.write("--$boundary\r\n".toByteArray())
        output.write("Content-Disposition: form-data; name=\"$name\"\r\n".toByteArray())
        output.write("Content-Type: application/json; charset=utf-8\r\n\r\n".toByteArray())
        output.write(value.toByteArray(Charsets.UTF_8))
        output.write("\r\n".toByteArray())
    }

    private fun endpoint(baseUrl: String, path: String): URL? = runCatching {
        val base = URI(baseUrl.trim().trimEnd('/'))
        require(base.scheme.equals("https", ignoreCase = true) && !base.host.isNullOrBlank())
        URI("${base.toASCIIString()}$path").toURL()
    }.getOrNull()

    private fun invalidUrl() = Result.Error("Enter a valid HTTPS Worker URL in WoVoice settings.", false)

    private companion object {
        const val MAX_RESPONSE_CHARS = 1_000_000
    }
}

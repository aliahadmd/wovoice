package com.aliahad.wovoice.account

import com.aliahad.wovoice.core.Base64Url
import java.security.MessageDigest
import java.security.SecureRandom

data class PkceRequest(
    val verifier: String,
    val challenge: String,
    val state: String,
)

object Pkce {
    private val random = SecureRandom()

    fun create(): PkceRequest {
        val verifier = randomUrlSafe(64)
        val challenge = encode(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))
        return PkceRequest(verifier, challenge, randomUrlSafe(32))
    }

    internal fun challenge(verifier: String): String = encode(
        MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)),
    )

    private fun randomUrlSafe(bytes: Int): String = ByteArray(bytes).also(random::nextBytes).let(::encode)

    private fun encode(value: ByteArray): String = Base64Url.encode(value)
}

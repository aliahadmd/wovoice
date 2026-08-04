package com.aliahad.wovoice.sync

import com.aliahad.wovoice.core.Base64Url
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

data class WrappedVaultKey(val wrappedKey: String, val nonce: String, val keyVersion: Int)
data class EncryptedRecord(val nonce: String, val ciphertext: String)

object VaultCrypto {
    private val random = SecureRandom()
    private const val RECOVERY_PREFIX = "WV1"
    private const val ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

    fun newSecret(): ByteArray = ByteArray(32).also(random::nextBytes)

    fun encodeRecoveryKey(secret: ByteArray): String {
        require(secret.size == 32)
        val payload = base32Encode(secret)
        val checksum = base32Encode(MessageDigest.getInstance("SHA-256").digest(secret)).take(6)
        return (listOf(RECOVERY_PREFIX) + (payload + checksum).chunked(4)).joinToString("-")
    }

    fun decodeRecoveryKey(value: String): ByteArray? = runCatching {
        val normalized = value.uppercase().filter(Char::isLetterOrDigit)
            .replace('O', '0').replace('I', '1').replace('L', '1')
        if (!normalized.startsWith(RECOVERY_PREFIX)) return null
        val encoded = normalized.removePrefix(RECOVERY_PREFIX)
        if (encoded.length != 58) return null
        val secret = base32Decode(encoded.take(52))
        if (secret.size != 32) return null
        val expected = base32Encode(MessageDigest.getInstance("SHA-256").digest(secret)).take(6)
        if (!MessageDigest.isEqual(expected.toByteArray(), encoded.takeLast(6).toByteArray())) return null
        secret
    }.getOrNull()

    fun wrapVaultKey(vaultKey: ByteArray, recoverySecret: ByteArray, accountId: String, keyVersion: Int): WrappedVaultKey {
        require(vaultKey.size == 32 && recoverySecret.size == 32 && keyVersion > 0)
        val wrappingKey = hkdfSha256(
            inputKey = recoverySecret,
            salt = "WoVoice recovery v1".toByteArray(),
            info = accountId.toByteArray(),
            outputLength = 32,
        )
        val encrypted = encrypt(wrappingKey, vaultKey, "vault|$accountId|$keyVersion".toByteArray())
        return WrappedVaultKey(encrypted.ciphertext, encrypted.nonce, keyVersion)
    }

    fun unwrapVaultKey(value: WrappedVaultKey, recoverySecret: ByteArray, accountId: String): ByteArray? = runCatching {
        val wrappingKey = hkdfSha256(
            inputKey = recoverySecret,
            salt = "WoVoice recovery v1".toByteArray(),
            info = accountId.toByteArray(),
            outputLength = 32,
        )
        decrypt(
            wrappingKey,
            EncryptedRecord(value.nonce, value.wrappedKey),
            "vault|$accountId|${value.keyVersion}".toByteArray(),
        ).takeIf { it.size == 32 }
    }.getOrNull()

    fun encryptRecord(
        vaultKey: ByteArray,
        plaintext: ByteArray,
        accountId: String,
        type: String,
        recordId: String,
        keyVersion: Int,
        schemaVersion: Int,
    ): EncryptedRecord = encrypt(
        vaultKey,
        plaintext,
        metadata(accountId, type, recordId, keyVersion, schemaVersion),
    )

    fun decryptRecord(
        vaultKey: ByteArray,
        value: EncryptedRecord,
        accountId: String,
        type: String,
        recordId: String,
        keyVersion: Int,
        schemaVersion: Int,
    ): ByteArray? = runCatching {
        decrypt(vaultKey, value, metadata(accountId, type, recordId, keyVersion, schemaVersion))
    }.getOrNull()

    fun encodeSecret(value: ByteArray): String = base64Url(value)
    fun decodeSecret(value: String): ByteArray? = runCatching { base64UrlDecode(value) }.getOrNull()

    private fun metadata(accountId: String, type: String, id: String, keyVersion: Int, schemaVersion: Int) =
        "$accountId|$type|$id|$keyVersion|$schemaVersion".toByteArray(Charsets.UTF_8)

    private fun encrypt(key: ByteArray, plaintext: ByteArray, aad: ByteArray): EncryptedRecord {
        val nonce = ByteArray(12).also(random::nextBytes)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD(aad)
        return EncryptedRecord(base64Url(nonce), base64Url(cipher.doFinal(plaintext)))
    }

    private fun decrypt(key: ByteArray, value: EncryptedRecord, aad: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            SecretKeySpec(key, "AES"),
            GCMParameterSpec(128, base64UrlDecode(value.nonce)),
        )
        cipher.updateAAD(aad)
        return cipher.doFinal(base64UrlDecode(value.ciphertext))
    }

    internal fun hkdfSha256(
        inputKey: ByteArray,
        salt: ByteArray,
        info: ByteArray,
        outputLength: Int,
    ): ByteArray {
        require(outputLength in 1..(255 * 32))
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(salt, "HmacSHA256"))
        val pseudoRandomKey = mac.doFinal(inputKey)
        val output = ByteArrayOutputStream()
        var previous = ByteArray(0)
        var counter = 1
        while (output.size() < outputLength) {
            mac.init(SecretKeySpec(pseudoRandomKey, "HmacSHA256"))
            mac.update(previous)
            mac.update(info)
            mac.update(counter.toByte())
            previous = mac.doFinal()
            output.write(previous)
            counter++
        }
        return output.toByteArray().copyOf(outputLength)
    }

    private fun base64Url(value: ByteArray): String = Base64Url.encode(value)

    private fun base64UrlDecode(value: String): ByteArray = Base64Url.decode(value)

    private fun base32Encode(value: ByteArray): String {
        val output = StringBuilder((value.size * 8 + 4) / 5)
        var buffer = 0
        var bits = 0
        value.forEach { byte ->
            buffer = (buffer shl 8) or (byte.toInt() and 0xff)
            bits += 8
            while (bits >= 5) {
                bits -= 5
                output.append(ALPHABET[(buffer shr bits) and 31])
            }
        }
        if (bits > 0) output.append(ALPHABET[(buffer shl (5 - bits)) and 31])
        return output.toString()
    }

    private fun base32Decode(value: String): ByteArray {
        val output = ByteArrayOutputStream()
        var buffer = 0
        var bits = 0
        value.forEach { character ->
            val index = ALPHABET.indexOf(character)
            require(index >= 0)
            buffer = (buffer shl 5) or index
            bits += 5
            if (bits >= 8) {
                bits -= 8
                output.write((buffer shr bits) and 0xff)
            }
        }
        return output.toByteArray()
    }
}

package com.aliahad.wovoice.sync

import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.junit.Test

/**
 * Prints deterministic cross-platform vectors so the Node (Electron) port can
 * prove byte-exactness against this exact Kotlin code. Output goes to the
 * JUnit XML results; the vectors are asserted in desktop/test/vault-crypto.test.ts.
 */
class CrossPlatformVectorTest {
    private val secret = ByteArray(32) { it.toByte() } // 0x00..0x1f
    private val accountId = "acct-123"

    @Test
    fun printVectors() {
        val hkdf = VaultCrypto.hkdfSha256(
            inputKey = secret,
            salt = "WoVoice recovery v1".toByteArray(),
            info = accountId.toByteArray(),
            outputLength = 32,
        )
        println("HKDF=" + hkdf.joinToString("") { "%02x".format(it) })
        println("RECOVERY=" + VaultCrypto.encodeRecoveryKey(secret))

        // AES-256-GCM with an injected fixed nonce (same transform as encrypt()).
        val vaultKey = ByteArray(32) { (it + 0x40).toByte() }
        val nonce = ByteArray(12) { it.toByte() }
        val aad = "acct-123|history|rec-1|1|1".toByteArray()
        val plaintext = "Hello cross-platform".toByteArray()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(vaultKey, "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD(aad)
        val ct = cipher.doFinal(plaintext)
        println("KEY=" + vaultKey.joinToString("") { "%02x".format(it) })
        println("NONCE=" + nonce.joinToString("") { "%02x".format(it) })
        println("AAD=$aad")
        println("CT=" + ct.joinToString("") { "%02x".format(it) })
    }
}

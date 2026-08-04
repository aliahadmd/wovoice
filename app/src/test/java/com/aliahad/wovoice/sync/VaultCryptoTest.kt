package com.aliahad.wovoice.sync

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VaultCryptoTest {
    @Test fun recoveryKeyRoundTripsAndRejectsTampering() {
        val secret = ByteArray(32) { it.toByte() }
        val encoded = VaultCrypto.encodeRecoveryKey(secret)
        assertArrayEquals(secret, VaultCrypto.decodeRecoveryKey(encoded))
        val replacement = if (encoded.last() == '0') '1' else '0'
        assertNull(VaultCrypto.decodeRecoveryKey(encoded.dropLast(1) + replacement))
    }

    @Test fun wrappedKeyAndRecordRequireMatchingAuthenticatedMetadata() {
        val vault = ByteArray(32) { (it + 1).toByte() }
        val recovery = ByteArray(32) { (255 - it).toByte() }
        val wrapped = VaultCrypto.wrapVaultKey(vault, recovery, "account-a", 1)
        assertArrayEquals(vault, VaultCrypto.unwrapVaultKey(wrapped, recovery, "account-a"))
        assertNull(VaultCrypto.unwrapVaultKey(wrapped, recovery, "account-b"))

        val plaintext = "private dictation".toByteArray()
        val encrypted = VaultCrypto.encryptRecord(vault, plaintext, "account-a", "history", "id-1", 1, 1)
        assertArrayEquals(
            plaintext,
            VaultCrypto.decryptRecord(vault, encrypted, "account-a", "history", "id-1", 1, 1),
        )
        assertNull(VaultCrypto.decryptRecord(vault, encrypted, "account-a", "dictionary", "id-1", 1, 1))
    }

    @Test fun generatedSecretsHaveFullKeyLength() {
        assertTrue(VaultCrypto.newSecret().size == 32)
    }
}

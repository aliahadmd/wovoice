package com.aliahad.wovoice.settings

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Stores account credentials and vault material with a non-exportable Android Keystore key. */
class SecretStore(context: Context) {
    private val preferences = context.applicationContext
        .getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    fun putString(name: String, value: String?) {
        require(NAME_PATTERN.matches(name))
        if (value.isNullOrBlank()) {
            remove(name)
            return
        }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val encrypted = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        preferences.edit()
            .putString(ivKey(name), Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .putString(ciphertextKey(name), Base64.encodeToString(encrypted, Base64.NO_WRAP))
            .apply()
    }

    fun getString(name: String): String? {
        require(NAME_PATTERN.matches(name))
        return runCatching {
            val iv = Base64.decode(preferences.getString(ivKey(name), null) ?: return null, Base64.NO_WRAP)
            val ciphertext = Base64.decode(
                preferences.getString(ciphertextKey(name), null) ?: return null,
                Base64.NO_WRAP,
            )
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(128, iv))
            cipher.doFinal(ciphertext).toString(Charsets.UTF_8)
        }.getOrNull()
    }

    fun contains(name: String): Boolean = !getString(name).isNullOrBlank()

    fun remove(name: String) {
        require(NAME_PATTERN.matches(name))
        preferences.edit().remove(ivKey(name)).remove(ciphertextKey(name)).apply()
    }

    fun clearLegacyCredential() {
        remove(LEGACY_TOKEN)
        preferences.edit().remove(V1_IV).remove(V1_CIPHERTEXT).apply()
        runCatching {
            val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            if (keyStore.containsAlias(V1_KEY_ALIAS)) keyStore.deleteEntry(V1_KEY_ALIAS)
        }
    }

    fun clearAccount() {
        listOf(
            REFRESH_TOKEN,
            PENDING_PKCE_VERIFIER,
            PENDING_PKCE_STATE,
            PENDING_AUTH_INTENT,
            VAULT_KEY,
            RECOVERY_SECRET,
        ).forEach(::remove)
    }

    fun clearAll() {
        preferences.edit().clear().apply()
        runCatching {
            val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            listOf(KEY_ALIAS, V1_KEY_ALIAS).forEach { alias ->
                if (keyStore.containsAlias(alias)) keyStore.deleteEntry(alias)
            }
        }
    }

    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private fun ivKey(name: String) = "${name}_iv"
    private fun ciphertextKey(name: String) = "${name}_ciphertext"

    companion object {
        const val REFRESH_TOKEN = "refresh_token"
        const val PENDING_PKCE_VERIFIER = "pending_pkce_verifier"
        const val PENDING_PKCE_STATE = "pending_pkce_state"
        const val PENDING_AUTH_INTENT = "pending_auth_intent"
        const val VAULT_KEY = "vault_key"
        const val RECOVERY_SECRET = "recovery_secret"

        private const val PREFERENCES = "secure_settings"
        private const val KEY_ALIAS = "wovoice_account_secrets_v2"
        private const val LEGACY_TOKEN = "legacy_device_token"
        private const val V1_KEY_ALIAS = "wovoice_device_token_v1"
        private const val V1_IV = "token_iv"
        private const val V1_CIPHERTEXT = "token_ciphertext"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private val NAME_PATTERN = Regex("[a-z0-9_]{1,64}")
    }
}

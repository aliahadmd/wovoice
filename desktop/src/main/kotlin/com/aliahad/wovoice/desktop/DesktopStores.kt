package com.aliahad.wovoice.desktop

import com.aliahad.wovoice.account.AccountSettings
import com.aliahad.wovoice.account.SecretNames
import com.aliahad.wovoice.account.SecretsVault
import org.json.JSONObject
import java.io.File
import java.nio.file.Files
import java.util.Base64

/** App data root: ~/Library/Application Support/WoVoice */
val appDataDir: File = File(
    System.getProperty("user.home"),
    "Library/Application Support/WoVoice",
).apply { mkdirs() }

/**
 * Secrets live in the macOS Keychain as one generic-password item holding a JSON
 * blob of name → value. The Keychain encrypts at rest and gates access to the OS
 * user; WoVoice never writes secrets to a plaintext file.
 */
class KeychainSecretsVault(private val serviceName: String = "com.aliahad.wovoice.secrets") : SecretsVault {

    private val lock = Any()
    private val accountSecretNames = listOf(
        SecretNames.REFRESH_TOKEN, SecretNames.PENDING_PKCE_VERIFIER,
        SecretNames.PENDING_PKCE_STATE, SecretNames.PENDING_AUTH_INTENT,
        SecretNames.VAULT_KEY, SecretNames.RECOVERY_SECRET,
    )

    override fun putString(name: String, value: String?) {
        synchronized(lock) {
            val blob = readBlob().toMutableMap()
            if (value.isNullOrBlank()) blob.remove(name) else blob[name] = value
            writeBlob(blob)
        }
    }

    override fun getString(name: String): String? = synchronized(lock) { readBlob()[name] }

    override fun remove(name: String) {
        synchronized(lock) {
            val blob = readBlob().toMutableMap()
            blob.remove(name)
            writeBlob(blob)
        }
    }

    override fun contains(name: String): Boolean = getString(name)?.isNotBlank() == true

    fun clearAccountSecrets() {
        accountSecretNames.forEach(::remove)
    }

    private fun readBlob(): Map<String, String> {
        val encoded = runCatching {
            val process = ProcessBuilder(
                "security", "find-generic-password", "-s", serviceName, "-w",
            ).redirectErrorStream(true).start()
            process.inputStream.bufferedReader().readText().trim().also { process.waitFor() }
        }.getOrNull() ?: return emptyMap()
        if (encoded.isEmpty()) return emptyMap()
        return runCatching {
            val json = JSONObject(String(Base64.getDecoder().decode(encoded)))
            json.keys().asSequence().associateWith { key -> json.getString(key) }
        }.getOrDefault(emptyMap())
    }

    private fun writeBlob(blob: Map<String, String>) {
        val json = JSONObject()
        blob.forEach { (name, value) -> json.put(name, value) }
        val encodedBlob = Base64.getEncoder().encodeToString(json.toString().toByteArray())
        val delete = ProcessBuilder("security", "delete-generic-password", "-s", serviceName)
            .redirectErrorStream(true).start()
        delete.inputStream.readAllBytes()
        delete.waitFor()
        val add = ProcessBuilder(
            "security", "add-generic-password", "-s", serviceName, "-a", "wovoice", "-w", encodedBlob,
        ).redirectErrorStream(true).start()
        add.inputStream.readAllBytes()
        val exit = add.waitFor()
        check(exit == 0) { "Keychain write failed with exit code $exit" }
    }
}

/**
 * Dashboard/account preferences as a human-inspectable JSON file. Secrets never
 * land here — [KeychainSecretsVault] owns those; clearing an account clears both.
 */
class DesktopSettings(
    private val secrets: SecretsVault,
    private val file: File = File(appDataDir, "settings.json"),
) : AccountSettings {

    private val lock = Any()
    private val cache: JSONObject by lazy {
        synchronized(lock) {
            if (!file.exists()) JSONObject()
            else runCatching { JSONObject(Files.readString(file.toPath())) }.getOrDefault(JSONObject())
        }
    }

    private fun getString(key: String): String? = synchronized(lock) {
        cache.optString(key).takeIf { it.isNotEmpty() }
    }

    private fun putString(key: String, value: String?) {
        synchronized(lock) {
            if (value == null) cache.remove(key) else cache.put(key, value)
            persist()
        }
    }

    private fun getBoolean(key: String, fallback: Boolean): Boolean = synchronized(lock) {
        cache.optBoolean(key, fallback)
    }

    private fun putBoolean(key: String, value: Boolean) {
        synchronized(lock) {
            cache.put(key, value)
            persist()
        }
    }

    private fun getLong(key: String): Long = synchronized(lock) { cache.optLong(key, 0L) }

    private fun putLong(key: String, value: Long?) {
        synchronized(lock) {
            if (value == null) cache.remove(key) else cache.put(key, value)
            persist()
        }
    }

    private fun persist() {
        Files.writeString(file.toPath(), cache.toString(2))
    }

    override var accountId: String?
        get() = getString(KEY_ACCOUNT_ID)
        set(value) = putString(KEY_ACCOUNT_ID, value)

    override val lastAccountId: String?
        get() = getString(KEY_LAST_ACCOUNT_ID)

    override var accountEmail: String?
        get() = getString(KEY_ACCOUNT_EMAIL)
        set(value) = putString(KEY_ACCOUNT_EMAIL, value)

    override var accountRole: String
        get() = getString(KEY_ACCOUNT_ROLE) ?: "user"
        set(value) = putString(KEY_ACCOUNT_ROLE, value)

    override var accountState: String
        get() = getString(KEY_ACCOUNT_STATE) ?: "active"
        set(value) = putString(KEY_ACCOUNT_STATE, value)

    override var accountSuspendedUntilMs: Long?
        get() = getLong(KEY_ACCOUNT_SUSPENDED_UNTIL).takeIf { it > 0L }
        set(value) = putLong(KEY_ACCOUNT_SUSPENDED_UNTIL, value)

    override var accountPublicMessage: String?
        get() = getString(KEY_ACCOUNT_PUBLIC_MESSAGE)
        set(value) = putString(KEY_ACCOUNT_PUBLIC_MESSAGE, value)

    override var accountSupportEmail: String
        get() = getString(KEY_ACCOUNT_SUPPORT_EMAIL) ?: "support@aliahad.com"
        set(value) = putString(KEY_ACCOUNT_SUPPORT_EMAIL, value)

    var workerUrl: String
        get() = getString(KEY_WORKER_URL) ?: DEFAULT_WORKER_URL
        set(value) = putString(KEY_WORKER_URL, value)

    var syncCursor: Long
        get() = getLong(KEY_SYNC_CURSOR)
        set(value) = putLong(KEY_SYNC_CURSOR, value)

    var vaultRecoveryAcknowledged: Boolean
        get() = getBoolean(KEY_VAULT_RECOVERY_ACKNOWLEDGED, false)
        set(value) = putBoolean(KEY_VAULT_RECOVERY_ACKNOWLEDGED, value)

    var keyboardShortcutEnabled: Boolean
        get() = getBoolean(KEY_KEYBOARD_SHORTCUT_ENABLED, true)
        set(value) = putBoolean(KEY_KEYBOARD_SHORTCUT_ENABLED, value)

    var middleClickEnabled: Boolean
        get() = getBoolean(KEY_MIDDLE_CLICK_ENABLED, false)
        set(value) = putBoolean(KEY_MIDDLE_CLICK_ENABLED, value)

    override fun isSignedIn(): Boolean =
        !accountId.isNullOrBlank() && secrets.contains(SecretNames.REFRESH_TOKEN)

    override fun clearAccount() {
        synchronized(lock) {
            listOf(
                KEY_ACCOUNT_ID, KEY_ACCOUNT_EMAIL, KEY_ACCOUNT_ROLE, KEY_ACCOUNT_STATE,
                KEY_ACCOUNT_SUSPENDED_UNTIL, KEY_ACCOUNT_PUBLIC_MESSAGE, KEY_ACCOUNT_SUPPORT_EMAIL,
                KEY_SYNC_CURSOR, KEY_VAULT_RECOVERY_ACKNOWLEDGED,
            ).forEach(cache::remove)
            persist()
        }
        (secrets as? KeychainSecretsVault)?.clearAccountSecrets()
            ?: secrets.remove(SecretNames.REFRESH_TOKEN)
    }

    private companion object {
        const val DEFAULT_WORKER_URL = "https://wovoice.aliahad.com"
        const val KEY_ACCOUNT_ID = "account_id"
        const val KEY_LAST_ACCOUNT_ID = "last_account_id"
        const val KEY_ACCOUNT_EMAIL = "account_email"
        const val KEY_ACCOUNT_ROLE = "account_role"
        const val KEY_ACCOUNT_STATE = "account_state"
        const val KEY_ACCOUNT_SUSPENDED_UNTIL = "account_suspended_until"
        const val KEY_ACCOUNT_PUBLIC_MESSAGE = "account_public_message"
        const val KEY_ACCOUNT_SUPPORT_EMAIL = "account_support_email"
        const val KEY_WORKER_URL = "worker_url"
        const val KEY_SYNC_CURSOR = "sync_cursor"
        const val KEY_VAULT_RECOVERY_ACKNOWLEDGED = "vault_recovery_acknowledged"
        const val KEY_KEYBOARD_SHORTCUT_ENABLED = "keyboard_shortcut_enabled"
        const val KEY_MIDDLE_CLICK_ENABLED = "middle_click_enabled"
    }
}

package com.aliahad.wovoice.settings

import android.content.Context
import com.aliahad.wovoice.BuildConfig

class SettingsStore(context: Context) {
    private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    private val secrets = SecretStore(context)

    init {
        if (!preferences.getBoolean(KEY_LEGACY_CREDENTIAL_REMOVED, false)) {
            secrets.clearLegacyCredential()
            preferences.edit().putBoolean(KEY_LEGACY_CREDENTIAL_REMOVED, true).apply()
        }
    }

    var workerUrl: String
        get() = if (BuildConfig.ALLOW_CUSTOM_ENDPOINT) {
            preferences.getString(KEY_WORKER_URL, BuildConfig.WOVOICE_BASE_URL) ?: BuildConfig.WOVOICE_BASE_URL
        } else BuildConfig.WOVOICE_BASE_URL
        set(value) {
            preferences.edit().putString(KEY_WORKER_URL, normalizeUrl(value)).apply()
        }

    var glossary: List<String>
        get() = (preferences.getString(KEY_GLOSSARY, "") ?: "")
            .lineSequence()
            .map(String::trim)
            .filter(String::isNotEmpty)
            .take(100)
            .toList()
        set(value) {
            val cleaned = value.asSequence()
                .map(String::trim)
                .filter(String::isNotEmpty)
                .distinct()
                .take(100)
                .joinToString("\n")
            preferences.edit().putString(KEY_GLOSSARY, cleaned).apply()
        }

    var historyEnabled: Boolean
        get() = preferences.getBoolean(KEY_HISTORY_ENABLED, true)
        set(value) = preferences.edit().putBoolean(KEY_HISTORY_ENABLED, value).apply()

    var costEstimatesEnabled: Boolean
        get() = preferences.getBoolean(KEY_COST_ESTIMATES, true)
        set(value) = preferences.edit().putBoolean(KEY_COST_ESTIMATES, value).apply()

    var learningSuggestionsEnabled: Boolean
        get() = preferences.getBoolean(KEY_LEARNING_SUGGESTIONS, true)
        set(value) = preferences.edit().putBoolean(KEY_LEARNING_SUGGESTIONS, value).apply()

    var hapticsEnabled: Boolean
        get() = preferences.getBoolean(KEY_HAPTICS, true)
        set(value) = preferences.edit().putBoolean(KEY_HAPTICS, value).apply()

    var animationsEnabled: Boolean
        get() = preferences.getBoolean(KEY_ANIMATIONS, true)
        set(value) = preferences.edit().putBoolean(KEY_ANIMATIONS, value).apply()

    var waveformEnabled: Boolean
        get() = preferences.getBoolean(KEY_WAVEFORM, true)
        set(value) = preferences.edit().putBoolean(KEY_WAVEFORM, value).apply()

    var accountId: String?
        get() = preferences.getString(KEY_ACCOUNT_ID, null)
        set(value) {
            val editor = preferences.edit().putString(KEY_ACCOUNT_ID, value)
            if (!value.isNullOrBlank()) editor.putString(KEY_LAST_ACCOUNT_ID, value)
            editor.apply()
        }

    val lastAccountId: String? get() = preferences.getString(KEY_LAST_ACCOUNT_ID, null)

    var accountEmail: String?
        get() = preferences.getString(KEY_ACCOUNT_EMAIL, null)
        set(value) = preferences.edit().putString(KEY_ACCOUNT_EMAIL, value).apply()

    var accountRole: String
        get() = preferences.getString(KEY_ACCOUNT_ROLE, "user") ?: "user"
        set(value) = preferences.edit().putString(KEY_ACCOUNT_ROLE, value).apply()

    var accountState: String
        get() = preferences.getString(KEY_ACCOUNT_STATE, "active") ?: "active"
        set(value) = preferences.edit().putString(KEY_ACCOUNT_STATE, value).apply()

    var accountSuspendedUntilMs: Long?
        get() = preferences.getLong(KEY_ACCOUNT_SUSPENDED_UNTIL, 0L).takeIf { it > 0L }
        set(value) {
            val editor = preferences.edit()
            if (value == null) editor.remove(KEY_ACCOUNT_SUSPENDED_UNTIL)
            else editor.putLong(KEY_ACCOUNT_SUSPENDED_UNTIL, value)
            editor.apply()
        }

    var accountPublicMessage: String?
        get() = preferences.getString(KEY_ACCOUNT_PUBLIC_MESSAGE, null)
        set(value) = preferences.edit().putString(KEY_ACCOUNT_PUBLIC_MESSAGE, value).apply()

    var accountSupportEmail: String
        get() = preferences.getString(KEY_ACCOUNT_SUPPORT_EMAIL, "support@aliahad.com") ?: "support@aliahad.com"
        set(value) = preferences.edit().putString(KEY_ACCOUNT_SUPPORT_EMAIL, value).apply()

    var acknowledgedPolicyVersion: String?
        get() = preferences.getString(KEY_ACKNOWLEDGED_POLICY_VERSION, null)
        set(value) = preferences.edit().putString(KEY_ACKNOWLEDGED_POLICY_VERSION, value).apply()

    var syncCursor: Long
        get() = preferences.getLong(KEY_SYNC_CURSOR, 0L)
        set(value) = preferences.edit().putLong(KEY_SYNC_CURSOR, value.coerceAtLeast(0L)).apply()

    var vaultRecoveryAcknowledged: Boolean
        get() = preferences.getBoolean(KEY_VAULT_RECOVERY_ACKNOWLEDGED, false)
        set(value) = preferences.edit().putBoolean(KEY_VAULT_RECOVERY_ACKNOWLEDGED, value).apply()

    fun isSignedIn(): Boolean = !accountId.isNullOrBlank() && secrets.contains(SecretStore.REFRESH_TOKEN)

    fun isConfigured(): Boolean = isSignedIn()

    fun clearAccount() {
        preferences.edit()
            .remove(KEY_ACCOUNT_ID)
            .remove(KEY_ACCOUNT_EMAIL)
            .remove(KEY_ACCOUNT_ROLE)
            .remove(KEY_ACCOUNT_STATE)
            .remove(KEY_ACCOUNT_SUSPENDED_UNTIL)
            .remove(KEY_ACCOUNT_PUBLIC_MESSAGE)
            .remove(KEY_ACCOUNT_SUPPORT_EMAIL)
            .remove(KEY_SYNC_CURSOR)
            .remove(KEY_VAULT_RECOVERY_ACKNOWLEDGED)
            .apply()
        secrets.clearAccount()
    }

    fun clearAll() {
        preferences.edit().clear().apply()
        secrets.clearAll()
    }

    private fun normalizeUrl(value: String): String = value.trim().trimEnd('/')

    private companion object {
        const val PREFERENCES = "wovoice_settings"
        const val KEY_WORKER_URL = "worker_url"
        const val KEY_GLOSSARY = "glossary"
        const val KEY_HISTORY_ENABLED = "history_enabled"
        const val KEY_COST_ESTIMATES = "cost_estimates_enabled"
        const val KEY_LEARNING_SUGGESTIONS = "learning_suggestions_enabled"
        const val KEY_HAPTICS = "haptics_enabled"
        const val KEY_ANIMATIONS = "animations_enabled"
        const val KEY_WAVEFORM = "waveform_enabled"
        const val KEY_ACCOUNT_ID = "account_id"
        const val KEY_ACCOUNT_EMAIL = "account_email"
        const val KEY_ACCOUNT_ROLE = "account_role"
        const val KEY_ACCOUNT_STATE = "account_state"
        const val KEY_ACCOUNT_SUSPENDED_UNTIL = "account_suspended_until"
        const val KEY_ACCOUNT_PUBLIC_MESSAGE = "account_public_message"
        const val KEY_ACCOUNT_SUPPORT_EMAIL = "account_support_email"
        const val KEY_ACKNOWLEDGED_POLICY_VERSION = "acknowledged_policy_version"
        const val KEY_LAST_ACCOUNT_ID = "last_account_id"
        const val KEY_LEGACY_CREDENTIAL_REMOVED = "legacy_credential_removed"
        const val KEY_SYNC_CURSOR = "sync_cursor"
        const val KEY_VAULT_RECOVERY_ACKNOWLEDGED = "vault_recovery_acknowledged"
    }
}

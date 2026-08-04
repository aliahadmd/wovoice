package com.aliahad.wovoice.settings

import android.content.Context

class SettingsStore(context: Context) {
    private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    private val secrets = SecretStore(context)

    var workerUrl: String
        get() = preferences.getString(KEY_WORKER_URL, DEFAULT_WORKER_URL) ?: DEFAULT_WORKER_URL
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

    fun deviceToken(): String? = secrets.readToken()

    fun hasDeviceToken(): Boolean = secrets.hasToken()

    fun saveDeviceToken(token: String) = secrets.saveToken(token.trim())

    fun isConfigured(): Boolean = workerUrl.startsWith("https://") && hasDeviceToken()

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
        const val DEFAULT_WORKER_URL = "https://wovoice-transcription-staging.aliahad.workers.dev"
    }
}

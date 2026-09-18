package com.aliahad.wovoice.account

/**
 * Storage seams so SessionManager (and everything built on it) stays platform-free.
 * Android backs these with Keystore-encrypted SharedPreferences and SharedPreferences;
 * the desktop app backs them with a Keychain-wrapped vault and a JSON prefs file.
 */
interface SecretsVault {
    fun putString(name: String, value: String?)
    fun getString(name: String): String?
    fun remove(name: String)
    fun contains(name: String): Boolean
}

interface AccountSettings {
    var accountId: String?
    val lastAccountId: String?
    var accountEmail: String?
    var accountRole: String
    var accountState: String
    var accountSuspendedUntilMs: Long?
    var accountPublicMessage: String?
    var accountSupportEmail: String
    var syncCursor: Long
    var vaultRecoveryAcknowledged: Boolean

    fun isSignedIn(): Boolean
    fun clearAccount()
}

/**
 * Shared names for the secret vault entries so every platform stores the same keys.
 */
object SecretNames {
    const val REFRESH_TOKEN = "refresh_token"
    const val PENDING_PKCE_VERIFIER = "pending_pkce_verifier"
    const val PENDING_PKCE_STATE = "pending_pkce_state"
    const val PENDING_AUTH_INTENT = "pending_auth_intent"
    const val VAULT_KEY = "vault_key"
    const val RECOVERY_SECRET = "recovery_secret"
}

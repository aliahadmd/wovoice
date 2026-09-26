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
    /** Cloud sync (v2) change-feed position for the signed-in account. */
    var syncCursor: Long

    /** Account whose one-time move from the old recovery-key vault has finished on this device. */
    var cloudSyncMigratedAccount: String?

    /** The account's cloud-sync choices, cached from the server for offline use. */
    var historySyncEnabled: Boolean
    var historyRetentionDays: Int?

    /** When the last sync finished, or 0; for the account screen's status line. */
    var lastSyncAtMs: Long

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
    /** Old recovery-key vault material, read only to import the vault once into cloud sync. */
    const val VAULT_KEY = "vault_key"
    const val RECOVERY_SECRET = "recovery_secret"
}

/** What the sync engine needs from the signed-in session. */
interface SyncAccount {
    val accountId: String?
    val cloudServicesAllowed: Boolean
    val restrictionMessage: String
    suspend fun validAccessToken(): AccountResult<String>
    suspend fun refreshAfterRejected(rejectedToken: String): AccountResult<String>
}

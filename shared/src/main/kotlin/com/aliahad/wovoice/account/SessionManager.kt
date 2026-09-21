package com.aliahad.wovoice.account

import com.aliahad.wovoice.account.SecretNames.PENDING_AUTH_INTENT
import com.aliahad.wovoice.account.SecretNames.PENDING_PKCE_STATE
import com.aliahad.wovoice.account.SecretNames.PENDING_PKCE_VERIFIER
import com.aliahad.wovoice.account.SecretNames.REFRESH_TOKEN
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

class SessionManager private constructor(
    private val secrets: SecretsVault,
    private val settings: AccountSettings,
    baseUrlProvider: () -> String,
    deviceNameProvider: () -> String,
) {
    private val client = AccountClient(baseUrlProvider)
    private val refreshMutex = Mutex()
    private val deviceName = deviceNameProvider

    @Volatile private var accessToken: String? = null
    @Volatile private var accessExpiresAtMs: Long = 0
    @Volatile private var quota: AccountQuota? = null
    @Volatile private var user: AccountUser? = storedUser()

    val signedIn: Boolean get() = settings.isSignedIn()
    val accountId: String? get() = settings.accountId
    val email: String? get() = settings.accountEmail
    val currentQuota: AccountQuota? get() = quota
    val currentUser: AccountUser? get() = user
    val role: AccountRole get() = user?.role ?: AccountRole.fromWire(settings.accountRole)
    val accountStatus: AccountStatus get() = user?.accountStatus ?: storedStatus()
    val cloudServicesAllowed: Boolean get() = signedIn && !accountStatus.state.restricted

    fun markRestricted(code: String, message: String, suspendedUntilMs: Long? = null) {
        val state = when (code) {
            "ACCOUNT_SUSPENDED" -> AccountState.SUSPENDED
            "ACCOUNT_BANNED" -> AccountState.BANNED
            else -> return
        }
        val current = user ?: storedUser() ?: return
        installUser(
            current.copy(
                accountStatus = AccountStatus(
                    state = state,
                    suspendedUntilMs = if (state == AccountState.SUSPENDED) suspendedUntilMs else null,
                    publicMessage = message.trim().takeIf(String::isNotBlank),
                    supportEmail = current.accountStatus.supportEmail,
                ),
            ),
        )
    }

    fun prepareLogin(intent: String = AUTH_LOGIN): PkceRequest = Pkce.create().also { request ->
        require(intent == AUTH_LOGIN || intent == AUTH_DELETE)
        secrets.putString(PENDING_PKCE_VERIFIER, request.verifier)
        secrets.putString(PENDING_PKCE_STATE, request.state)
        secrets.putString(PENDING_AUTH_INTENT, intent)
    }

    fun pendingLoginMatches(state: String): Boolean {
        val expected = secrets.getString(PENDING_PKCE_STATE) ?: return false
        if (expected.length != state.length) return false
        var difference = 0
        expected.indices.forEach { index -> difference = difference or (expected[index].code xor state[index].code) }
        return difference == 0
    }

    suspend fun completeLogin(code: String, state: String): AccountResult<AccountUser> {
        if (!pendingLoginMatches(state) || secrets.getString(PENDING_AUTH_INTENT) != AUTH_LOGIN) {
            clearPendingLogin()
            return AccountResult.Error("AUTH_REQUIRED", "The sign-in response could not be verified.", false, 401)
        }
        val verifier = secrets.getString(PENDING_PKCE_VERIFIER)
        clearPendingLogin()
        if (verifier.isNullOrBlank()) {
            return AccountResult.Error("AUTH_REQUIRED", "The sign-in request expired. Please start again.", false, 401)
        }
        return when (val result = client.exchangeAuthorizationCode(code, verifier, deviceName())) {
            is AccountResult.Success -> {
                install(result.value)
                AccountResult.Success(result.value.user)
            }
            is AccountResult.Error -> result
        }
    }

    suspend fun completeAccountDeletion(reauthToken: String, state: String): AccountResult<Unit> {
        if (!pendingLoginMatches(state) || secrets.getString(PENDING_AUTH_INTENT) != AUTH_DELETE) {
            clearPendingLogin()
            return AccountResult.Error("AUTH_REQUIRED", "The deletion verification could not be verified.", false, 401)
        }
        clearPendingLogin()
        val access = when (val result = validAccessToken()) {
            is AccountResult.Success -> result.value
            is AccountResult.Error -> return result
        }
        return when (val result = client.deleteAccount(access, reauthToken)) {
            is AccountResult.Success -> {
                clearLocalSession()
                result
            }
            is AccountResult.Error -> result
        }
    }

    suspend fun validAccessToken(): AccountResult<String> {
        val current = accessToken
        if (!current.isNullOrBlank() && System.currentTimeMillis() < accessExpiresAtMs - EXPIRY_SKEW_MS) {
            return AccountResult.Success(current)
        }
        return refreshMutex.withLock {
            val checked = accessToken
            if (!checked.isNullOrBlank() && System.currentTimeMillis() < accessExpiresAtMs - EXPIRY_SKEW_MS) {
                return@withLock AccountResult.Success(checked)
            }
            refreshLocked()
        }
    }

    suspend fun refreshAfterRejected(rejectedToken: String): AccountResult<String> = refreshMutex.withLock {
        val current = accessToken
        if (!current.isNullOrBlank() && current != rejectedToken && System.currentTimeMillis() < accessExpiresAtMs) {
            AccountResult.Success(current)
        } else refreshLocked()
    }

    suspend fun loadProfile(): AccountResult<AccountProfile> {
        val token = when (val auth = validAccessToken()) {
            is AccountResult.Success -> auth.value
            is AccountResult.Error -> return auth
        }
        return when (val result = client.profile(token)) {
            is AccountResult.Success -> {
                installUser(result.value.user)
                quota = result.value.quota
                result
            }
            is AccountResult.Error -> {
                if (result.code == "TOKEN_EXPIRED") {
                    when (val refreshed = refreshAfterRejected(token)) {
                        is AccountResult.Success -> client.profile(refreshed.value).also { second ->
                            if (second is AccountResult.Success) {
                                installUser(second.value.user)
                                quota = second.value.quota
                            }
                        }
                        is AccountResult.Error -> refreshed
                    }
                } else result
            }
        }
    }

    suspend fun listSessions(): AccountResult<List<DeviceSession>> {
        val token = when (val auth = validAccessToken()) {
            is AccountResult.Success -> auth.value
            is AccountResult.Error -> return auth
        }
        return client.sessions(token)
    }

    suspend fun revokeSession(sessionId: String): AccountResult<Unit> {
        val token = when (val auth = validAccessToken()) {
            is AccountResult.Success -> auth.value
            is AccountResult.Error -> return auth
        }
        return client.revokeSession(token, sessionId)
    }

    /**
     * Revokes the session server-side when possible and always clears the
     * local session. Returns false when the server could not be reached — the
     * refresh token then remains valid there with no local copy to revoke it,
     * which callers should surface instead of swallowing.
     */
    suspend fun logout(): Boolean {
        val token = (validAccessToken() as? AccountResult.Success)?.value
        val revoked = if (token != null) client.logout(token) is AccountResult.Success else false
        clearLocalSession()
        return revoked
    }

    fun clearLocalSession() {
        accessToken = null
        accessExpiresAtMs = 0
        quota = null
        user = null
        settings.clearAccount()
    }

    private fun refreshLocked(): AccountResult<String> {
        val refreshToken = secrets.getString(REFRESH_TOKEN)
        if (refreshToken.isNullOrBlank()) {
            clearLocalSession()
            return AccountResult.Error("AUTH_REQUIRED", "Sign in to use voice input.", false, 401)
        }
        return when (val result = client.refresh(refreshToken)) {
            is AccountResult.Success -> {
                install(result.value)
                AccountResult.Success(result.value.accessToken)
            }
            is AccountResult.Error -> {
                if (result.code == "AUTH_REQUIRED") clearLocalSession()
                result
            }
        }
    }

    private fun install(tokens: SessionTokens) {
        accessToken = tokens.accessToken
        // Clamp the TTL: a hostile or buggy value must not overflow into a
        // negative expiry (perpetual refresh) or lock a token in for years.
        accessExpiresAtMs = System.currentTimeMillis() +
            tokens.accessExpiresInSeconds.coerceIn(0L, MAX_ACCESS_TTL_SECONDS) * 1_000L
        secrets.putString(REFRESH_TOKEN, tokens.refreshToken)
        settings.accountId = tokens.user.id
        installUser(tokens.user)
    }

    private fun installUser(value: AccountUser) {
        user = value
        settings.accountId = value.id
        settings.accountEmail = value.email
        settings.accountRole = value.role.name.lowercase()
        settings.accountState = value.accountStatus.state.name.lowercase()
        settings.accountSuspendedUntilMs = value.accountStatus.suspendedUntilMs
        settings.accountPublicMessage = value.accountStatus.publicMessage
        settings.accountSupportEmail = value.accountStatus.supportEmail
    }

    private fun storedUser(): AccountUser? {
        val id = settings.accountId ?: return null
        val email = settings.accountEmail ?: return null
        return AccountUser(
            id = id,
            email = email,
            vaultConfigured = false,
            vaultKeyVersion = null,
            role = AccountRole.fromWire(settings.accountRole),
            accountStatus = storedStatus(),
        )
    }

    private fun storedStatus(): AccountStatus = AccountStatus(
        state = AccountState.fromWire(settings.accountState),
        suspendedUntilMs = settings.accountSuspendedUntilMs,
        publicMessage = settings.accountPublicMessage,
        supportEmail = settings.accountSupportEmail,
    )

    private fun clearPendingLogin() {
        secrets.remove(PENDING_PKCE_VERIFIER)
        secrets.remove(PENDING_PKCE_STATE)
        secrets.remove(PENDING_AUTH_INTENT)
    }

    companion object {
        const val AUTH_LOGIN = "login"
        const val AUTH_DELETE = "delete"
        private const val EXPIRY_SKEW_MS = 30_000L

        // The server issues 15-minute access tokens; anything claiming longer
        // than a day is a hostile or broken response.
        private const val MAX_ACCESS_TTL_SECONDS = 24 * 60 * 60L

        @Volatile private var instance: SessionManager? = null

        /**
         * Idempotent singleton. Each platform supplies its own secure storage and
         * identity: Android wires Keystore-backed stores, macOS wires the Keychain
         * vault, and both pass their own worker-URL and device-name providers.
         */
        fun get(
            settings: AccountSettings,
            secrets: SecretsVault,
            baseUrlProvider: () -> String,
            deviceNameProvider: () -> String,
        ): SessionManager = instance ?: synchronized(this) {
            instance ?: SessionManager(secrets, settings, baseUrlProvider, deviceNameProvider)
                .also { instance = it }
        }
    }
}

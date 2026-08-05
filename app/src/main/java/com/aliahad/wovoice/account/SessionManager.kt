package com.aliahad.wovoice.account

import android.content.Context
import android.os.Build
import com.aliahad.wovoice.settings.SecretStore
import com.aliahad.wovoice.settings.SettingsStore
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

class SessionManager private constructor(context: Context) {
    private val appContext = context.applicationContext
    private val settings = SettingsStore(appContext)
    private val secrets = SecretStore(appContext)
    private val client = AccountClient(settings.workerUrl)
    private val refreshMutex = Mutex()

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
        secrets.putString(SecretStore.PENDING_PKCE_VERIFIER, request.verifier)
        secrets.putString(SecretStore.PENDING_PKCE_STATE, request.state)
        secrets.putString(SecretStore.PENDING_AUTH_INTENT, intent)
    }

    fun pendingLoginMatches(state: String): Boolean {
        val expected = secrets.getString(SecretStore.PENDING_PKCE_STATE) ?: return false
        if (expected.length != state.length) return false
        var difference = 0
        expected.indices.forEach { index -> difference = difference or (expected[index].code xor state[index].code) }
        return difference == 0
    }

    suspend fun completeLogin(code: String, state: String): AccountResult<AccountUser> {
        if (!pendingLoginMatches(state) || secrets.getString(SecretStore.PENDING_AUTH_INTENT) != AUTH_LOGIN) {
            clearPendingLogin()
            return AccountResult.Error("AUTH_REQUIRED", "The sign-in response could not be verified.", false, 401)
        }
        val verifier = secrets.getString(SecretStore.PENDING_PKCE_VERIFIER)
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
        if (!pendingLoginMatches(state) || secrets.getString(SecretStore.PENDING_AUTH_INTENT) != AUTH_DELETE) {
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

    suspend fun logout() {
        val token = (validAccessToken() as? AccountResult.Success)?.value
        if (token != null) client.logout(token)
        clearLocalSession()
    }

    fun clearLocalSession() {
        accessToken = null
        accessExpiresAtMs = 0
        quota = null
        user = null
        settings.clearAccount()
    }

    private fun refreshLocked(): AccountResult<String> {
        val refreshToken = secrets.getString(SecretStore.REFRESH_TOKEN)
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
        accessExpiresAtMs = System.currentTimeMillis() + tokens.accessExpiresInSeconds * 1_000L
        secrets.putString(SecretStore.REFRESH_TOKEN, tokens.refreshToken)
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
        secrets.remove(SecretStore.PENDING_PKCE_VERIFIER)
        secrets.remove(SecretStore.PENDING_PKCE_STATE)
        secrets.remove(SecretStore.PENDING_AUTH_INTENT)
    }

    private fun deviceName(): String = listOf(Build.MANUFACTURER, Build.MODEL)
        .filter(String::isNotBlank)
        .joinToString(" ")
        .ifBlank { "Android device" }
        .take(80)

    companion object {
        private const val EXPIRY_SKEW_MS = 30_000L
        const val AUTH_LOGIN = "login"
        const val AUTH_DELETE = "delete"
        @Volatile private var instance: SessionManager? = null

        fun get(context: Context): SessionManager = instance ?: synchronized(this) {
            instance ?: SessionManager(context).also { instance = it }
        }
    }
}

package com.aliahad.wovoice.desktop

import com.aliahad.wovoice.account.SessionManager

/** Process-wide desktop wiring: Keychain-backed secrets + JSON prefs + shared SessionManager. */
object DesktopSession {
    private val vault = KeychainSecretsVault()
    val settings = DesktopSettings(vault)
    val session: SessionManager = SessionManager.get(
        settings = settings,
        secrets = vault,
        baseUrlProvider = { settings.workerUrl },
        deviceNameProvider = { "macOS" },
    )
}

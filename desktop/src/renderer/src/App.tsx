import { useCallback, useEffect, useState } from 'react'

type Tab = 'home' | 'account' | 'settings'

interface AuthState {
  signedIn: boolean
  email?: string | null
  error?: string
}

interface Profile {
  user: { email: string }
  quota: {
    remainingAudioSeconds: number
    limitAudioSeconds: number
    resetAtMs?: number
  } | null
}

interface Permissions {
  accessibility: boolean
  mic: string
}

interface Settings {
  keyboardShortcutEnabled: boolean
  middleClickEnabled: boolean
  workerUrl: string
}

function Dashboard(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('home')
  const [auth, setAuth] = useState<AuthState>({ signedIn: false })
  const [profile, setProfile] = useState<Profile | null>(null)
  const [permissions, setPermissions] = useState<Permissions | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [version, setVersion] = useState('')

  const [busy, setBusy] = useState(false)

  const signIn = (): void => {
    setBusy(true)
    window.api.signIn().finally(() => setBusy(false))
  }

  const signOut = (): void => {
    setBusy(true)
    window.api.signOut().finally(() => setBusy(false))
  }

  const refreshPermissions = useCallback((): void => {
    window.api.permissionsCheck().then(setPermissions).catch(() => setPermissions(null))
  }, [])

  useEffect(() => {
    window.api.authState().then(setAuth)
    window.api
      .settingsGet()
      .then(setSettings)
      .catch(() => setSettings(null))
    window.api.getVersion().then(setVersion)
    refreshPermissions()
    return window.api.onAuthState((state) => {
      setAuth(state)
      if (state.signedIn) {
        window.api
          .profile()
          .then((value) => setProfile(value as Profile))
          .catch(() => setProfile(null))
      } else {
        setProfile(null)
      }
    })
  }, [refreshPermissions])

  const toggle = (key: 'keyboardShortcutEnabled' | 'middleClickEnabled'): void => {
    if (settings === null) return
    const next = !settings[key]
    setSettings({ ...settings, [key]: next })
    void window.api.settingsSet(key, next)
  }

  const enableMicrophone = (): void => {
    void window.api
      .enableMicrophone()
      .then(refreshPermissions)
      .catch(() => refreshPermissions())
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" />
          WoVoice
        </div>
        <nav className="tabs">
          <button className={`tab ${tab === 'home' ? 'active' : ''}`} onClick={() => setTab('home')}>
            Home
          </button>
          <button className={`tab ${tab === 'account' ? 'active' : ''}`} onClick={() => setTab('account')}>
            Account
          </button>
          <button className={`tab ${tab === 'settings' ? 'active' : ''}`} onClick={() => setTab('settings')}>
            Settings
          </button>
        </nav>
        <div className="account-chip">{auth.signedIn ? auth.email : 'Signed out'}</div>
      </header>

      <main className="content">
        {tab === 'home' && (
          <>
            <div className="hero">
              <h1>Speak naturally. Get ready-to-use text.</h1>
              <p>Hold ⌘ Command (or middle-click) anywhere on your Mac to dictate.</p>
            </div>

            <div className="card">
              <h2>Dictation status</h2>
              <div className="stat-row">
                <span className="label">Account</span>
                <span className="value">{auth.signedIn ? 'Signed in' : 'Signed out'}</span>
              </div>
              <div className="stat-row">
                <span className="label">Microphone</span>
                <span className="value">{permissions === null ? 'checking…' : permissions.mic}</span>
              </div>
              <div className="stat-row">
                <span className="label">Paste (accessibility)</span>
                <span className="value">
                  {permissions === null ? 'checking…' : permissions.accessibility ? 'granted' : 'not granted'}
                </span>
              </div>
              <div className="stat-row">
                <span className="label">Keyboard trigger</span>
                <span className="value">
                  {settings === null ? '—' : settings.keyboardShortcutEnabled ? '⌘ hold enabled' : 'off'}
                </span>
              </div>
              <div className="stat-row">
                <span className="label">Middle-click trigger</span>
                <span className="value">
                  {settings === null ? '—' : settings.middleClickEnabled ? 'enabled' : 'off'}
                </span>
              </div>
            </div>

            <div className="card">
              <h2>Phase E1+E2</h2>
              <p>
                Shell, tray, settings, account sign-in, and permissions onboarding are live.
                The dictation loop (global trigger, waveform overlay, Worker transcription,
                paste) is next.
              </p>
            </div>
          </>
        )}

        {tab === 'account' && (
          <>
            <div className="hero">
              <h1>Account</h1>
              <p>Your WoVoice session lives in this Mac's Keychain.</p>
            </div>
            <div className="card">
              {auth.signedIn ? (
                <>
                  <div className="stat-row">
                    <span className="label">Email</span>
                    <span className="value">{auth.email ?? profile?.user.email}</span>
                  </div>
                  {profile?.quota && (
                    <>
                      <div className="stat-row">
                        <span className="label">Today's quota</span>
                        <span className="value">
                          {Math.round(profile.quota.remainingAudioSeconds)} of{' '}
                          {Math.round(profile.quota.limitAudioSeconds)} seconds left
                        </span>
                      </div>
                      {profile.quota.resetAtMs !== undefined && (
                        <div className="stat-row">
                          <span className="label">Quota resets</span>
                          <span className="value">
                            {new Date(profile.quota.resetAtMs).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit'
                            })}
                          </span>
                        </div>
                      )}
                    </>
                  )}
                  <p>
                    <button className="action danger" onClick={signOut} disabled={busy}>
                      Sign out
                    </button>
                  </p>
                </>
              ) : (
                <>
                  <p>Sign in to use voice dictation. Your refresh token is sealed in the Keychain.</p>
                  <button className="action" onClick={signIn} disabled={busy}>
                    Sign in or create account
                  </button>
                  {auth.error && <p className="error">{auth.error}</p>}
                </>
              )}
            </div>
            <div className="card">
              <h2>Encrypted sync</h2>
              <p>History, dictionary, and analytics sync end-to-end encrypted with your phone — arriving with E6.</p>
            </div>
          </>
        )}

        {tab === 'settings' && (
          <>
            <div className="hero">
              <h1>Settings</h1>
              <p>Triggers and permissions for system-wide dictation.</p>
            </div>
            <div className="card">
              <h2>Dictation triggers</h2>
              <div className="stat-row">
                <span className="label">Hold ⌘ Command to dictate</span>
                <button
                  className={`action ${settings?.keyboardShortcutEnabled ? '' : 'secondary'}`}
                  onClick={() => toggle('keyboardShortcutEnabled')}
                >
                  {settings === null ? '—' : settings.keyboardShortcutEnabled ? 'On' : 'Off'}
                </button>
              </div>
              <div className="stat-row">
                <span className="label">Hold middle-click to dictate</span>
                <button
                  className={`action ${settings?.middleClickEnabled ? '' : 'secondary'}`}
                  onClick={() => toggle('middleClickEnabled')}
                >
                  {settings === null ? '—' : settings.middleClickEnabled ? 'On' : 'Off'}
                </button>
              </div>
            </div>
            <div className="card">
              <h2>Permissions</h2>
              <div className="stat-row">
                <span className="label">Microphone</span>
                <span className="value">{permissions === null ? 'checking…' : permissions.mic}</span>
              </div>
              <p>
                <button className="action" onClick={enableMicrophone}>
                  Enable microphone
                </button>
              </p>
              <div className="stat-row">
                <span className="label">Paste (accessibility)</span>
                <span className="value">
                  {permissions === null ? 'checking…' : permissions.accessibility ? 'granted' : 'not granted'}
                </span>
              </div>
              <p>
                <button
                  className="action secondary"
                  onClick={() => {
                    void window.api.openAccessibilityPane()
                    refreshPermissions()
                  }}
                >
                  Open accessibility settings
                </button>
              </p>
              <div className="stat-row">
                <span className="label">Global input events (middle-click)</span>
                <span className="value">
                  {settings === null ? '—' : settings.middleClickEnabled ? 'requires grant' : 'not used while off'}
                </span>
              </div>
              <p>
                <button
                  className="action secondary"
                  onClick={() => {
                    void window.api.openListenPane()
                    refreshPermissions()
                  }}
                >
                  Open input monitoring settings
                </button>
              </p>
            </div>
            <div className="card">
              <h2>About</h2>
              <div className="stat-row">
                <span className="label">WoVoice</span>
                <span className="value">{version}</span>
              </div>
              <div className="stat-row">
                <span className="label">Service</span>
                <span className="value mono">{settings?.workerUrl ?? 'wovoice.aliahad.com'}</span>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  )
}

export default Dashboard

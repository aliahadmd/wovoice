import { useEffect, useState } from 'react'

interface AuthState {
  signedIn: boolean
  email?: string | null
  error?: string
}

interface Profile {
  user: { email: string }
  quota: { remainingAudioSeconds: number; limitAudioSeconds: number } | null
}

function Dashboard(): React.JSX.Element {
  const [auth, setAuth] = useState<AuthState>({ signedIn: false })
  const [profile, setProfile] = useState<Profile | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    window.api.authState().then(setAuth)
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
  }, [])

  const signIn = (): void => {
    setBusy(true)
    window.api.signIn().finally(() => setBusy(false))
  }

  const signOut = (): void => {
    setBusy(true)
    window.api
      .signOut()
      .finally(() => setBusy(false))
  }

  return (
    <div className="shell">
      <header className="hero">
        <div className="hero-mark">◉</div>
        <div>
          <h1>WoVoice for macOS</h1>
          <p>Speak naturally. Get clear, ready-to-use text — on your Mac.</p>
        </div>
      </header>

      <section className="card">
        <h2>Account</h2>
        {auth.signedIn ? (
          <>
            <p>
              Signed in as <strong>{auth.email}</strong>
              {profile?.quota && (
                <> — {Math.round(profile.quota.remainingAudioSeconds)} of {Math.round(profile.quota.limitAudioSeconds)} voice seconds left today</>
              )}
            </p>
            <button className="action" onClick={signOut} disabled={busy}>
              Sign out
            </button>
          </>
        ) : (
          <>
            <p>Sign in to use voice dictation. Your session is protected by the Keychain.</p>
            <button className="action" onClick={signIn} disabled={busy}>
              Sign in or create account
            </button>
            {auth.error && (
              <p className="error">{auth.error}</p>
            )}
          </>
        )}
      </section>

      <section className="card">
        <h2>Phase E2 — auth live</h2>
        <p>
          Settings, the Worker client, and passwordless sign-in (system browser + loopback
          PKCE) are wired. Dictation (global trigger, waveform overlay, transcription,
          paste) lands in E3/E4.
        </p>
      </section>

      <section className="card">
        <h2>Coming in this build-out</h2>
        <ul>
          <li>Hold ⌥Space or middle-click anywhere to dictate</li>
          <li>Live waveform overlay; text pastes at your cursor</li>
          <li>Home · History · Dictionary · Settings, like your phone</li>
          <li>Same WoVoice account, quota, and encrypted sync</li>
        </ul>
      </section>
    </div>
  )
}

export default Dashboard

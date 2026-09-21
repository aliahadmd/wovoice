import { useCallback, useEffect, useState } from 'react'

type Tab = 'home' | 'history' | 'dictionary' | 'account' | 'settings'
type Period = 'today' | '7d' | '30d' | 'all'

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
  triggerKey: string
  workerUrl: string
}

const TRIGGER_KEY_OPTIONS: Array<{ id: string; label: string }> = [
  { id: 'option', label: '⌥ Left Option (default)' },
  { id: 'option-right', label: '⌥ Right Option' },
  { id: 'command', label: '⌘ Left Command' },
  { id: 'command-right', label: '⌘ Right Command' },
  { id: 'caps-lock', label: '⇪ Caps Lock' },
  { id: 'fn', label: '🌐 Fn / Globe' }
]

interface HomeStats {
  dictations: number
  audioDurationMs: number
  words: number
  recent: Array<{
    requestId: string
    finalText: string
    createdAtMs: number
    wordCount: number
    audioDurationMs: number
  }>
}

interface HistoryRow {
  requestId: string
  finalText: string
  createdAtMs: number
  wordCount: number
  audioDurationMs: number
}

interface TermRow {
  id: number
  term: string
  source: string
  useCount: number
  lastUsedAtMs: number
}

const PERIODS: Array<[Period, string]> = [
  ['today', 'Today'],
  ['7d', '7 days'],
  ['30d', '30 days'],
  ['all', 'All time']
]

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} sec`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

function formatWhen(ms: number): string {
  return new Date(ms).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function Dashboard(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('home')
  const [auth, setAuth] = useState<AuthState>({ signedIn: false })
  const [profile, setProfile] = useState<Profile | null>(null)
  const [permissions, setPermissions] = useState<Permissions | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [version, setVersion] = useState('')
  const [loginItem, setLoginItem] = useState(false)
  const [busy, setBusy] = useState(false)

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
    window.api.getLoginItem().then(setLoginItem)
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

  const signIn = (): void => {
    setBusy(true)
    window.api.signIn().finally(() => setBusy(false))
  }

  const signOut = (): void => {
    setBusy(true)
    window.api.signOut().finally(() => setBusy(false))
  }

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
          {(
            [
              ['home', 'Home'],
              ['history', 'History'],
              ['dictionary', 'Dictionary'],
              ['account', 'Account'],
              ['settings', 'Settings']
            ] as Array<[Tab, string]>
          ).map(([id, label]) => (
            <button key={id} className={`tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="account-chip">{auth.signedIn ? auth.email : 'Signed out'}</div>
      </header>

      <main className="content">
        {tab === 'home' && <HomeTab signedIn={auth.signedIn} />}
        {tab === 'history' && <HistoryTab />}
        {tab === 'dictionary' && <DictionaryTab />}
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
            <SyncCard signedIn={auth.signedIn} />
          </>
        )}
        {tab === 'settings' && (
          <>
            <div className="hero">
              <h1>Settings</h1>
              <p>Triggers, permissions, and startup for system-wide dictation.</p>
            </div>
            <div className="card">
              <h2>Dictation triggers</h2>
              <div className="stat-row">
                <span className="label">Hold-to-talk key</span>
                <select
                  className="select"
                  value={settings?.triggerKey ?? 'option'}
                  onChange={(event) => {
                    if (settings === null) return
                    const next = event.target.value
                    setSettings({ ...settings, triggerKey: next })
                    void window.api.settingsSet('triggerKey', next)
                  }}
                >
                  {TRIGGER_KEY_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <p className="hint">
                Hold the key and speak; release to insert. A quick tap latches — tap again to stop.
                Only the chosen key starts dictation; typing is never affected.
              </p>
              <div className="stat-row">
                <span className="label">Keyboard trigger enabled</span>
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
              <h2>Permissions &amp; access</h2>
              <p className="hint">
                WoVoice asks for exactly two macOS permissions — the same ones Wispr Flow
                needs. Nothing else: it never reads your screen, files, or browsing. Both are
                granted once and stay.
              </p>
              <div className="stat-row">
                <span className="label">
                  <strong>1 · Microphone</strong> — to hear you while you dictate
                </span>
                <span className="value">{permissions === null ? 'checking…' : permissions.mic}</span>
              </div>
              <p className="hint">
                Audio is captured only while the bubble is recording, sent to your WoVoice
                service for transcription, then discarded. It is never stored on the server.
              </p>
              <p>
                <button className="action" onClick={enableMicrophone}>
                  Enable microphone
                </button>
              </p>
              <div className="stat-row">
                <span className="label">
                  <strong>2 · Device Control &amp; Data Access</strong> — for the trigger key and
                  pasting
                </span>
                <span className="value">
                  {permissions === null ? 'checking…' : permissions.accessibility ? 'granted' : 'not granted'}
                </span>
              </div>
              <p className="hint">
                This is the Accessibility permission (System Settings → Privacy &amp; Security →
                Device Control &amp; Data Access). It lets WoVoice watch for your chosen trigger
                key in any app and paste the finished text at your cursor. It does not read your
                screen or send anything anywhere.
              </p>
              <p>
                <button
                  className="action secondary"
                  onClick={() => {
                    void window.api.openAccessibilityPane()
                    refreshPermissions()
                  }}
                >
                  Open the permission pane
                </button>
              </p>
              <div className="stat-row">
                <span className="label">Input Monitoring</span>
                <span className="value">not needed</span>
              </div>
              <p className="hint">WoVoice deliberately avoids this permission entirely.</p>
            </div>
            <div className="card">
              <h2>Startup</h2>
              <div className="stat-row">
                <span className="label">Launch WoVoice at login</span>
                <button
                  className={`action ${loginItem ? '' : 'secondary'}`}
                  onClick={() => {
                    const next = !loginItem
                    void window.api.setLoginItem(next).then((applied) => setLoginItem(applied))
                  }}
                >
                  {loginItem ? 'On' : 'Off'}
                </button>
              </div>
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

function HomeTab({ signedIn }: { signedIn: boolean }): React.JSX.Element {
  const [period, setPeriod] = useState<Period>('today')
  const [stats, setStats] = useState<HomeStats | null>(null)

  useEffect(() => {
    window.api
      .homeStats(period)
      .then(setStats)
      .catch(() => setStats(null))
  }, [period])

  const wpm =
    stats !== null && stats.audioDurationMs > 0
      ? Math.round((stats.words * 60_000) / stats.audioDurationMs)
      : 0

  return (
    <>
      <div className="hero">
        <h1>Speak naturally. Get ready-to-use text.</h1>
        <p>Hold ⌥ Option (or middle-click) anywhere on your Mac to dictate.</p>
      </div>

      <div className="card">
        <h2>Your dictations</h2>
        <div className="tabs" style={{ marginBottom: 10 }}>
          {PERIODS.map(([id, label]) => (
            <button key={id} className={`tab ${period === id ? 'active' : ''}`} onClick={() => setPeriod(id)}>
              {label}
            </button>
          ))}
        </div>
        <div className="stat-row">
          <span className="label">Dictations</span>
          <span className="value">{stats === null ? '—' : stats.dictations}</span>
        </div>
        <div className="stat-row">
          <span className="label">Dictation time</span>
          <span className="value">{stats === null ? '—' : formatDuration(stats.audioDurationMs)}</span>
        </div>
        <div className="stat-row">
          <span className="label">Words</span>
          <span className="value">{stats === null ? '—' : stats.words}</span>
        </div>
        <div className="stat-row">
          <span className="label">Speaking pace</span>
          <span className="value">{stats === null ? '—' : `${wpm} wpm`}</span>
        </div>
      </div>

      <div className="card">
        <h2>Recent dictations</h2>
        {stats === null || stats.recent.length === 0 ? (
          <p className="muted">
            {signedIn
              ? 'Nothing yet — hold ⌥ Option anywhere and speak.'
              : 'Sign in, then hold ⌥ Option anywhere and speak.'}
          </p>
        ) : (
          stats.recent.map((record) => (
            <div key={record.requestId} className="stat-row">
              <span className="label clamp">{record.finalText}</span>
              <span className="value">{record.wordCount} words</span>
            </div>
          ))
        )}
      </div>
    </>
  )
}

function HistoryTab(): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<HistoryRow[]>([])
  const [undo, setUndo] = useState<HistoryRow | null>(null)

  const refresh = useCallback((q: string): void => {
    window.api
      .historyList(q)
      .then(setRows)
      .catch(() => setRows([]))
  }, [])

  useEffect(() => {
    refresh('')
  }, [refresh])

  useEffect(() => {
    if (undo === null) return
    const timer = setTimeout(() => setUndo(null), 5_000)
    return () => clearTimeout(timer)
  }, [undo])

  const remove = (row: HistoryRow): void => {
    void window.api.historyDelete(row.requestId).then(() => {
      setUndo(row)
      refresh(query)
    })
  }

  const restore = (): void => {
    if (undo === null) return
    void window.api.historyRestore(undo.requestId).then(() => {
      refresh(query)
      setUndo(null)
    })
  }

  return (
    <>
      <div className="hero">
        <h1>History</h1>
        <p>Dictations inserted on this Mac. Search, copy, delete with undo.</p>
      </div>
      {undo !== null && (
        <div className="card undo">
          <span>
            Deleted “{undo.finalText.slice(0, 40)}
            {undo.finalText.length > 40 ? '…' : ''}”
          </span>
          <button className="action secondary" onClick={restore}>
            Undo
          </button>
        </div>
      )}
      <input
        className="search"
        placeholder="Search generated text"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          refresh(event.target.value)
        }}
      />
      <div className="card">
        {rows.length === 0 ? (
          <p className="muted">No dictations yet.</p>
        ) : (
          rows.map((row) => (
            <div key={row.requestId} className="history-item">
              <div className="history-text">{row.finalText}</div>
              <div className="history-meta">
                {formatWhen(row.createdAtMs)} • {row.wordCount} words • {formatDuration(row.audioDurationMs)}
              </div>
              <div className="history-actions">
                <button className="action secondary" onClick={() => void window.api.historyCopy(row.finalText)}>
                  Copy
                </button>
                <button className="action danger" onClick={() => remove(row)}>
                  Delete
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </>
  )
}

function DictionaryTab(): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<TermRow[]>([])
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback((q: string): void => {
    window.api
      .dictionaryList(q)
      .then(setRows)
      .catch(() => setRows([]))
  }, [])

  useEffect(() => {
    refresh('')
  }, [refresh])

  const add = (): void => {
    void window.api.dictionaryAdd(draft).then((added) => {
      if (!added) {
        setError('That term is invalid or already exists.')
        return
      }
      setError(null)
      setDraft('')
      refresh(query)
    })
  }

  return (
    <>
      <div className="hero">
        <h1>Dictionary</h1>
        <p>Names and terms WoVoice should recognize in dictation.</p>
      </div>
      <div className="card">
        <div className="add-row">
          <input
            className="search"
            placeholder="Name or specialist term"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') add()
            }}
          />
          <button className="action" onClick={add}>
            Add
          </button>
        </div>
        {error !== null && <p className="error">{error}</p>}
      </div>
      <div className="card">
        <div className="add-row">
          <input
            className="search"
            placeholder="Search dictionary"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              refresh(event.target.value)
            }}
          />
        </div>
        {rows.length === 0 ? (
          <p className="muted">No terms yet — add an important name above.</p>
        ) : (
          rows.map((row) => (
            <div key={row.id} className="stat-row">
              <span className="label">
                {row.term}
                <span className="mono">
                  {' '}
                  · {row.source} · {row.useCount} uses
                </span>
              </span>
              <button
                className="action danger"
                onClick={() => {
                  void window.api.dictionaryDelete(row.id).then(() => refresh(query))
                }}
              >
                Delete
              </button>
            </div>
          ))
        )}
      </div>
    </>
  )
}

function SyncCard({ signedIn }: { signedIn: boolean }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [recoveryKey, setRecoveryKey] = useState('')
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<string | null>(null)

  const runSync = (): void => {
    setBusy(true)
    setResult(null)
    window.api
      .syncNow()
      .then((outcome) => {
        if (outcome.kind === 'ok') {
          setResult(`Synced — ${outcome.uploaded ?? 0} uploaded, ${outcome.downloaded ?? 0} downloaded.`)
        } else if (outcome.kind === 'needs-recovery') {
          setResult('This Mac needs your recovery key to unlock the encrypted vault.')
        } else if (outcome.kind === 'reconciled') {
          setResult('Changes were reconciled with another device. Sync again to continue.')
        } else {
          setResult(outcome.message ?? 'Sync failed.')
        }
      })
      .finally(() => setBusy(false))
  }

  const importKey = (): void => {
    setImporting(true)
    setImportResult(null)
    window.api
      .importRecoveryKey(recoveryKey)
      .then((ok) => {
        setImportResult(ok ? 'Vault unlocked on this Mac.' : 'That recovery key does not match this account.')
        if (ok) setRecoveryKey('')
      })
      .finally(() => setImporting(false))
  }

  if (!signedIn) {
    return (
      <div className="card">
        <h2>Encrypted sync</h2>
        <p className="muted">Sign in to sync your history and dictionary end-to-end encrypted.</p>
      </div>
    )
  }

  return (
    <div className="card">
      <h2>Encrypted sync</h2>
      <p>
        History and dictionary sync end-to-end encrypted with your phone. Paste the recovery
        key from a signed-in device to unlock this Mac's vault.
      </p>
      <p>
        <button className="action" onClick={runSync} disabled={busy}>
          {busy ? 'Syncing…' : 'Sync now'}
        </button>
      </p>
      {result !== null && <p className="mono">{result}</p>}
      <div className="add-row" style={{ marginTop: 10 }}>
        <input
          className="search"
          placeholder="WV1-… recovery key"
          value={recoveryKey}
          onChange={(event) => setRecoveryKey(event.target.value)}
        />
        <button
          className="action secondary"
          onClick={importKey}
          disabled={importing || recoveryKey.trim().length === 0}
        >
          Import
        </button>
      </div>
      {importResult !== null && <p className="mono">{importResult}</p>}
    </div>
  )
}

export default Dashboard

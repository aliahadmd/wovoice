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
    // The Worker sends `resetAt`; the old `resetAtMs` name never matched, so the
    // reset time was never shown.
    resetAt?: number
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
  const [policyNotice, setPolicyNotice] = useState(false)

  useEffect(() => {
    window.api
      .policyNotice()
      .then(setPolicyNotice)
      .catch(() => setPolicyNotice(false))
  }, [])

  const refreshPermissions = useCallback((): void => {
    window.api.permissionsCheck().then(setPermissions).catch(() => setPermissions(null))
  }, [])

  useEffect(() => {
    const loadProfile = (): void => {
      window.api
        .profile()
        .then((value) => setProfile(value as Profile))
        .catch(() => setProfile(null))
    }
    // The profile used to load only on a pushed auth event, so an app that
    // started already signed in never showed the quota.
    window.api.authState().then((state) => {
      setAuth(state)
      if (state.signedIn) loadProfile()
    })
    window.api
      .settingsGet()
      .then(setSettings)
      .catch(() => setSettings(null))
    window.api.getVersion().then(setVersion)
    window.api.getLoginItem().then(setLoginItem)
    refreshPermissions()
    return window.api.onAuthState((state) => {
      setAuth(state)
      if (state.signedIn) loadProfile()
      else setProfile(null)
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
        {policyNotice && (
          <div className="card undo">
            <span>
              Sync no longer needs a recovery key: your history and dictionary are stored encrypted
              in your WoVoice account.
            </span>
            <button
              className="action secondary"
              onClick={() => {
                void window.api.dismissPolicyNotice()
                setPolicyNotice(false)
              }}
            >
              Got it
            </button>
          </div>
        )}
        {tab === 'home' && (
          <HomeTab
            signedIn={auth.signedIn}
            triggerLabel={triggerLabel(settings?.triggerKey ?? 'option')}
            middleClick={settings?.middleClickEnabled === true}
          />
        )}
        {tab === 'history' && <HistoryTab />}
        {tab === 'dictionary' && <DictionaryTab />}
        {tab === 'account' && (
          <>
            <div className="hero">
              <h1>Account</h1>
              <p>Your WoVoice session lives in this Mac&apos;s Keychain.</p>
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
                        <span className="label">Today&apos;s quota</span>
                        <span className="value">
                          {Math.round(profile.quota.remainingAudioSeconds)} of{' '}
                          {Math.round(profile.quota.limitAudioSeconds)} seconds left
                        </span>
                      </div>
                      {profile.quota.resetAt !== undefined && (
                        <div className="stat-row">
                          <span className="label">Quota resets</span>
                          <span className="value">
                            {new Date(profile.quota.resetAt).toLocaleTimeString([], {
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

/** "⌥ Left Option (default)" → "⌥ Left Option", for sentences about the chosen key. */
function triggerLabel(triggerKey: string): string {
  const option = TRIGGER_KEY_OPTIONS.find((candidate) => candidate.id === triggerKey)
  return (option?.label ?? '⌥ Left Option').replace(' (default)', '')
}

function HomeTab({
  signedIn,
  triggerLabel,
  middleClick
}: {
  signedIn: boolean
  triggerLabel: string
  middleClick: boolean
}): React.JSX.Element {
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
        <p>
          Hold {triggerLabel}
          {middleClick ? ' (or middle-click)' : ''} anywhere on your Mac to dictate.
        </p>
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
              ? `Nothing yet — hold ${triggerLabel} anywhere and speak.`
              : `Sign in, then hold ${triggerLabel} anywhere and speak.`}
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
  const [undoError, setUndoError] = useState<string | null>(null)

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
    void window.api.historyRestore(undo.requestId).then((restored) => {
      refresh(query)
      setUndo(null)
      setUndoError(restored ? null : 'Too late to undo — the deletion already synced.')
    })
  }

  return (
    <>
      <div className="hero">
        <h1>History</h1>
        <p>Dictations inserted on this Mac. Search, copy, delete with undo.</p>
      </div>
      {undoError !== null && undo === null && <p className="error">{undoError}</p>}
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

const RETENTION_OPTIONS: Array<[number | null, string]> = [
  [null, 'Never'],
  [30, 'After 30 days'],
  [90, 'After 90 days'],
  [365, 'After 1 year']
]

function SyncCard({ signedIn }: { signedIn: boolean }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [status, setStatus] = useState<{
    lastSyncAt: number
    historySyncEnabled: boolean
    historyRetentionDays: number | null
  } | null>(null)

  const refreshStatus = useCallback((): void => {
    window.api
      .syncStatus()
      .then(setStatus)
      .catch(() => setStatus(null))
  }, [])

  useEffect(() => {
    if (signedIn) refreshStatus()
  }, [signedIn, refreshStatus])

  const runSync = (): void => {
    setBusy(true)
    setResult(null)
    window.api
      .syncNow()
      .then((outcome) => {
        if (outcome.kind === 'ok') {
          setResult(
            outcome.warning ??
              `Synced — ${outcome.uploaded ?? 0} sent, ${outcome.downloaded ?? 0} received.`
          )
        } else {
          setResult(outcome.message ?? 'Sync failed.')
        }
      })
      .catch(() => setResult('Sync failed.'))
      .finally(() => {
        setBusy(false)
        refreshStatus()
      })
  }

  const update = (changes: { historySyncEnabled?: boolean; historyRetentionDays?: number | null }): void => {
    setBusy(true)
    window.api
      .updateSyncSettings(changes)
      .then((outcome) => {
        if (!outcome.ok && !outcome.cancelled) setResult(outcome.message ?? 'The setting could not be saved.')
      })
      .catch(() => setResult('The setting could not be saved.'))
      .finally(() => {
        setBusy(false)
        refreshStatus()
      })
  }

  if (!signedIn) {
    return (
      <div className="card">
        <h2>Cloud sync</h2>
        <p className="muted">Sign in and your history and dictionary follow you to every device.</p>
      </div>
    )
  }

  return (
    <div className="card">
      <h2>Cloud sync</h2>
      <p>
        History and dictionary sync through your WoVoice account, encrypted on WoVoice&apos;s
        servers. Signing in on another device is all it takes.
      </p>
      <div className="stat-row">
        <span className="label">Last synced</span>
        <span className="value">
          {status === null || status.lastSyncAt === 0 ? 'Not yet' : formatWhen(status.lastSyncAt)}
        </span>
      </div>
      <div className="stat-row">
        <span className="label">Sync history</span>
        <button
          className={`action ${status?.historySyncEnabled === false ? 'secondary' : ''}`}
          disabled={busy || status === null}
          onClick={() => update({ historySyncEnabled: !(status?.historySyncEnabled ?? true) })}
        >
          {status === null ? '—' : status.historySyncEnabled ? 'On' : 'Off'}
        </button>
      </div>
      <div className="stat-row">
        <span className="label">Auto-delete history</span>
        <select
          className="select"
          disabled={busy || status === null}
          value={String(status?.historyRetentionDays ?? 'never')}
          onChange={(event) =>
            update({
              historyRetentionDays: event.target.value === 'never' ? null : Number(event.target.value)
            })
          }
        >
          {RETENTION_OPTIONS.map(([days, label]) => (
            <option key={label} value={days === null ? 'never' : String(days)}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <p>
        <button className="action" onClick={runSync} disabled={busy}>
          {busy ? 'Syncing…' : 'Sync now'}
        </button>
      </p>
      {result !== null && <p className="mono">{result}</p>}
    </div>
  )
}

export default Dashboard

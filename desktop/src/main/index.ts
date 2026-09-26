import {
  app,
  shell,
  clipboard,
  dialog,
  globalShortcut,
  BrowserWindow,
  Menu,
  Tray,
  ipcMain,
  systemPreferences,
  nativeImage
} from 'electron'
import { join } from 'path'
import { unlinkSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import trayTemplate from '../../resources/trayTemplate@2x.png?asset'
import { SettingsStore } from './store'
import { SessionStore } from './session'
import { WorkerClient, type WorkerTokens } from './worker'
import { DesktopAuth } from './auth'
import { openDatabase } from './db'
import { SyncService } from './sync'
import { DictationService } from './dictation'
import { TriggerEngine, TRIGGER_KEYS, releaseHint } from './triggers'

// Claim the single instance before any module-level work: the check used to run
// only after app ready, so a second launch still opened the database and rewrote
// settings before quitting.
const primaryInstance = app.requestSingleInstanceLock()
if (!primaryInstance) app.quit()

let dashboard: BrowserWindow | null = null
let tray: Tray | null = null
let desktopAuth: DesktopAuth | null = null

const settings = new SettingsStore()
// Builds before lastAccountId existed only knew the signed-in account.
if (primaryInstance && settings.get<string | null>('lastAccountId', null) === null) {
  const current = settings.get<string | null>('accountId', null)
  if (current !== null) settings.set('lastAccountId', current)
}
const worker = new WorkerClient(settings.workerUrl)
// Desktop-owned database file: the abandoned Compose build left a Room-schema
// wovoice-local.db here whose shape is incompatible; never reuse that name.
const db = openDatabase(join(app.getPath('userData'), 'wovoice-desktop.db'))
const sync = new SyncService({
  worker,
  settings: {
    workerUrl: settings.workerUrl,
    getAccountId: () => settings.get<string | null>('accountId', null),
    getCursor: () => settings.syncCursor,
    setCursor: (value) => {
      settings.syncCursor = value
    },
    getMigratedAccount: () => settings.cloudSyncMigratedAccount,
    setMigratedAccount: (value) => {
      settings.cloudSyncMigratedAccount = value
    },
    getHistorySyncEnabled: () => settings.historySyncEnabled,
    setHistorySyncEnabled: (value) => {
      settings.historySyncEnabled = value
    },
    getRetentionDays: () => settings.historyRetentionDays,
    setRetentionDays: (value) => {
      settings.historyRetentionDays = value
    },
    setLastSyncAt: (value) => {
      settings.lastSyncAt = value
    }
  },
  db,
  getToken: async () => session.accessToken(),
  invalidateToken: (token) => session.invalidateAccessToken(token),
  vaultDir: app.getPath('userData')
})
const session = new SessionStore(
  (refreshToken) =>
    worker.refresh(refreshToken).then((tokens) => ({
      accessToken: tokens.accessToken,
      accessExpiresInSeconds: tokens.accessExpiresIn,
      refreshToken: tokens.refreshToken
    })),
  () => broadcastAuthState()
)

const dictation = new DictationService({
  settings,
  getToken: async () => {
    const token = await session.accessToken()
    return token
  },
  invalidateToken: (token) => session.invalidateAccessToken(token),
  getGlossary: async () => db.bestGlossary(100),
  transcribe: (token, wav, glossary) => worker.transcribe(token, wav, glossary),
  onSessionAborted: () => triggers.reset(),
  recordHistory: (entry) => {
    const now = new Date()
    db.insertRecord({
      requestId: entry.requestId !== '' ? entry.requestId : crypto.randomUUID(),
      finalText: entry.text,
      createdAtMs: now.getTime(),
      zoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
      wordCount: countWords(entry.text),
      audioDurationMs: entry.durationMs,
      asrModel: entry.asrModel,
      polished: entry.polished,
      asrMs: entry.timingsMs.asr,
      polishMs: entry.timingsMs.polish,
      totalMs: entry.timingsMs.total,
      deleted: false
    })
    db.recordUsage(db.bestGlossary(100), entry.text)
    broadcastAuthState({ lastDictation: entry.text })
    void sync.syncNow()
  }
})

function countWords(text: string): number {
  const matches = text.match(/[\p{L}\p{N}]+(?:['’\u2010-\u2015-][\p{L}\p{N}]+)*/gu)
  return matches === null ? 0 : matches.length
}

const triggers = new TriggerEngine(
  {
    get keyboardShortcutEnabled() {
      return settings.get<boolean>('keyboardShortcutEnabled', true)
    },
    get middleClickEnabled() {
      return settings.get<boolean>('middleClickEnabled', false)
    },
    get triggerKey() {
      return settings.get<string>('triggerKey', 'option')
    }
  },
  (trigger): void => dictation.begin(releaseHint(trigger, settings.get<string>('triggerKey', 'option'))),
  (): void => dictation.end()
)

function broadcastAuthState(extra: Record<string, unknown> = {}): void {
  dashboard?.webContents.send('auth:state', {
    signedIn: session.hasRefreshToken,
    email: settings.get<string | null>('accountEmail', null),
    ...extra
  })
  rebuildTrayMenu()
}

// Shown once in the dashboard when the Privacy Policy changes in a way users should see.
const POLICY_VERSION = '2026-09-26-cloud-sync'

// A sign-in attempt left open this long (browser abandoned) releases its
// loopback listener so later attempts can start.
const SIGN_IN_TIMEOUT_MS = 5 * 60_000

// The dashboard offers a 5-second undo after a history delete. Pushing the
// tombstone immediately made that undo a no-op, so the push waits it out.
const HISTORY_UNDO_WINDOW_MS = 6_000
let deferredSync: ReturnType<typeof setTimeout> | null = null

function scheduleSync(delayMs: number): void {
  if (deferredSync !== null) clearTimeout(deferredSync)
  deferredSync = setTimeout(() => {
    deferredSync = null
    void sync.syncNow()
  }, delayMs)
}

function removeVaultFiles(): void {
  for (const name of ['vault-key.bin', 'recovery-secret.bin']) {
    try {
      unlinkSync(join(app.getPath('userData'), name))
    } catch {
      // absent — nothing to clean
    }
  }
}

/**
 * The local database is not partitioned by account. When a different account
 * signs in, the previous account's history and dictionary would show here and
 * be pushed into the new account's vault, so they are removed first (after the
 * user confirms). Returns false when the user cancels the sign-in.
 */
async function adoptAccount(tokens: WorkerTokens): Promise<boolean> {
  const previous = settings.get<string | null>('lastAccountId', null)
  if (previous === null) {
    // Data left by a build that did not record its account (signed out before
    // this version): its owner is unknown, so let the user decide.
    const counts = db.localDataCounts()
    if (counts.history + counts.dictionary > 0) {
      const { response } = await dialog.showMessageBox({
        type: 'question',
        buttons: ['Keep with this account', 'Remove from this Mac', 'Cancel sign-in'],
        defaultId: 0,
        cancelId: 2,
        message: `Is the data on this Mac yours, ${tokens.user.email}?`,
        detail:
          `This Mac holds ${counts.history} dictation${counts.history === 1 ? '' : 's'} and ` +
          `${counts.dictionary} dictionary term${counts.dictionary === 1 ? '' : 's'} from an earlier ` +
          'sign-in. Keep them only if they belong to this account — kept items sync into its encrypted vault.'
      })
      if (response === 2) return false
      if (response === 1) {
        db.clearAllData()
        removeVaultFiles()
        settings.syncCursor = 0
      }
    }
  } else if (previous !== tokens.user.id) {
    const counts = db.localDataCounts()
    if (counts.history + counts.dictionary > 0) {
      const lost =
        counts.unsynced > 0
          ? ` ${counts.unsynced} change${counts.unsynced === 1 ? '' : 's'} that never synced will be lost.`
          : ''
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['Remove and continue', 'Cancel sign-in'],
        defaultId: 1,
        cancelId: 1,
        message: `Sign in as ${tokens.user.email}?`,
        detail:
          'This Mac holds history and dictionary items from a different WoVoice account. ' +
          'They will be removed from this Mac so they never mix with or sync into this account. ' +
          `Anything already synced stays in the other account's encrypted vault.${lost}`
      })
      if (response !== 0) return false
    }
    db.clearAllData()
    removeVaultFiles()
    settings.syncCursor = 0
  }
  settings.set('lastAccountId', tokens.user.id)
  return true
}

function startSignIn(): void {
  if (desktopAuth !== null) return
  const auth = new DesktopAuth(
    settings.workerUrl,
    (authorizationCode) => {
      const finish = (): void => {
        auth.dispose()
        if (desktopAuth === auth) desktopAuth = null
      }
      try {
        const request = auth.buildTokenRequest(authorizationCode)
        worker
          .exchangeAuthorizationCode(request)
          .then(async (tokens) => {
            if (!(await adoptAccount(tokens))) {
              await worker.logout(tokens.accessToken).catch(() => undefined)
              broadcastAuthState({ signedIn: false, error: 'Sign-in cancelled.' })
              return
            }
            session.storeTokens(tokens.accessToken, tokens.accessExpiresIn, tokens.refreshToken)
            settings.set('accountId', tokens.user.id)
            settings.set('accountEmail', tokens.user.email)
            broadcastAuthState({ signedIn: true, email: tokens.user.email })
            showDashboard()
          })
          .catch((error: Error) => broadcastAuthState({ signedIn: false, error: error.message }))
          .finally(finish)
      } catch (error) {
        broadcastAuthState({
          signedIn: false,
          error: error instanceof Error ? error.message : 'Sign-in failed.'
        })
        finish()
      }
    },
    (message) => {
      broadcastAuthState({ signedIn: false, error: message })
      auth.dispose()
      if (desktopAuth === auth) desktopAuth = null
    }
  )
  desktopAuth = auth
  const release = (): void => {
    auth.dispose()
    if (desktopAuth === auth) desktopAuth = null
  }
  auth.start()
    .then((result) => {
      if (!result.ok) {
        broadcastAuthState({ signedIn: false, error: result.message })
        release()
      }
    })
    .catch((error: Error) => {
      broadcastAuthState({ signedIn: false, error: error.message })
      release()
    })
  setTimeout(() => {
    if (desktopAuth === auth) release()
  }, SIGN_IN_TIMEOUT_MS).unref()
}

async function signOut(): Promise<void> {
  const token = session.validAccessToken
  if (token !== null) {
    try {
      await worker.logout(token)
    } catch {
      // best effort — the local session is cleared regardless
    }
  }
  session.clear()
  settings.clearAccount()
  // Vault secrets are device-scoped files; leaving them behind would let a
  // later sign-in to a different account reuse the previous account's key.
  removeVaultFiles()
  broadcastAuthState({ signedIn: false })
}

function createDashboard(): void {
  dashboard = new BrowserWindow({
    width: 980,
    height: 720,
    show: false,
    autoHideMenuBar: true,
    title: 'WoVoice',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  dashboard.on('ready-to-show', () => {
    dashboard?.show()
  })

  dashboard.on('closed', () => {
    dashboard = null
  })

  dashboard.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    dashboard.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    dashboard.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function showDashboard(): void {
  if (dashboard === null) createDashboard()
  else dashboard.show()
}

function rebuildTrayMenu(): void {
  if (tray === null || tray.isDestroyed()) return
  const email = settings.get<string | null>('accountEmail', null)
  const signedIn = session.hasRefreshToken
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'WoVoice dashboard', click: showDashboard },
      signedIn
        ? { label: email ?? 'Signed in', enabled: false }
        : { label: 'Sign in…', click: startSignIn },
      ...(signedIn ? [{ label: 'Sign out', click: (): void => { void signOut() } }] : []),
      { type: 'separator' },
      {
        label: 'Quit WoVoice',
        click: (): void => {
          triggers.unregister()
          app.quit()
        }
      }
    ])
  )
}

function createTray(): void {
  // Monochrome waveform template image — macOS tints it for dark/light menu
  // bars. Rendered at 16pt from the @2x asset; the color icon is Dock-only.
  const trayImage = nativeImage.createFromPath(trayTemplate).resize({ width: 16, height: 16 })
  trayImage.setTemplateImage(true)
  tray = new Tray(trayImage)
  tray.setToolTip('WoVoice')
  rebuildTrayMenu()
  tray.on('click', showDashboard)
}

// wovoice:// links can arrive before the app is ready (a cold launch from the
// browser hand-off page); the handler registered inside whenReady missed them.
let pendingDeepLink: string | null = null
app.on('open-url', (event, url) => {
  event.preventDefault()
  if (app.isReady()) routeDeepLink(url)
  else pendingDeepLink = url
})

app.whenReady().then(() => {
  if (!primaryInstance) return

  app.on('second-instance', showDashboard)

  // wovoice:// deep link: sign-in callback fallback when launched or activated
  // by the browser hand-off page.
  app.setAsDefaultProtocolClient('wovoice')
  electronApp.setAppUserModelId('com.aliahad.wovoice.desktop')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('auth:start', () => startSignIn())
  ipcMain.handle('auth:signOut', () => signOut())
  ipcMain.handle('auth:state', () => ({
    signedIn: session.hasRefreshToken,
    email: settings.get<string | null>('accountEmail', null)
  }))
  ipcMain.handle('auth:profile', async () => {
    const token = await session.accessToken()
    return worker.profile(token)
  })
  ipcMain.handle('permissions:check', async () => ({
    accessibility: await accessibilityTrusted(),
    mic: systemPreferences.getMediaAccessStatus('microphone')
  }))
  ipcMain.handle('permissions:enableMicrophone', async () => {
    const status = systemPreferences.getMediaAccessStatus('microphone')
    if (status === 'granted') return true
    // Fires the native microphone consent dialog when undetermined.
    return systemPreferences.askForMediaAccess('microphone')
  })
  ipcMain.handle('permissions:openAccessibilityPane', () => {
    void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
  })
  ipcMain.handle('permissions:openListenPane', () => {
    void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent')
    // The tap may register late once the user grants the toggle.
    setTimeout(() => triggers.registerIfMissing(), 1_500)
  })
  ipcMain.handle('permissions:enableAccessibility', async () => {
    // Registers WoVoice in the Accessibility list and shows the system prompt.
    if (systemPreferences.isTrustedAccessibilityClient(true)) return true
    void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
    return false
  })
  ipcMain.handle('settings:get', () => ({
    keyboardShortcutEnabled: settings.get<boolean>('keyboardShortcutEnabled', true),
    middleClickEnabled: settings.get<boolean>('middleClickEnabled', false),
    triggerKey: settings.get<string>('triggerKey', 'option'),
    workerUrl: settings.workerUrl
  }))
  ipcMain.handle('settings:set', (_event, key: string, value: unknown) => {
    if (key === 'keyboardShortcutEnabled' || key === 'middleClickEnabled') {
      if (typeof value !== 'boolean') return false
      settings.set(key, value)
      if (value) triggers.registerIfMissing()
      return true
    }
    if (key === 'triggerKey') {
      if (typeof value !== 'string' || !TRIGGER_KEYS.includes(value)) return false
      settings.set(key, value)
      triggers.restart()
      return true
    }
    return false
  })
  ipcMain.handle('triggers:status', () => triggers.isRegistered())
  ipcMain.handle('triggers:reregister', () => {
    triggers.unregister()
    triggers.register()
    return triggers.isRegistered()
  })
  ipcMain.handle('stats:home', (_event, period: string) => {
    // Calendar days in local time, matching the phone: "7 days" is today plus
    // the six days before it, not a rolling 144 hours.
    const daysBack = period === 'today' ? 0 : period === '7d' ? 6 : period === '30d' ? 29 : null
    const today = new Date()
    const since =
      daysBack === null
        ? 0
        : new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysBack).getTime()
    return db.stats(since)
  })
  ipcMain.handle('history:list', (_event, query: string) => db.historySearch(query))
  ipcMain.handle('history:delete', (_event, requestId: string) => {
    db.deleteRecord(requestId)
    scheduleSync(HISTORY_UNDO_WINDOW_MS)
  })
  ipcMain.handle('history:restore', (_event, requestId: string) => {
    const restored = db.restoreRecord(requestId)
    if (restored) void sync.syncNow()
    return restored
  })
  ipcMain.handle('history:copy', (_event, text: string) => {
    clipboard.writeText(text)
  })
  ipcMain.handle('dictionary:list', (_event, query: string) => db.listTerms(query))
  ipcMain.handle('dictionary:add', (_event, term: string) => {
    const added = db.addTerm(term)
    if (added) void sync.syncNow()
    return added
  })
  ipcMain.handle('dictionary:delete', (_event, id: number) => {
    db.deleteTerm(id)
    void sync.syncNow()
  })
  ipcMain.handle('sync:now', () => sync.syncNow())
  ipcMain.handle('sync:status', () => ({
    lastSyncAt: settings.lastSyncAt,
    historySyncEnabled: settings.historySyncEnabled,
    historyRetentionDays: settings.historyRetentionDays
  }))
  ipcMain.handle(
    'sync:updateSettings',
    async (_event, changes: { historySyncEnabled?: unknown; historyRetentionDays?: unknown }) => {
      const update: { historySyncEnabled?: boolean; historyRetentionDays?: number | null } = {}
      if (typeof changes?.historySyncEnabled === 'boolean') {
        if (!changes.historySyncEnabled) {
          const { response } = await dialog.showMessageBox({
            type: 'warning',
            buttons: ['Stop and delete', 'Keep syncing'],
            defaultId: 1,
            cancelId: 1,
            message: 'Stop syncing history?',
            detail:
              'WoVoice will delete the dictated text stored in your account. History already on this ' +
              'Mac and your other devices stays there; new dictations stay on the device that made them.'
          })
          if (response !== 0) return { ok: false, cancelled: true }
        }
        update.historySyncEnabled = changes.historySyncEnabled
      }
      if (changes?.historyRetentionDays === null || [30, 90, 365].includes(Number(changes?.historyRetentionDays))) {
        update.historyRetentionDays = changes.historyRetentionDays === null ? null : Number(changes.historyRetentionDays)
      }
      try {
        const updated = await sync.updateSettings(update)
        if (update.historySyncEnabled === true) void sync.syncNow()
        return { ok: true, settings: updated }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : 'The setting could not be saved.' }
      }
    }
  )
  ipcMain.handle('app:policyNotice', () => settings.get<string | null>('acknowledgedPolicyVersion', null) !== POLICY_VERSION)
  ipcMain.handle('app:dismissPolicyNotice', () => {
    settings.set('acknowledgedPolicyVersion', POLICY_VERSION)
  })
  ipcMain.handle('app:setLoginItem', (_event, openAtLogin: boolean) => {
    app.setLoginItemSettings({ openAtLogin })
    return app.getLoginItemSettings().openAtLogin
  })
  ipcMain.handle('app:getLoginItem', () => app.getLoginItemSettings().openAtLogin)


  ipcMain.on('overlay:done', (_event, payload: { wav: ArrayBuffer; durationMs: number; containsSpeech: boolean }) => {
    console.log('[overlay] done received:', payload.durationMs, 'ms, speech =', payload.containsSpeech)
    void dictation.handleCapture(payload)
  })
  ipcMain.on('overlay:cancelled', () => dictation.cancelUser())
  ipcMain.on('overlay:autoStop', () => dictation.autoStop())
  ipcMain.on('overlay:fail', (_event, message: string) => dictation.fail(message))
  ipcMain.on('overlay:label', () => {
    // The overlay owns its label during capture; forwarded updates ignored in v1.
  })

  triggers.register()
  createDashboard()
  try {
    createTray()
  } catch (error) {
    // Cosmetic — a tray failure must never take down dictation setup.
    console.error('[tray] failed:', error)
  }
  dictation.prepare()

  app.on('activate', () => {
    showDashboard()
  })

  if (pendingDeepLink !== null) {
    routeDeepLink(pendingDeepLink)
    pendingDeepLink = null
  }
})

app.on('second-instance', (_event, argv) => {
  const url = argv.find((value) => value.startsWith('wovoice://'))
  if (url !== undefined) routeDeepLink(url)
})

async function accessibilityTrusted(): Promise<boolean> {
  // The old probe asked System Events to count processes, which measures the
  // Automation (Apple Events) grant — not Accessibility — so it reported
  // "granted" while pastes and the trigger tap were still blocked, and it could
  // raise an unrelated Automation prompt just by opening Settings.
  return process.platform !== 'darwin' || systemPreferences.isTrustedAccessibilityClient(false)
}

function routeDeepLink(value: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return // malformed wovoice:// URL from the OS — nothing to route
  }
  if (url.hostname !== 'callback' && url.pathname !== '/callback') return
  const code = url.searchParams.get('code') ?? ''
  const state = url.searchParams.get('state') ?? ''
  desktopAuth?.handleExternalCallback(code, state)
  showDashboard()
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  // Tray keeps the app alive on macOS; quit only via the tray menu.
})

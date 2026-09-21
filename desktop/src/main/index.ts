import { app, shell, clipboard, globalShortcut, BrowserWindow, Menu, Tray, ipcMain, systemPreferences, nativeImage } from 'electron'
import { spawn } from 'child_process'
import { join } from 'path'
import { unlinkSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import trayTemplate from '../../resources/trayTemplate@2x.png?asset'
import { SettingsStore } from './store'
import { SessionStore } from './session'
import { WorkerClient } from './worker'
import { DesktopAuth } from './auth'
import { openDatabase } from './db'
import { SyncService } from './sync'
import { DictationService } from './dictation'
import { TriggerEngine, TRIGGER_KEYS } from './triggers'

let dashboard: BrowserWindow | null = null
let tray: Tray | null = null
let desktopAuth: DesktopAuth | null = null

const settings = new SettingsStore()
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
    }
  },
  db,
  getToken: async () => session.accessToken(),
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
  getGlossary: async () => db.bestGlossary(100),
  transcribe: (token, wav, glossary) => worker.transcribe(token, wav, glossary),
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
      asrMs: 0,
      polishMs: 0,
      totalMs: 0,
      deleted: false
    })
    db.recordUsage(db.bestGlossary(100), entry.text)
    broadcastAuthState({ lastDictation: entry.text })
    void sync.syncNow().then((outcome) => {
      if (outcome.kind === 'needs-recovery') broadcastAuthState({ syncNeedsRecovery: true })
    })
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
  (): void => dictation.begin(),
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

// A sign-in attempt left open this long (browser abandoned) releases its
// loopback listener so later attempts can start.
const SIGN_IN_TIMEOUT_MS = 5 * 60_000

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
          .then((tokens) => {
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
  for (const name of ['vault-key.bin', 'recovery-secret.bin']) {
    try {
      unlinkSync(join(app.getPath('userData'), name))
    } catch {
      // absent — nothing to clean
    }
  }
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

app.whenReady().then(() => {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

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
    // Electron has no accessibility probe; the paste path itself reveals it.
    // Opening the pane is the pragmatic prompt on denied/undetermined states.
    void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
    return true
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
    const now = Date.now()
    const dayStart = new Date().setHours(0, 0, 0, 0)
    const since = period === 'today' ? dayStart
      : period === '7d' ? now - 6 * 86_400_000
      : period === '30d' ? now - 29 * 86_400_000
      : 0
    return db.stats(since)
  })
  ipcMain.handle('history:list', (_event, query: string) => db.historySearch(query))
  ipcMain.handle('history:delete', (_event, requestId: string) => {
    db.deleteRecord(requestId)
    void sync.syncNow()
  })
  ipcMain.handle('history:restore', (_event, requestId: string) => db.restoreRecord(requestId))
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
  ipcMain.handle('sync:importKey', (_event, key: string) => sync.importRecoveryKey(key))
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

  app.on('open-url', (event, url) => {
    event.preventDefault()
    routeDeepLink(url)
  })
})

app.on('second-instance', (_event, argv) => {
  const url = argv.find((value) => value.startsWith('wovoice://'))
  if (url !== undefined) routeDeepLink(url)
})

async function accessibilityTrusted(): Promise<boolean> {
  // System Events responds only when the app is trusted for accessibility.
  const probe = spawn('osascript', ['-e', 'tell application "System Events" to count application processes'], {
    stdio: 'ignore'
  })
  const code: number = await new Promise((resolve, reject) => {
    probe.on('exit', resolve)
    probe.on('error', reject)
  })
  return code === 0
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

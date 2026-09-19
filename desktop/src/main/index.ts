import { app, shell, clipboard, BrowserWindow, Menu, Tray, ipcMain, systemPreferences } from 'electron'
import { spawn } from 'child_process'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { SettingsStore } from './store'
import { SessionStore } from './session'
import { WorkerClient } from './worker'
import { DesktopAuth } from './auth'
import { openDatabase } from './db'
import { DictationService } from './dictation'
import { TriggerEngine } from './triggers'

let dashboard: BrowserWindow | null = null
let tray: Tray | null = null
let desktopAuth: DesktopAuth | null = null

const settings = new SettingsStore()
const worker = new WorkerClient(settings.workerUrl)
// Desktop-owned database file: the abandoned Compose build left a Room-schema
// wovoice-local.db here whose shape is incompatible; never reuse that name.
const db = openDatabase(join(app.getPath('userData'), 'wovoice-desktop.db'))
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
}

function startSignIn(): void {
  if (desktopAuth !== null) return
  desktopAuth = new DesktopAuth(
    settings.workerUrl,
    (authorizationCode) => {
      const request = desktopAuth?.buildTokenRequest(authorizationCode)
      if (request === undefined) return
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
    },
    (message) => broadcastAuthState({ signedIn: false, error: message })
  )
  void desktopAuth.start().then((result) => {
    if (!result.ok) broadcastAuthState({ signedIn: false, error: result.message })
  })
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

function createTray(): void {
  tray = new Tray(icon)
  tray.setToolTip('WoVoice')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'WoVoice dashboard', click: showDashboard },
      { label: 'Sign in…', click: startSignIn },
      { type: 'separator' },
      { label: 'Quit WoVoice', click: (): void => {
        triggers.unregister()
        app.quit()
      } }
    ])
  )
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
    workerUrl: settings.workerUrl
  }))
  ipcMain.handle('settings:set', (_event, key: string, value: boolean) => {
    if (key !== 'keyboardShortcutEnabled' && key !== 'middleClickEnabled') return false
    settings.set(key, value)
    return true
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
  ipcMain.handle('history:delete', (_event, requestId: string) => db.deleteRecord(requestId))
  ipcMain.handle('history:restore', (_event, requestId: string) => db.restoreRecord(requestId))
  ipcMain.handle('history:copy', (_event, text: string) => {
    clipboard.writeText(text)
  })
  ipcMain.handle('dictionary:list', (_event, query: string) => db.listTerms(query))
  ipcMain.handle('dictionary:add', (_event, term: string) => db.addTerm(term))
  ipcMain.handle('dictionary:delete', (_event, id: number) => db.deleteTerm(id))
  ipcMain.handle('app:setLoginItem', (_event, openAtLogin: boolean) => {
    app.setLoginItemSettings({ openAtLogin })
    return app.getLoginItemSettings().openAtLogin
  })
  ipcMain.handle('app:getLoginItem', () => app.getLoginItemSettings().openAtLogin)


  ipcMain.on('overlay:done', (_event, payload: { wav: ArrayBuffer; durationMs: number; containsSpeech: boolean }) => {
    void dictation.handleCapture(payload)
  })
  ipcMain.on('overlay:cancelled', () => dictation.cancel())
  ipcMain.on('overlay:fail', (_event, message: string) => dictation.fail(message))
  ipcMain.on('overlay:label', () => {
    // The overlay owns its label during capture; forwarded updates ignored in v1.
  })

  triggers.register()
  createDashboard()
  createTray()

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
  const url = new URL(value)
  if (url.hostname !== 'callback' && url.pathname !== '/callback') return
  const code = url.searchParams.get('code') ?? ''
  const state = url.searchParams.get('state') ?? ''
  desktopAuth?.handleExternalCallback(code, state)
  showDashboard()
}

app.on('window-all-closed', () => {
  // Tray keeps the app alive on macOS; quit only via the tray menu.
})

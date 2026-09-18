import { app, shell, BrowserWindow, Menu, Tray, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { SettingsStore } from './store'
import { SessionStore } from './session'
import { WorkerClient } from './worker'
import { DesktopAuth } from './auth'

let dashboard: BrowserWindow | null = null
let tray: Tray | null = null
let desktopAuth: DesktopAuth | null = null

const settings = new SettingsStore()
const worker = new WorkerClient(settings.workerUrl)
const session = new SessionStore(
  (refreshToken) =>
    worker.refresh(refreshToken).then((tokens) => ({
      accessToken: tokens.accessToken,
      accessExpiresInSeconds: tokens.accessExpiresIn,
      refreshToken: tokens.refreshToken
    })),
  () => broadcastAuthState()
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
      { label: 'Quit WoVoice', click: (): void => app.quit() }
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

  createDashboard()
  createTray()

  app.on('activate', () => {
    showDashboard()
  })
})

app.on('window-all-closed', () => {
  // Tray keeps the app alive on macOS; quit only via the tray menu.
})

import { app, shell, BrowserWindow, Menu, Tray, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

let dashboard: BrowserWindow | null = null
let tray: Tray | null = null

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
      { type: 'separator' },
      { label: 'Quit WoVoice', click: (): void => app.quit() }
    ])
  )
  tray.on('click', showDashboard)
}

app.whenReady().then(() => {
  // Single instance: a second launch just shows the dashboard.
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

  createDashboard()
  createTray()

  app.on('activate', () => {
    showDashboard()
  })
})

app.on('window-all-closed', () => {
  // Tray keeps the app alive on macOS; quit only via the tray menu.
})

import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  signIn: (): Promise<{ ok: boolean; message?: string }> => ipcRenderer.invoke('auth:start'),
  signOut: (): Promise<void> => ipcRenderer.invoke('auth:signOut'),
  authState: (): Promise<{ signedIn: boolean; email: string | null }> =>
    ipcRenderer.invoke('auth:state'),
  profile: (): Promise<unknown> => ipcRenderer.invoke('auth:profile'),
  onAuthState: (listener: (state: { signedIn: boolean; email?: string | null; error?: string }) => void): (() => void) => {
    const wrapped = (_event: unknown, state: { signedIn: boolean; email?: string | null; error?: string }): void =>
      listener(state)
    ipcRenderer.on('auth:state', wrapped)
    return () => ipcRenderer.removeListener('auth:state', wrapped)
  },
  permissionsCheck: (): Promise<{ accessibility: boolean; mic: string }> =>
    ipcRenderer.invoke('permissions:check'),
  enableMicrophone: (): Promise<boolean> => ipcRenderer.invoke('permissions:enableMicrophone'),
  openAccessibilityPane: (): Promise<void> => ipcRenderer.invoke('permissions:openAccessibilityPane'),
  openListenPane: (): Promise<void> => ipcRenderer.invoke('permissions:openListenPane'),
  settingsGet: (): Promise<{ keyboardShortcutEnabled: boolean; middleClickEnabled: boolean; workerUrl: string }> =>
    ipcRenderer.invoke('settings:get'),
  settingsSet: (key: 'keyboardShortcutEnabled' | 'middleClickEnabled', value: boolean): Promise<boolean> =>
    ipcRenderer.invoke('settings:set', key, value),
  overlay: {
    done: (payload: { wav: ArrayBuffer; durationMs: number; containsSpeech: boolean }): void =>
      ipcRenderer.send('overlay:done', payload),
    cancelled: (): void => ipcRenderer.send('overlay:cancelled'),
    fail: (message: string): void => ipcRenderer.send('overlay:fail', message),
    setLabel: (text: string): void => ipcRenderer.send('overlay:label', text),
    onBegin: (listener: () => void): void => {
      ipcRenderer.on('overlay:begin', () => listener())
    },
    onEnd: (listener: () => void): void => {
      ipcRenderer.on('overlay:end', () => listener())
    },
    onCancel: (listener: () => void): void => {
      ipcRenderer.on('overlay:cancel', () => listener())
    }
  }
}

export type Api = typeof api

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}

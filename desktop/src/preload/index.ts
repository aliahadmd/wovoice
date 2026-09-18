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

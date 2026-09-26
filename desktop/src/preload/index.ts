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
  settingsGet: (): Promise<{
    keyboardShortcutEnabled: boolean
    middleClickEnabled: boolean
    triggerKey: string
    workerUrl: string
  }> => ipcRenderer.invoke('settings:get'),
  settingsSet: (
    key: 'keyboardShortcutEnabled' | 'middleClickEnabled' | 'triggerKey',
    value: boolean | string
  ): Promise<boolean> => ipcRenderer.invoke('settings:set', key, value),
  homeStats: (period: 'today' | '7d' | '30d' | 'all'): Promise<{
    dictations: number
    audioDurationMs: number
    words: number
    recent: Array<{ requestId: string; finalText: string; createdAtMs: number; wordCount: number; audioDurationMs: number }>
  }> => ipcRenderer.invoke('stats:home', period),
  historyList: (query: string): Promise<Array<{
    requestId: string
    finalText: string
    createdAtMs: number
    wordCount: number
    audioDurationMs: number
  }>> => ipcRenderer.invoke('history:list', query),
  historyDelete: (requestId: string): Promise<void> => ipcRenderer.invoke('history:delete', requestId),
  historyRestore: (requestId: string): Promise<boolean> =>
    ipcRenderer.invoke('history:restore', requestId),
  historyCopy: (text: string): Promise<void> => ipcRenderer.invoke('history:copy', text),
  dictionaryList: (query: string): Promise<Array<{
    id: number
    term: string
    source: string
    useCount: number
    lastUsedAtMs: number
  }>> => ipcRenderer.invoke('dictionary:list', query),
  dictionaryAdd: (term: string): Promise<boolean> => ipcRenderer.invoke('dictionary:add', term),
  dictionaryDelete: (id: number): Promise<void> => ipcRenderer.invoke('dictionary:delete', id),
  setLoginItem: (openAtLogin: boolean): Promise<boolean> => ipcRenderer.invoke('app:setLoginItem', openAtLogin),
  syncNow: (): Promise<{
    kind: string
    uploaded?: number
    downloaded?: number
    message?: string
    warning?: string
  }> => ipcRenderer.invoke('sync:now'),
  syncStatus: (): Promise<{
    lastSyncAt: number
    historySyncEnabled: boolean
    historyRetentionDays: number | null
  }> => ipcRenderer.invoke('sync:status'),
  updateSyncSettings: (changes: {
    historySyncEnabled?: boolean
    historyRetentionDays?: number | null
  }): Promise<{ ok: boolean; cancelled?: boolean; message?: string }> =>
    ipcRenderer.invoke('sync:updateSettings', changes),
  policyNotice: (): Promise<boolean> => ipcRenderer.invoke('app:policyNotice'),
  dismissPolicyNotice: (): Promise<void> => ipcRenderer.invoke('app:dismissPolicyNotice'),
  getLoginItem: (): Promise<boolean> => ipcRenderer.invoke('app:getLoginItem'),
  overlay: {
    done: (payload: { wav: ArrayBuffer; durationMs: number; containsSpeech: boolean }): void =>
      ipcRenderer.send('overlay:done', payload),
    cancelled: (): void => ipcRenderer.send('overlay:cancelled'),
    autoStop: (): void => ipcRenderer.send('overlay:autoStop'),
    fail: (message: string): void => ipcRenderer.send('overlay:fail', message),
    onBegin: (listener: (releaseHint: string) => void): void => {
      ipcRenderer.on('overlay:begin', (_event, releaseHint: unknown) =>
        listener(typeof releaseHint === 'string' ? releaseHint : 'Release ⌥')
      )
    },
    onEnd: (listener: () => void): void => {
      ipcRenderer.on('overlay:end', () => listener())
    },
    onState: (
      listener: (
        state:
          | { state: 'transcribing' }
          | { state: 'success'; text: string; polished: boolean }
          | { state: 'error'; message: string }
          | { state: 'cancelled' }
      ) => void
    ): void => {
      ipcRenderer.on('overlay:state', (_event, state) => listener(state))
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

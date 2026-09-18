import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * Refresh-token vault sealed with the macOS Keychain via Electron safeStorage.
 * The access token stays in memory only (15-minute TTL, 30-second skew) and is
 * refreshed single-flight, mirroring the phone's SessionManager.
 */
export class SessionStore {
  private readonly file: string
  private currentAccessToken: string | null = null
  private accessExpiresAt = 0
  private refreshing: Promise<string> | null = null

  constructor(
    private readonly refreshFn: (refreshToken: string) => Promise<{
      accessToken: string
      accessExpiresInSeconds: number
      refreshToken: string
    }>,
    private readonly onInvalid: () => void,
    dir = join(app.getPath('userData'))
  ) {
    this.file = join(dir, 'refresh-token.bin')
  }

  get hasRefreshToken(): boolean {
    if (this.peekRefreshToken() === null) return false
    return safeStorage.isEncryptionAvailable()
  }

  peekRefreshToken(): string | null {
    try {
      const sealed = readFileSync(this.file)
      if (sealed.length === 0 || !safeStorage.isEncryptionAvailable()) return null
      return safeStorage.decryptString(sealed)
    } catch {
      return null
    }
  }

  get validAccessToken(): string | null {
    if (this.currentAccessToken && Date.now() < this.accessExpiresAt - 30_000) return this.currentAccessToken
    return null
  }

  /** Single-flight access-token resolution: memory → Keychain refresh → refresh call. */
  async accessToken(): Promise<string> {
    const cached = this.validAccessToken
    if (cached) return cached
    if (this.refreshing === null) {
      this.refreshing = this.refresh().finally(() => {
        this.refreshing = null
      })
    }
    return this.refreshing
  }

  storeTokens(accessToken: string, accessExpiresInSeconds: number, refreshToken: string): void {
    this.currentAccessToken = accessToken
    this.accessExpiresAt = Date.now() + accessExpiresInSeconds * 1_000
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Keychain encryption is unavailable; refusing to store the refresh token in plaintext.')
    }
    writeFileSync(this.file, safeStorage.encryptString(refreshToken))
  }

  clear(): void {
    this.currentAccessToken = null
    this.accessExpiresAt = 0
    try {
      writeFileSync(this.file, Buffer.alloc(0))
    } catch {
      // best effort
    }
    this.onInvalid()
  }

  private async refresh(): Promise<string> {
    const refreshToken = this.peekRefreshToken()
    if (!refreshToken) {
      this.onInvalid()
      throw new Error('AUTH_REQUIRED: Sign in to use voice dictation.')
    }
    const rotated = await this.refreshFn(refreshToken)
    this.storeTokens(rotated.accessToken, rotated.accessExpiresInSeconds, rotated.refreshToken)
    return rotated.accessToken
  }
}

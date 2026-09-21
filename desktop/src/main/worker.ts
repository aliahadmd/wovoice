/** Worker REST client (main process, Node fetch). Same API the phone uses. */

// Bounds for every request — a hung socket must fail the session (the
// dictation watchdog recovers) instead of wedging the app until relaunch.
const DEFAULT_TIMEOUT_MS = 15_000
const SYNC_TIMEOUT_MS = 30_000
const TRANSCRIBE_TIMEOUT_MS = 90_000

export interface WorkerUser {
  id: string
  email: string
  vaultConfigured: boolean
  vaultKeyVersion: number | null
  role: 'user' | 'admin'
  accountStatus: {
    state: 'active' | 'suspended' | 'banned'
    suspendedUntil: number | null
    publicMessage: string | null
    supportEmail: string
  }
}

export interface WorkerTokens {
  accessToken: string
  accessExpiresIn: number
  refreshToken: string
  refreshExpiresIn: number
  user: WorkerUser
}

export interface WorkerQuota {
  limitAudioSeconds: number
  usedAudioSeconds: number
  reservedAudioSeconds: number
  remainingAudioSeconds: number
  resetAt: number
}

export class WorkerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly status: number,
    readonly conflicts: Array<{
      id: string
      type: 'history' | 'dictionary' | 'analytics'
      version: number
      keyVersion: number
      nonce: string | null
      ciphertext: string | null
      deleted: boolean
    }> = []
  ) {
    super(message)
  }
}

export interface RemoteVault {
  wrappedKey: string
  nonce: string
  keyVersion: number
}

export class WorkerClient {
  constructor(private readonly baseUrl: string) {}

  private async json<T>(path: string, init: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    } catch {
      throw new WorkerError('NETWORK_UNAVAILABLE', 'Could not reach WoVoice.', true, 0)
    }
    const body = (await response.json().catch(() => null)) as
      | (T & { error?: { code: string; message: string; retryable?: boolean } })
      | null
    if (!response.ok) {
      const error = body?.error
      throw new WorkerError(
        error?.code ?? `HTTP_${response.status}`,
        error?.message ?? `WoVoice request failed (${response.status}).`,
        error?.retryable ?? response.status >= 500,
        response.status
      )
    }
    return body as T
  }

  private authHeaders(token: string): Record<string, string> {
    return { Accept: 'application/json', Authorization: `Bearer ${token}` }
  }

  async exchangeAuthorizationCode(body: {
    code: string
    codeVerifier: string
    deviceName: string
  }): Promise<WorkerTokens> {
    return this.json<WorkerTokens>('/v1/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ grantType: 'authorization_code', ...body })
    })
  }

  async refresh(refreshToken: string): Promise<WorkerTokens> {
    return this.json<WorkerTokens>('/v1/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ refreshToken })
    })
  }

  async profile(accessToken: string): Promise<{ user: WorkerUser; quota: WorkerQuota | null }> {
    return this.json('/v1/me', { method: 'GET', headers: this.authHeaders(accessToken) })
  }

  async logout(accessToken: string): Promise<void> {
    await this.json('/v1/auth/logout', {
      method: 'POST',
      headers: { ...this.authHeaders(accessToken), 'Content-Type': 'application/json' },
      body: '{}'
    })
  }

  async getVault(accessToken: string): Promise<RemoteVault | null> {
    const body = await this.json<{ vault: RemoteVault | null }>(
      '/v1/sync/vault',
      { method: 'GET', headers: this.authHeaders(accessToken) },
      SYNC_TIMEOUT_MS
    )
    return body.vault
  }

  async putVault(
    accessToken: string,
    vault: RemoteVault,
    expectedKeyVersion: number | null
  ): Promise<number> {
    const body = await this.json<{ keyVersion: number }>(
      '/v1/sync/vault',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders(accessToken) },
        body: JSON.stringify({ ...vault, expectedKeyVersion })
      },
      SYNC_TIMEOUT_MS
    )
    return body.keyVersion
  }

  async pull(
    accessToken: string,
    cursor: number
  ): Promise<{
    nextCursor: number
    hasMore: boolean
    items: Array<{
      id: string
      type: 'history' | 'dictionary' | 'analytics'
      version: number
      keyVersion: number
      nonce: string | null
      ciphertext: string | null
      deleted: boolean
    }>
  }> {
    return this.json(
      `/v1/sync?cursor=${cursor}&limit=100`,
      { method: 'GET', headers: this.authHeaders(accessToken) },
      SYNC_TIMEOUT_MS
    )
  }

  async push(
    accessToken: string,
    items: Array<{
      id: string
      type: 'history' | 'dictionary'
      baseVersion: number
      keyVersion: number
      nonce: string
      ciphertext: string
      deleted: boolean
    }>
  ): Promise<{ applied: Array<{ id: string; type: string; version: number }> }> {
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/v1/sync/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders(accessToken) },
        body: JSON.stringify({ items }),
        signal: AbortSignal.timeout(SYNC_TIMEOUT_MS)
      })
    } catch {
      throw new WorkerError('NETWORK_UNAVAILABLE', 'Could not reach WoVoice.', true, 0)
    }
    const body = (await response.json().catch(() => null)) as
      | (Record<string, unknown> & {
          error?: { code: string; message: string; retryable?: boolean }
          conflicts?: Array<{
            id: string
            type: 'history' | 'dictionary' | 'analytics'
            version: number
            keyVersion: number
            nonce: string | null
            ciphertext: string | null
            deleted: boolean
          }>
        })
      | null
    if (!response.ok) {
      const error = body?.error
      throw new WorkerError(
        error?.code ?? `HTTP_${response.status}`,
        error?.message ?? `Sync failed (${response.status}).`,
        error?.retryable ?? response.status >= 500,
        response.status,
        response.status === 409 ? (body?.conflicts ?? []) : []
      )
    }
    return body as { applied: Array<{ id: string; type: string; version: number }> }
  }

  async transcribe(
    accessToken: string,
    wav: Buffer,
    glossary: string[]
  ): Promise<{
    text: string
    rawText: string
    polished: boolean
    asrModel: string
    requestId: string
  }> {
    const form = new FormData()
    form.set('audio', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'voice.wav')
    form.set(
      'options',
      JSON.stringify({
        locale: 'en-IN',
        polish: 'light',
        sentenceStart: true,
        commands: ['new_line', 'new_paragraph'],
        glossary: glossary.slice(0, 100)
      })
    )
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/v1/transcriptions`, {
        method: 'POST',
        headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
        body: form,
        signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS)
      })
    } catch {
      throw new WorkerError('NETWORK_UNAVAILABLE', 'Could not reach WoVoice.', true, 0)
    }
    const body = (await response.json().catch(() => null)) as
      | (Record<string, unknown> & { error?: { code: string; message: string; retryable?: boolean } })
      | null
    if (!response.ok) {
      const error = body?.error
      throw new WorkerError(
        error?.code ?? `HTTP_${response.status}`,
        error?.message ?? `Transcription failed (${response.status}).`,
        error?.retryable ?? response.status >= 500,
        response.status
      )
    }
    return {
      text: String(body?.text ?? '').trim(),
      rawText: String(body?.rawText ?? '').trim(),
      polished: Boolean(body?.polished),
      asrModel: String(body?.asrModel ?? ''),
      requestId: String(body?.requestId ?? '')
    }
  }
}

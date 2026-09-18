/** Worker REST client (main process, Node fetch). Same API the phone uses. */
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
    readonly status: number
  ) {
    super(message)
  }
}

export class WorkerClient {
  constructor(private readonly baseUrl: string) {}

  private async json<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, init)
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
    const response = await fetch(`${this.baseUrl}/v1/transcriptions`, {
      method: 'POST',
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
      body: form
    })
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

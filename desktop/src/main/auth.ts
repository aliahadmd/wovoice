import { createHash, randomBytes } from 'crypto'
import { createServer, type Server } from 'http'
import { hostname } from 'os'
import { shell } from 'electron'

/**
 * Passwordless sign-in: PKCE (S256) + system browser + a loopback HTTP server
 * that receives the authorization code. The Worker's auth page redirects to
 * http://127.0.0.1:<port>/callback when opened with platform=desktop.
 */
export class DesktopAuth {
  private server: Server | null = null
  private verifier: string | null = null
  private state: string | null = null

  constructor(
    private readonly workerUrl: string,
    private readonly onCompleted: (authorizationCode: string) => void,
    private readonly onFailed: (message: string) => void
  ) {}

  private pkce(): { verifier: string; challenge: string; state: string } {
    const verifier = randomBytes(48).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const state = randomBytes(32).toString('base64url')
    return { verifier, challenge, state }
  }

  async start(): Promise<{ ok: boolean; message?: string }> {
    if (this.server !== null) return { ok: false, message: 'Sign-in is already in progress.' }
    const { verifier, challenge, state } = this.pkce()
    this.verifier = verifier
    this.state = state

    const port = await this.listen()

    const authUrl = new URL('/auth', this.workerUrl)
    authUrl.searchParams.set('code_challenge', challenge)
    authUrl.searchParams.set('state', state)
    authUrl.searchParams.set('platform', 'desktop')
    authUrl.searchParams.set('redirect_port', String(port))

    this.awaitCallback()

    await shell.openExternal(authUrl.toString())
    return { ok: true, message: 'Complete sign-in in your browser.' }
  }

  /** Waits for the loopback callback, then hands the code to onCompleted. */
  private awaitCallback(): void {
    const server = this.server
    if (server === null) return
    server.on('request', (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }

      if (url.pathname !== '/callback') {
        response.writeHead(404, headers)
        response.end('Not found')
        return
      }

      response.writeHead(200, headers)
      response.end(
        '<!doctype html><meta charset="utf-8"><title>WoVoice</title>' +
          '<p style="font-family:system-ui;padding:2rem">Sign-in complete — return to the WoVoice app.</p>'
      )

      const code = url.searchParams.get('code') ?? ''
      const returnedState = url.searchParams.get('state') ?? ''
      setImmediate(() => {
        this.server?.close()
        this.server = null

        if (!code || returnedState !== this.state) {
          this.onFailed('The sign-in response could not be verified. Please try again.')
          return
        }
        this.onCompleted(code)
      })
    })
  }

  private listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = createServer()
      this.server.on('error', (error) => reject(error))
      this.server.listen(0, '127.0.0.1', () => {
        const bound = this.server
        const address = bound?.address()
        if (bound === null || address === null || address === undefined || typeof address === 'string') {
          reject(new Error('Could not bind the loopback sign-in listener.'))
          return
        }
        resolve(address.port)
      })
    })
  }

  buildTokenRequest(authorizationCode: string): {
    code: string
    codeVerifier: string
    deviceName: string
  } {
    if (this.verifier === null) throw new Error('No sign-in is in progress.')
    const verifier = this.verifier
    this.verifier = null
    this.state = null
    return {
      code: authorizationCode,
      codeVerifier: verifier,
      deviceName: desktopDeviceName()
    }
  }
}

export function desktopDeviceName(): string {
  return `macOS — ${hostname().split('.')[0]}`.slice(0, 80)
}

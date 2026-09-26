export type AsrModel = "whisper" | "nova-3";
export type AccountRole = "user" | "admin";
export type AccountState = "active" | "suspended" | "banned";

export interface TranscriptionOptions {
  locale: "en-IN";
  polish: "light";
  sentenceStart: boolean;
  commands: Array<"new_line" | "new_paragraph">;
  glossary: string[];
}

export interface AsrResult {
  text: string;
  model: "whisper-large-v3-turbo" | "nova-3";
}

export interface PolishResult {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface Services {
  transcribe(
    env: AppEnv,
    audio: ArrayBuffer,
    options: TranscriptionOptions,
    signal: AbortSignal,
  ): Promise<AsrResult>;
  polish(
    env: AppEnv,
    rawText: string,
    options: TranscriptionOptions,
    signal: AbortSignal,
  ): Promise<PolishResult>;
}

export type AppEnv = Omit<
  Env,
  | "ASR_MODEL"
  | "APP_ORIGIN"
  | "ENVIRONMENT"
  | "TURNSTILE_SITE_KEY"
  | "AUTH_MASTER_KEY"
  | "PII_KEY"
  | "TURNSTILE_SECRET"
  | "SUPPORT_EMAIL"
  | "ADMIN_BOOTSTRAP_EMAIL"
> & {
  ASR_MODEL: string;
  AUTH_MASTER_KEY: string;
  PII_KEY: string;
  TURNSTILE_SECRET: string;
  TURNSTILE_SITE_KEY: string;
  APP_ORIGIN: string;
  ENVIRONMENT: string;
  SUPPORT_EMAIL?: string;
  ADMIN_BOOTSTRAP_EMAIL?: string;
  /** Key-encryption key (32 bytes, base64url) wrapping each account's sync data key. */
  SYNC_KEK: string;
  /** Version of SYNC_KEK (default "1"); bump it when rotating in a new key. */
  SYNC_KEK_VERSION?: string;
  /** The key SYNC_KEK replaced, kept until every data key is re-wrapped. */
  SYNC_KEK_PREVIOUS?: string;
  /** When v1 (recovery-key vault) sync closes for every account, as an ISO date. */
  SYNC_V1_SUNSET_AT?: string;
};

export interface AuthServices {
  verifyTurnstile(
    env: AppEnv,
    token: string,
    remoteIp: string | null,
    idempotencyKey: string,
    expectedAction: "account_auth" | "admin_login",
  ): Promise<boolean>;
  sendCode(env: AppEnv, email: string, code: string): Promise<void>;
}

export interface Principal {
  userId: string;
  sessionId: string;
  role: AccountRole;
  accountState: AccountState;
  suspendedUntil: number | null;
  publicStatusMessage: string | null;
}

export interface AdminServices {
  sendModerationEmail(
    env: AppEnv,
    message: {
      to: string;
      state: AccountState;
      publicMessage: string;
      effectiveUntil: number | null;
    },
  ): Promise<void>;
}

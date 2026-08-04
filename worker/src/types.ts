export type AsrModel = "whisper" | "nova-3";

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
  | "LEGACY_AUTH_DEADLINE"
  | "AUTH_MASTER_KEY"
  | "PII_KEY"
  | "TURNSTILE_SECRET"
  | "CLIENT_TOKEN"
> & {
  ASR_MODEL: string;
  AUTH_MASTER_KEY: string;
  PII_KEY: string;
  TURNSTILE_SECRET: string;
  TURNSTILE_SITE_KEY: string;
  APP_ORIGIN: string;
  ENVIRONMENT: string;
  LEGACY_AUTH_DEADLINE: string;
  CLIENT_TOKEN?: string;
};

export interface AuthServices {
  verifyTurnstile(
    env: AppEnv,
    token: string,
    remoteIp: string | null,
    idempotencyKey: string,
  ): Promise<boolean>;
  sendCode(env: AppEnv, email: string, code: string): Promise<void>;
}

export interface Principal {
  userId: string;
  sessionId: string;
  legacy: boolean;
}

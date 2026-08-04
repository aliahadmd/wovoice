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

export type AppEnv = Omit<Env, "ASR_MODEL"> & {
  ASR_MODEL: string;
  CLIENT_TOKEN: string;
};

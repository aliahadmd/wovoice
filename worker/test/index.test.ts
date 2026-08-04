import { describe, expect, it, vi } from "vitest";
import { buildUsage, createHandler } from "../src/handler";
import type { AppEnv, Services } from "../src/types";
import { chooseSafePolish } from "../src/validation";
import { validateWav } from "../src/wav";

const TOKEN = "test-device-token-with-enough-entropy";

describe("WoVoice Worker", () => {
  it("rejects an invalid device token before parsing the body", async () => {
    const response = await createHandler(fakeServices())(
      new Request("https://worker.test/v1/transcriptions", {
        method: "POST",
        headers: { authorization: "Bearer wrong" },
      }),
      fakeEnv(),
    );
    expect(response.status).toBe(401);
    expect((await response.json()) as object).toMatchObject({
      error: { code: "AUTHENTICATION_FAILED", retryable: false },
    });
  });

  it("supports an authenticated connection test", async () => {
    const response = await createHandler(fakeServices())(
      new Request("https://worker.test/v1/health", { headers: authHeaders() }),
      fakeEnv(),
    );
    expect(response.status).toBe(200);
    expect((await response.json()) as object).toMatchObject({ ok: true });
  });

  it("enforces the per-device rate limiter", async () => {
    const env = fakeEnv(false);
    const response = await createHandler(fakeServices())(
      new Request("https://worker.test/v1/health", { headers: authHeaders() }),
      env,
    );
    expect(response.status).toBe(429);
    expect((await response.json()) as object).toMatchObject({
      error: { code: "RATE_LIMITED", retryable: true },
    });
  });

  it("validates and returns a polished transcription", async () => {
    const services = fakeServices("hello how are you", "Hello, how are you?");
    const response = await createHandler(services)(transcriptionRequest(makeWav(1)), fakeEnv());
    expect(response.status).toBe(200);
    expect((await response.json()) as object).toMatchObject({
      text: "Hello, how are you?",
      rawText: "hello how are you",
      polished: true,
      asrModel: "whisper-large-v3-turbo",
      usage: {
        estimated: true,
        currency: "USD",
        audioSeconds: 1,
        inputTokens: 80,
        outputTokens: 20,
      },
    });
  });

  it("falls back to raw ASR when cleanup changes a number", async () => {
    const services = fakeServices("Meet me at 14:30", "Meet me at 4:30.");
    const response = await createHandler(services)(transcriptionRequest(makeWav(1)), fakeEnv());
    expect(response.status).toBe(200);
    expect((await response.json()) as object).toMatchObject({
      text: "Meet me at 14:30",
      polished: false,
    });
  });

  it("rejects malformed WAV input without calling inference", async () => {
    const services = fakeServices();
    const response = await createHandler(services)(
      transcriptionRequest(new Uint8Array(64).buffer),
      fakeEnv(),
    );
    expect(response.status).toBe(400);
    expect(services.transcribe).not.toHaveBeenCalled();
  });
});

describe("output safety", () => {
  it("accepts punctuation-only cleanup", () => {
    expect(chooseSafePolish("this works right", "This works, right?")).toBe("This works, right?");
  });

  it("rejects meaning-changing rewrites", () => {
    expect(chooseSafePolish("Please call Rahim tomorrow", "Cancel the appointment today")).toBeNull();
  });
});

describe("WAV validation", () => {
  it("accepts mono PCM 16 kHz", () => {
    expect(validateWav(makeWav(2)).durationSeconds).toBe(2);
  });

  it("rejects audio longer than 60 seconds", () => {
    expect(() => validateWav(makeWav(60.2))).toThrow("60 seconds");
  });
});

describe("usage estimates", () => {
  it("uses versioned Whisper and token pricing", () => {
    expect(buildUsage("whisper-large-v3-turbo", 60, { input: 1_000, output: 500 })).toMatchObject({
      pricingVersion: "2026-07-08",
      asrNeurons: 46.63,
      inputTokens: 1_000,
      outputTokens: 500,
    });
  });

  it("returns null rather than inventing missing token usage", () => {
    expect(buildUsage("nova-3", 10, null)).toBeNull();
  });
});

function fakeServices(raw = "hello", polished = "Hello."): Services {
  return {
    transcribe: vi.fn(async () => ({ text: raw, model: "whisper-large-v3-turbo" as const })),
    polish: vi.fn(async () => ({ text: polished, inputTokens: 80, outputTokens: 20 })),
  };
}

function fakeEnv(rateSuccess = true): AppEnv {
  const env: AppEnv = {
    CLIENT_TOKEN: TOKEN,
    ASR_MODEL: "whisper",
    RATE_LIMITER: { limit: vi.fn(async () => ({ success: rateSuccess })) },
    AI: {} as never,
  };
  return env;
}

function authHeaders(): HeadersInit {
  return { authorization: `Bearer ${TOKEN}` };
}

function transcriptionRequest(audio: ArrayBuffer): Request {
  const form = new FormData();
  form.set("audio", new File([audio], "voice.wav", { type: "audio/wav" }));
  form.set(
    "options",
    JSON.stringify({
      locale: "en-IN",
      polish: "light",
      sentenceStart: true,
      commands: ["new_line", "new_paragraph"],
      glossary: ["Rahim"],
    }),
  );
  return new Request("https://worker.test/v1/transcriptions", {
    method: "POST",
    headers: authHeaders(),
    body: form,
  });
}

function makeWav(seconds: number): ArrayBuffer {
  const dataSize = Math.round(seconds * 16_000 * 2);
  const buffer = new ArrayBuffer(44 + dataSize);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(bytes, 8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, "data");
  view.setUint32(40, dataSize, true);
  return buffer;
}

function writeAscii(bytes: Uint8Array, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) bytes[offset + index] = text.charCodeAt(index);
}

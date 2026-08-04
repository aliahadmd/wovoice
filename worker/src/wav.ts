import { ApiError } from "./errors";

export const MAX_BODY_BYTES = 2_500_000;
const EXPECTED_SAMPLE_RATE = 16_000;
const MAX_DURATION_SECONDS = 60;

export interface WavInfo {
  durationSeconds: number;
  dataBytes: number;
}

export async function readBodyLimited(
  request: Request,
  limit = MAX_BODY_BYTES,
): Promise<ArrayBuffer> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) {
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", false, "The recording is too large.");
  }
  if (!request.body) {
    return new ArrayBuffer(0);
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new ApiError(413, "PAYLOAD_TOO_LARGE", false, "The recording is too large.");
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

export function validateWav(audio: ArrayBuffer): WavInfo {
  if (audio.byteLength < 44 || audio.byteLength > MAX_BODY_BYTES) {
    throw new ApiError(400, "INVALID_AUDIO", false, "Please record a new voice message.");
  }

  const bytes = new Uint8Array(audio);
  const view = new DataView(audio);
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") {
    throw new ApiError(400, "INVALID_AUDIO", false, "Only a PCM WAV recording is accepted.");
  }

  let offset = 12;
  let format: { code: number; channels: number; rate: number; bits: number } | undefined;
  let dataBytes = 0;
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    if (dataOffset + size > bytes.byteLength) {
      throw new ApiError(400, "INVALID_AUDIO", false, "The WAV recording is incomplete.");
    }
    if (id === "fmt " && size >= 16) {
      format = {
        code: view.getUint16(dataOffset, true),
        channels: view.getUint16(dataOffset + 2, true),
        rate: view.getUint32(dataOffset + 4, true),
        bits: view.getUint16(dataOffset + 14, true),
      };
    } else if (id === "data") {
      dataBytes += size;
    }
    offset = dataOffset + size + (size % 2);
  }

  if (
    !format ||
    format.code !== 1 ||
    format.channels !== 1 ||
    format.rate !== EXPECTED_SAMPLE_RATE ||
    format.bits !== 16 ||
    dataBytes === 0
  ) {
    throw new ApiError(
      400,
      "INVALID_AUDIO",
      false,
      "The recording must be mono 16-bit PCM WAV at 16 kHz.",
    );
  }

  const durationSeconds = dataBytes / (format.rate * format.channels * (format.bits / 8));
  if (durationSeconds > MAX_DURATION_SECONDS + 0.1) {
    throw new ApiError(400, "AUDIO_TOO_LONG", false, "Recordings can be up to 60 seconds.");
  }
  if (durationSeconds < 0.1) {
    throw new ApiError(400, "INVALID_AUDIO", false, "The recording is too short.");
  }
  return { durationSeconds, dataBytes };
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

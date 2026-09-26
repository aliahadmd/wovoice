import { POLISH_MAX_OUTPUT_TOKENS } from "./pricing";
import type { AsrResult, PolishResult, Services, TranscriptionOptions } from "./types";

const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo" as const;
const NOVA_MODEL = "@cf/deepgram/nova-3" as const;
const CLEANUP_MODEL = "@cf/openai/gpt-oss-20b" as const;

export const productionServices: Services = {
  async transcribe(env, audio, options, signal): Promise<AsrResult> {
    const content = () => ({
      body: new Blob([audio], { type: "audio/wav" }).stream(),
      contentType: "audio/wav",
    });
    if (env.ASR_MODEL === "nova-3") {
      const response = await env.AI.run(
        NOVA_MODEL,
        {
          audio: content(),
          language: options.locale,
          punctuate: true,
          smart_format: true,
          numerals: true,
          dictation: true,
          filler_words: false,
          mip_opt_out: true,
          keyterm: options.glossary.join(", ") || undefined,
        },
        { signal },
      );
      const text = response.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? "";
      if (!text) throw new Error("ASR returned no text");
      return { text, model: "nova-3" };
    }

    const response = await env.AI.run(
      WHISPER_MODEL,
      {
        audio: content(),
        task: "transcribe",
        language: "en",
        vad_filter: true,
        beam_size: 5,
        condition_on_previous_text: true,
        no_speech_threshold: 0.65,
        initial_prompt: options.glossary.length
          ? `Vocabulary that may occur: ${options.glossary.join(", ")}`
          : undefined,
      },
      { signal },
    );
    const text = response.text.trim();
    if (!text) throw new Error("ASR returned no text");
    return { text, model: "whisper-large-v3-turbo" };
  },

  async polish(env, rawText, options, signal): Promise<PolishResult> {
    const glossary = options.glossary.length ? options.glossary.join(", ") : "(none)";
    const commandInstruction = options.commands.length
      ? "Convert deliberate phrases ‘new line’ and ‘new paragraph’ into one or two newline characters."
      : "Do not add newline characters for spoken commands.";
    const response = await env.AI.run(
      CLEANUP_MODEL,
      {
        messages: [
          {
            role: "system",
            content:
              "You lightly clean speech-to-text. Correct only obvious grammar, casing, spacing, and punctuation; remove filler words. Always punctuate: end sentences with . ? or !, and add commas where a speaker would naturally pause. Capitalize sentence starts. Never add facts, summarize, alter meaning, or change any name or number. Return only JSON with the cleaned transcript.",
          },
          {
            role: "user",
            content: `Sentence starts here: ${options.sentenceStart}. Protected vocabulary: ${glossary}. ${commandInstruction}\n\nTranscript:\n${rawText}`,
          },
        ],
        temperature: 0,
        max_tokens: Math.min(POLISH_MAX_OUTPUT_TOKENS, Math.max(120, rawText.length * 2)),
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "clean_transcript",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
        },
      },
      { signal },
    );
    const content = response.choices?.[0]?.message.content;
    if (!content) throw new Error("Cleanup returned no text");
    // gpt-oss-20b does not reliably honor response_format's property name: it
    // has been observed returning {"transcript": "..."} and {"cleaned_transcript":
    // "..."} against a schema named "text", and may fence JSON in markdown. Accept
    // any object holding exactly one string. Anything else that looks like JSON
    // (another shape, or output truncated by max_tokens) is rejected: it used to
    // fall through as the "cleaned text" and was pasted into the user's editor.
    const cleaned = extractCleanedText(content);
    if (cleaned === null) throw new Error("Cleanup returned an invalid schema");
    const usage = response.usage;
    const inputTokens = usage && "prompt_tokens" in usage ? usage.prompt_tokens : usage?.input_tokens;
    const outputTokens = usage && "completion_tokens" in usage ? usage.completion_tokens : usage?.output_tokens;
    return {
      text: cleaned,
      inputTokens: inputTokens ?? null,
      outputTokens: outputTokens ?? null,
    };
  },
};

export function extractCleanedText(content: string): string | null {
  const unfenced = content.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  if (!unfenced) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    // Plain prose is a usable candidate; broken JSON never is.
    return /^[{["]/u.test(unfenced) ? null : unfenced;
  }
  if (typeof parsed === "string") return parsed;
  if (!isRecord(parsed)) return null;
  for (const key of ["text", "transcript", "cleaned"]) {
    if (typeof parsed[key] === "string") return parsed[key];
  }
  const strings = Object.values(parsed).filter((value): value is string => typeof value === "string");
  return strings.length === 1 ? strings[0] : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

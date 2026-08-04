import { ApiError } from "./errors";
import type { TranscriptionOptions } from "./types";

const ALLOWED_COMMANDS = new Set(["new_line", "new_paragraph"]);

export function parseOptions(value: string | File | null): TranscriptionOptions {
  if (typeof value !== "string" || value.length > 10_000) {
    throw invalidOptions();
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(value);
  } catch {
    throw invalidOptions();
  }
  if (!isRecord(candidate)) throw invalidOptions();

  const glossary = candidate.glossary;
  const commands = candidate.commands;
  if (
    candidate.locale !== "en-IN" ||
    candidate.polish !== "light" ||
    typeof candidate.sentenceStart !== "boolean" ||
    !Array.isArray(commands) ||
    !commands.every((command) => typeof command === "string" && ALLOWED_COMMANDS.has(command)) ||
    !Array.isArray(glossary) ||
    glossary.length > 100 ||
    !glossary.every(
      (term) => typeof term === "string" && term.trim().length > 0 && term.trim().length <= 80,
    )
  ) {
    throw invalidOptions();
  }

  const cleanedGlossary = glossary.map((term) => term.trim());
  if (cleanedGlossary.join("\n").length > 4_000) throw invalidOptions();
  return {
    locale: "en-IN",
    polish: "light",
    sentenceStart: candidate.sentenceStart,
    commands: [...new Set(commands)] as TranscriptionOptions["commands"],
    glossary: cleanedGlossary,
  };
}

function invalidOptions(): ApiError {
  return new ApiError(400, "INVALID_REQUEST", false, "The transcription options are invalid.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function chooseSafePolish(rawText: string, candidate: string, glossary: readonly string[] = []): string | null {
  const raw = rawText.trim();
  const polished = candidate.trim();
  if (!raw || !polished) return null;
  // Spoken text never opens with a JSON brace or bracket; a candidate that does is
  // model plumbing leaking through, however similar its words look.
  if (/^[{[]/u.test(polished) && !/^[{[]/u.test(raw)) return null;
  if (polished.length < raw.length * 0.45 || polished.length > raw.length * 1.7 + 40) return null;

  const rawNumbers = raw.match(/\d+(?:[.,:/-]\d+)*/g) ?? [];
  const polishedNumbers = polished.match(/\d+(?:[.,:/-]\d+)*/g) ?? [];
  if (rawNumbers.join("|") !== polishedNumbers.join("|")) return null;

  const rawWords = normalizeWords(raw);
  const polishedWords = normalizeWords(polished);
  if (rawWords.length === 0 || polishedWords.length === 0) return null;
  if (meaningMarkers(raw) !== meaningMarkers(polished)) return null;
  for (const term of glossary) {
    const words = normalizeWords(term);
    if (words.length && occurrences(rawWords, words) > occurrences(polishedWords, words)) return null;
  }
  if (rawWords.length <= 8 && grammarCanonical(raw) === grammarCanonical(polished)) return polished;
  const distance = wordDistance(rawWords, polishedWords);
  const ratio = distance / Math.max(rawWords.length, polishedWords.length);
  return ratio <= 0.42 ? polished : null;
}

function normalizeWords(text: string): string[] {
  return text
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}'’]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function wordDistance(left: string[], right: string[]): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function occurrences(words: string[], term: string[]): number {
  let count = 0;
  for (let index = 0; index <= words.length - term.length; index++) if (term.every((word, offset) => words[index + offset] === word)) count++;
  return count;
}
function expanded(text: string): string {
  return text.toLowerCase().replace(/’/gu, "'").replace(/\bcan't\b/gu, "can not").replace(/\bwon't\b/gu, "will not").replace(/\bcannot\b/gu, "can not").replace(/n['’]t\b/gu, " not");
}
function meaningMarkers(text: string): string {
  return (expanded(text).match(/\b(?:not|no|never|without|hardly|barely|can|could|will|would|should|may|might|must)\b/gu) ?? []).join("|");
}
/** Deliberately narrow grammar equivalences, not an unrestricted rewrite threshold. */
function grammarCanonical(text: string): string {
  return normalizeWords(expanded(text)).join(" ")
    .replace(/\b(i|you|we|they) has\b/gu, "$1 have")
    .replace(/\b(he|she|it) have\b/gu, "$1 has")
    .replace(/\bi (?:is|are)\b/gu, "i am")
    .replace(/\b(you|we|they) (?:is|am)\b/gu, "$1 are")
    .replace(/\b(he|she|it) (?:am|are)\b/gu, "$1 is")
    .replace(/\b(have|has|had) (went|did|saw|wrote|spoke|ate)\b/gu, (_, auxiliary: string, verb: string) => `${auxiliary} ${{ went: "gone", did: "done", saw: "seen", wrote: "written", spoke: "spoken", ate: "eaten" }[verb]}`)
    .replace(/\b(?:a|an|the)\b/gu, "").replace(/\s+/gu, " ").trim();
}

export function chooseSafePolish(rawText: string, candidate: string): string | null {
  const raw = rawText.trim();
  const polished = candidate.trim();
  if (!raw || !polished) return null;
  if (polished.length < raw.length * 0.45 || polished.length > raw.length * 1.7 + 40) return null;

  const rawNumbers = raw.match(/\d+(?:[.,:/-]\d+)*/g) ?? [];
  const polishedNumbers = polished.match(/\d+(?:[.,:/-]\d+)*/g) ?? [];
  if (rawNumbers.join("|") !== polishedNumbers.join("|")) return null;

  const rawWords = normalizeWords(raw);
  const polishedWords = normalizeWords(polished);
  if (rawWords.length === 0 || polishedWords.length === 0) return null;
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

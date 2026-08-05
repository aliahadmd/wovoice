import { readFile } from "node:fs/promises";
import { join } from "node:path";

const audioDirectory = process.argv[2];
const baseUrl = process.env.WOVOICE_WORKER_URL?.replace(/\/$/, "");
const token = process.env.WOVOICE_ACCESS_TOKEN;
if (!audioDirectory || !baseUrl?.startsWith("https://") || !token) {
  throw new Error("Set WOVOICE_WORKER_URL and WOVOICE_ACCESS_TOKEN, then pass the WAV directory.");
}

const cases = JSON.parse(await readFile(new URL("./utterances.json", import.meta.url), "utf8"));
const totals = new Map();
for (const testCase of cases) {
  const audio = await readFile(join(audioDirectory, `${testCase.id}.wav`));
  const form = new FormData();
  form.set("audio", new File([audio], `${testCase.id}.wav`, { type: "audio/wav" }));
  form.set("options", JSON.stringify({
    locale: "en-IN",
    polish: "light",
    sentenceStart: true,
    commands: ["new_line", "new_paragraph"],
    glossary: testCase.critical ?? [],
  }));
  const response = await fetch(`${baseUrl}/v1/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  if (!response.ok) throw new Error(`Case ${testCase.id} failed with HTTP ${response.status}.`);
  const result = await response.json();
  const expectedWords = words(testCase.text);
  const actualWords = words(result.text);
  const edits = distance(expectedWords, actualWords);
  const punctuation = punctuationCounts(testCase.text, result.text);
  const critical = (testCase.critical ?? []).map(normalize).filter((term) => normalize(result.text).includes(term));
  const summary = totals.get(testCase.condition) ?? emptyTotals();
  summary.wordEdits += edits;
  summary.words += expectedWords.length;
  summary.tp += punctuation.tp;
  summary.fp += punctuation.fp;
  summary.fn += punctuation.fn;
  summary.criticalHits += critical.length;
  summary.criticalTotal += (testCase.critical ?? []).length;
  summary.cases += 1;
  totals.set(testCase.condition, summary);
  console.log(`${testCase.id}: WER ${(100 * edits / Math.max(1, expectedWords.length)).toFixed(1)}%`);
}

for (const [condition, total] of totals) {
  const precision = total.tp / Math.max(1, total.tp + total.fp);
  const recall = total.tp / Math.max(1, total.tp + total.fn);
  const f1 = 2 * precision * recall / Math.max(Number.EPSILON, precision + recall);
  console.log(`${condition}: WER ${(100 * total.wordEdits / total.words).toFixed(2)}%, punctuation F1 ${(100 * f1).toFixed(2)}%, critical recall ${(100 * total.criticalHits / Math.max(1, total.criticalTotal)).toFixed(2)}%`);
}

function emptyTotals() {
  return { wordEdits: 0, words: 0, tp: 0, fp: 0, fn: 0, criticalHits: 0, criticalTotal: 0, cases: 0 };
}

function normalize(value) {
  return value.toLocaleLowerCase("en").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function words(value) {
  return normalize(value).split(/\s+/).filter(Boolean);
}

function distance(left, right) {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(current[column - 1] + 1, previous[column] + 1, previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[right.length];
}

function punctuationCounts(expected, actual) {
  const left = [...expected].filter((character) => ".,!?;:\n".includes(character));
  const right = [...actual].filter((character) => ".,!?;:\n".includes(character));
  const matches = Math.min(left.length, right.length) - distance(left, right);
  return { tp: Math.max(0, matches), fp: Math.max(0, right.length - matches), fn: Math.max(0, left.length - matches) };
}

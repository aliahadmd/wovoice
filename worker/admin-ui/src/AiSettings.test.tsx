import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AI_MODEL_CATALOG, defaultAiConfiguration, type AiConfiguration, type AiRevision } from "../../src/ai-config";
import { AiSettings, type AiWorkspace } from "./AiSettings";
import { adminApi, AdminApiError } from "./api";

vi.mock("./api", async (original) => ({ ...await original<typeof import("./api")>(), adminApi: vi.fn() }));
let root: Root; let host: HTMLDivElement; let data: AiWorkspace;
const api = vi.mocked(adminApi);
const dirtyChanged = vi.fn();
function revision(config: AiConfiguration, version: number, kind: "draft" | "published"): AiRevision {
  return { id: `r${version}`, version, kind, config: structuredClone(config), reason: "Evaluate cleanup behavior", sourceRevisionId: null, createdBy: "admin", createdAt: Date.now() };
}
async function click(name: string) {
  const button = Array.from(host.querySelectorAll('button')).find((item) => item.textContent === name);
  if (!button) throw new Error(`Missing button: ${name}`);
  await act(async () => button.click());
}
async function fill(label: string, value: string) {
  const field = Array.from(host.querySelectorAll('label')).find((item) => item.querySelector('span')?.textContent === label)?.querySelector('input,textarea');
  if (!field) throw new Error(`Missing field: ${label}`);
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); });
}
function disabled(name: string) { return (Array.from(host.querySelectorAll('button')).find((item) => item.textContent === name) as HTMLButtonElement).disabled; }

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  const defaults = defaultAiConfiguration();
  data = { version: 0, active: null, draft: null, defaults, effective: defaults, catalog: AI_MODEL_CATALOG, safeguards: { locale: "en-IN", maxAudioSeconds: 60, maxCleanupInputBytes: 8192, baseDailyAudioSeconds: 600, globalDailyNeurons: 8000, monthlyEmails: 3000, cleanupReservedNeurons: 200 } };
  api.mockImplementation(async (path, options) => {
    if (path === "/ai/config") return structuredClone(data);
    const body = options?.body as { config: AiConfiguration; reason: string };
    if (path === "/ai/config/draft") { data = { ...data, version: data.version + 1, draft: revision(body.config, data.version + 1, "draft") }; return structuredClone(data); }
    if (path === "/ai/config/publish") { const active = revision(data.draft!.config, data.version + 1, "published"); data = { ...data, version: data.version + 1, active, draft: null, effective: active.config }; return structuredClone(data); }
    if (path === "/ai/revisions") return { revisions: [], nextCursor: null };
    if (path === "/ai/preview") return { text: "Hello.", candidate: "Hello.", accepted: true, status: "accepted", latencyMs: 12, messages: [], usage: null };
    throw new Error(`Unexpected API: ${path}`);
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<AiSettings onDirtyChange={dirtyChanged} />));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe("AI administration workflow", () => {
  it("saves a draft independently of live settings and requires explicit review to publish", async () => {
    await click("03Prompts");
    await fill("System prompt", "Clean punctuation and preserve every word and number.");
    await fill("Change note", "Try concise instructions");
    expect(dirtyChanged).toHaveBeenLastCalledWith(true);
    expect(disabled("Review & publish")).toBe(true);
    await click("Save draft");
    expect(data.effective.cleanup.systemPrompt).toBe(defaultAiConfiguration().cleanup.systemPrompt);
    expect(host.textContent).toContain("Draft saved. Live dictation has not changed.");
    await click("Review & publish");
    expect(host.querySelector('[role=dialog]')).not.toBeNull();
    expect(disabled("Publish configuration")).toBe(true);
    const check = Array.from(host.querySelectorAll('label')).find((label) => label.textContent?.includes("I reviewed"))!.querySelector('input')!;
    await act(async () => check.click());
    await click("Publish configuration");
    expect(data.effective.cleanup.systemPrompt).toBe("Clean punctuation and preserve every word and number.");
    expect(host.textContent).toContain("Configuration published.");
  });
  it("preserves edits on a server conflict and offers a deliberate reload", async () => {
    await click("03Prompts"); await fill("System prompt", "Keep all facts. Fix punctuation."); await fill("Change note", "Review conflict behavior");
    api.mockRejectedValueOnce(new AdminApiError(409, "Another administrator changed this configuration."));
    await click("Save draft");
    expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe("Keep all facts. Fix punctuation.");
    expect(host.textContent).toContain("Another administrator changed");
    await click("Reload"); expect(host.textContent).toContain("Unsaved edits will be replaced");
    await click("Keep editing"); expect(host.querySelector('[role=dialog]')).toBeNull();
  });
  it("blocks malformed prompt templates before saving or testing", async () => {
    await click("03Prompts"); await fill("User prompt template", "{{transcript}} only"); await fill("Change note", "Validate prompt structure");
    expect(disabled("Save draft")).toBe(true);
    expect(host.textContent).toContain("each supported placeholder once");
    await click("04Test workspace"); expect(disabled("Run cleanup test")).toBe(true);
  });
  it("marks a preview stale when its sample changes", async () => {
    await click("04Test workspace"); await click("Run cleanup test");
    expect(host.textContent).toContain("Hello.");
    await fill("Sample transcript", "A different sample");
    expect(host.textContent).toContain("changed since this test");
  });
});

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AI_MODEL_CATALOG, AiConfigValidationError, changedConfigFields, validateAiConfiguration, type AiConfiguration, type AiRevision } from "../../src/ai-config";
import { AdminApiError, adminApi } from "./api";
import { Dialog } from "./Dialog";
import "./ai-settings.css";

export interface AiWorkspace {
  version: number; active: AiRevision | null; draft: AiRevision | null;
  defaults: AiConfiguration; effective: AiConfiguration; catalog: typeof AI_MODEL_CATALOG;
  safeguards: { locale: string; maxAudioSeconds: number; maxCleanupInputBytes: number; baseDailyAudioSeconds: number; globalDailyNeurons: number; monthlyEmails: number; cleanupReservedNeurons: number };
}
interface RevisionSummary extends Omit<AiRevision, "config"> { asrModel: string; cleanupModel: string; serviceEnabled: boolean; cleanupEnabled: boolean }
interface TestResult {
  text: string; candidate: string | null; accepted: boolean; status: string; latencyMs: number;
  messages: Array<{ role: string; content: string }>;
  usage: { inputTokens: number; outputTokens: number; neurons: number; estimatedCostUsd: number } | null;
}
type Section = "recognition" | "cleanup" | "prompts" | "test" | "availability" | "history";
const SECTIONS: Array<[Section, string]> = [["recognition", "Speech recognition"], ["cleanup", "Text cleanup"], ["prompts", "Prompts"], ["test", "Test workspace"], ["availability", "Availability"], ["history", "Revisions"]];
const LABELS: Record<string, string> = {
  "asr.model": "Speech recognition model", "asr.glossaryPrompt": "Vocabulary hint prompt", "cleanup.model": "Cleanup model",
  "cleanup.enabled": "Text cleanup", "cleanup.systemPrompt": "System prompt", "cleanup.userPromptTemplate": "User prompt template",
  "cleanup.commandsPrompt": "Spoken command instruction", "cleanup.noCommandsPrompt": "No-command instruction", "cleanup.temperature": "Temperature",
  "cleanup.maxOutputTokens": "Response token ceiling", "service.enabled": "Dictation availability", "service.timeoutMs": "Inference timeout", "service.maintenanceMessage": "Maintenance message",
};

export function AiSettings({ onDirtyChange }: { onDirtyChange(dirty: boolean): void }) {
  const [data, setData] = useState<AiWorkspace | null>(null);
  const [config, setConfig] = useState<AiConfiguration | null>(null);
  const [section, setSection] = useState<Section>(() => SECTIONS.find(([key]) => key === new URLSearchParams(location.search).get("tab"))?.[0] ?? "recognition");
  const [reason, setReason] = useState(""); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [dialog, setDialog] = useState<"publish" | "reload" | { restore: string; version?: number } | null>(null);
  const [reviewed, setReviewed] = useState(false); const [publishReason, setPublishReason] = useState("");
  const [revisions, setRevisions] = useState<RevisionSummary[]>([]); const [cursor, setCursor] = useState<number | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [sample, setSample] = useState("um please send the invoice for 2500 rupees tomorrow");
  const [glossary, setGlossary] = useState(""); const [sentenceStart, setSentenceStart] = useState(true); const [commands, setCommands] = useState(true);
  const [testBusy, setTestBusy] = useState(false); const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testedFingerprint, setTestedFingerprint] = useState("");
  const live = data?.effective;
  const saved = data?.draft?.config ?? live;
  const fingerprint = config ? JSON.stringify(config) : "";
  const dirty = !!config && fingerprint !== JSON.stringify(saved);
  const configErrors = useMemo(() => {
    if (!config) return {};
    try { validateAiConfiguration(config); return {}; }
    catch (value) { return value instanceof AiConfigValidationError ? value.fields : { configuration: "Check this configuration." }; }
  }, [config]);
  const valid = Object.keys(configErrors).length === 0;
  const changes = live && config ? changedConfigFields(live, config) : [];
  const current = useRef(true);
  const loadSequence = useRef(0);
  const evaluationFingerprint = JSON.stringify({ config, sample, glossary, sentenceStart, commands });

  useEffect(() => { current.current = true; void load(); return () => { current.current = false; onDirtyChange(false); }; }, []);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { if (data && section === "history") void history(); }, [section, data?.version]);
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    addEventListener("beforeunload", guard); return () => removeEventListener("beforeunload", guard);
  }, [dirty]);

  async function load() {
    const sequence = ++loadSequence.current;
    setBusy(true); setError("");
    try {
      const value = await adminApi<AiWorkspace>("/ai/config");
      if (current.current && sequence === loadSequence.current) { applyWorkspace(value); setNotice(""); }
    } catch (value) { if (current.current && sequence === loadSequence.current) setError(message(value)); }
    finally { if (current.current && sequence === loadSequence.current) setBusy(false); }
  }
  function applyWorkspace(value: AiWorkspace) { setData(value); setConfig(structuredClone(value.draft?.config ?? value.effective)); setReason(value.draft?.reason ?? ""); }
  function change(next: AiConfiguration) { setConfig(next); setNotice(""); setError(""); }
  async function save() {
    if (!data || !config || !valid || reason.trim().length < 5) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const value = await adminApi<AiWorkspace>("/ai/config/draft", { method: "POST", body: { config, expectedVersion: data.version, reason } });
      applyWorkspace(value); setNotice("Draft saved. Live dictation has not changed.");
    } catch (value) { setError(message(value)); }
    finally { setBusy(false); }
  }
  async function publish() {
    if (!data?.draft || dirty || !reviewed || publishReason.trim().length < 5) return;
    setBusy(true); setError("");
    try {
      const value = await adminApi<AiWorkspace>("/ai/config/publish", { method: "POST", body: { revisionId: data.draft.id, expectedVersion: data.version, reason: publishReason } });
      applyWorkspace(value); setDialog(null); setNotice("Configuration published. New recordings will use this revision.");
    } catch (value) { setError(message(value)); setDialog(null); }
    finally { setBusy(false); }
  }
  async function restore(id: string) {
    if (!data || publishReason.trim().length < 5) return;
    setBusy(true); setError("");
    try {
      const value = await adminApi<AiWorkspace>("/ai/config/restore", { method: "POST", body: { revisionId: id, expectedVersion: data.version, reason: publishReason } });
      applyWorkspace(value); setDialog(null); setSection("recognition"); setNotice("Revision restored as a draft. Review and publish when ready.");
    } catch (value) { setError(message(value)); setDialog(null); }
    finally { setBusy(false); }
  }
  async function history(append = false) {
    setHistoryBusy(true); setError("");
    try {
      const value = await adminApi<{ revisions: RevisionSummary[]; nextCursor: number | null }>(`/ai/revisions${append && cursor ? `?before=${cursor}` : ""}`);
      setRevisions((previous) => append ? [...previous, ...value.revisions] : value.revisions); setCursor(value.nextCursor);
    } catch (value) { setError(message(value)); } finally { setHistoryBusy(false); }
  }
  async function test() {
    if (!config || !valid) return;
    setTestBusy(true); setTestResult(null); setError(""); const snapshot = evaluationFingerprint;
    try {
      const result = await adminApi<TestResult>("/ai/preview", { method: "POST", body: { config, text: sample, glossary: glossary.split(",").map((term) => term.trim()).filter(Boolean), sentenceStart, commands } });
      if (current.current) { setTestResult(result); setTestedFingerprint(snapshot); }
    } catch (value) { if (current.current) setError(message(value)); }
    finally { if (current.current) setTestBusy(false); }
  }

  if (!data || !config || !live) return <section className="panel"><h2>AI configuration</h2><p className="muted">{error || "Loading the live configuration and saved draft…"}</p>{error && <button className="secondary-button" onClick={() => void load()}>Try again</button>}</section>;
  const field = (key: string) => configErrors[key];
  const cleanupModel = data.catalog.cleanup.find((model) => model.id === config.cleanup.model)!;
  const liveAsr = data.catalog.asr.find((model) => model.id === live.asr.model)!;
  const draftLabel = dirty ? "Unsaved changes" : data.draft ? `Saved draft · r${data.draft.version}` : "Matches live configuration";
  return <div className="ai-workspace">
    <div className="ai-intro"><div><p className="eyebrow">RECOGNIZE → CLEAN UP → INSERT</p><h2>Shape how WoVoice listens.</h2><p className="muted">Tune speech recognition and text cleanup. Test your draft, review the changes, then publish to Android and Mac.</p></div><span className={`status-pill ${live.service.enabled ? "active" : "suspended"}`}>{live.service.enabled ? "Dictation online" : "Dictation paused"}</span></div>
    <div className="ai-live-strip"><div><small>LIVE CONFIGURATION</small><strong>{data.active ? `Revision ${data.active.version}` : "Built-in defaults"}</strong><span>{data.active ? date(data.active.createdAt) : "Current deployment defaults"}</span></div><div><small>SPEECH RECOGNITION</small><strong>{liveAsr.name}</strong><span>English · India</span></div><div><small>TEXT CLEANUP</small><strong>{live.cleanup.enabled ? live.cleanup.model.toUpperCase() : "Disabled"}</strong><span>{live.cleanup.enabled ? "Meaning and number checks enforced" : "Original recognition text is returned"}</span></div></div>
    <div className="ai-editor-bar"><span className={`ai-draft-label ${dirty ? "unsaved" : ""}`}><span aria-hidden="true">●</span> {draftLabel}</span><div className="action-row"><button className="secondary-button" disabled={busy} onClick={() => setDialog("reload")}>Reload</button><button className="primary-button" disabled={busy || (!dirty && !!data.draft) || !valid || reason.trim().length < 5} onClick={() => void save()}>{busy ? "Working…" : "Save draft"}</button><button className="secondary-button" disabled={busy || dirty || !data.draft || !valid} onClick={() => { setReviewed(false); setPublishReason(data.draft?.reason ?? ""); setDialog("publish"); }}>Review & publish</button></div></div>
    {error && <div className="banner error" role="alert">{error}</div>}
    {notice && <div className="banner ai-success" role="status">{notice}</div>}
    <div className="ai-layout"><nav className="ai-sections" aria-label="AI configuration sections">{SECTIONS.map(([key, label], index) => <button key={key} aria-current={section === key ? "page" : undefined} className={section === key ? "active" : ""} onClick={() => setSection(key)}><span>{String(index + 1).padStart(2, "0")}</span>{label}</button>)}</nav>
      <fieldset className="ai-content" disabled={busy}>
        {section === "recognition" && <Card kicker="01 · SPEECH RECOGNITION" title="Turn speech into text" detail="Choose the recognizer and how it handles speech. Dictionary terms are passed as vocabulary hints.">
          <Field label="Speech recognition model" help={data.catalog.asr.find((item) => item.id === config.asr.model)?.purpose}><select value={config.asr.model} onChange={(event) => change({ ...config, asr: { ...config.asr, model: event.target.value === "nova-3" ? "nova-3" : "whisper" } })}>{data.catalog.asr.map((model) => <option key={model.id} value={model.id}>{model.name} · ${model.usdPerMinute}/audio minute</option>)}</select></Field>
          {config.asr.model === "whisper" ? <><Toggle label="Voice activity filter" help="Filter non-speech segments before recognition." checked={config.asr.whisper.vadFilter} onChange={(value) => change({ ...config, asr: { ...config.asr, whisper: { ...config.asr.whisper, vadFilter: value } } })} /><Toggle label="Use previous text context" help="Maintain context between segments of the same recording." checked={config.asr.whisper.conditionOnPreviousText} onChange={(value) => change({ ...config, asr: { ...config.asr, whisper: { ...config.asr.whisper, conditionOnPreviousText: value } } })} /><div className="ai-field-grid"><NumberField label="Beam size" value={config.asr.whisper.beamSize} min={1} max={10} step={1} error={field("asr.whisper.beamSize")} help="Search breadth · 1–10" onChange={(value) => change({ ...config, asr: { ...config.asr, whisper: { ...config.asr.whisper, beamSize: value } } })} /><NumberField label="No-speech threshold" value={config.asr.whisper.noSpeechThreshold} min={0} max={1} step={0.05} error={field("asr.whisper.noSpeechThreshold")} help="Recognition threshold · 0–1" onChange={(value) => change({ ...config, asr: { ...config.asr, whisper: { ...config.asr.whisper, noSpeechThreshold: value } } })} /></div></> : <>{([ ["punctuate", "Add punctuation"], ["smartFormat", "Smart formatting"], ["numerals", "Format numbers as numerals"], ["dictation", "Recognize dictation commands"], ["fillerWords", "Include filler words"] ] as const).map(([key, label]) => <Toggle key={key} label={label} checked={config.asr.nova[key]} onChange={(value) => change({ ...config, asr: { ...config.asr, nova: { ...config.asr.nova, [key]: value } } })} />)}<p className="ai-hint">Provider model-improvement opt-out is always enabled.</p></>}
          <p className="ai-hint">Model prices are estimates, not invoices. Switching recognizers also changes quota reservations.</p>
        </Card>}
        {section === "cleanup" && <Card kicker="02 · TEXT CLEANUP" title="Clean up without rewriting" detail="Correct speech-to-text output while keeping the speaker’s meaning. Output validation remains active for every model.">
          <Toggle label="Enable text cleanup" help="When off, return recognition text directly and skip the cleanup model." checked={config.cleanup.enabled} onChange={(enabled) => change({ ...config, cleanup: { ...config.cleanup, enabled } })} />
          <Field label="Cleanup model" help={cleanupModel.purpose}><select value={config.cleanup.model} onChange={(event) => change({ ...config, cleanup: { ...config.cleanup, model: event.target.value === "gpt-oss-120b" ? "gpt-oss-120b" : "gpt-oss-20b" } })}>{data.catalog.cleanup.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></Field>
          <p className="ai-price-note">${cleanupModel.inputUsdPerMillion.toFixed(2)} input / ${cleanupModel.outputUsdPerMillion.toFixed(2)} output per million tokens</p>
          <div className="ai-field-grid"><NumberField label="Temperature" value={config.cleanup.temperature} min={0} max={1} step={0.05} help="0 is most consistent. Higher values allow more variation." error={field("cleanup.temperature")} onChange={(temperature) => change({ ...config, cleanup: { ...config.cleanup, temperature } })} /><NumberField label="Response token ceiling" value={config.cleanup.maxOutputTokens} min={120} max={1500} step={1} help="Maximum output, not a target. Short recordings use a smaller ceiling." error={field("cleanup.maxOutputTokens")} onChange={(maxOutputTokens) => change({ ...config, cleanup: { ...config.cleanup, maxOutputTokens } })} /></div>
          <div className="ai-callout"><strong>Always enforced</strong><p>Structured output, number preservation, rewrite limits, and a fallback to recognition text when cleanup is unsafe or unavailable.</p></div>
        </Card>}
        {section === "prompts" && <Card kicker="03 · PROMPTS" title="Give each prompt one job" detail="Templates are checked before saving. The transcript and vocabulary are inserted as data, without evaluating nested placeholders.">
          <Prompt label="System prompt" help="Define the cleanup behavior. Keep instructions focused on faithful dictation." value={config.cleanup.systemPrompt} max={3000} error={field("cleanup.systemPrompt")} onChange={(systemPrompt) => change({ ...config, cleanup: { ...config.cleanup, systemPrompt } })} />
          <Prompt label="User prompt template" help="Required once each: {{sentenceStart}}, {{glossary}}, {{commandInstruction}}, {{transcript}}" value={config.cleanup.userPromptTemplate} max={2000} error={field("cleanup.userPromptTemplate")} onChange={(userPromptTemplate) => change({ ...config, cleanup: { ...config.cleanup, userPromptTemplate } })} />
          <Prompt label="Spoken command instruction" help="Used when the client enables spoken formatting commands." value={config.cleanup.commandsPrompt} max={500} error={field("cleanup.commandsPrompt")} onChange={(commandsPrompt) => change({ ...config, cleanup: { ...config.cleanup, commandsPrompt } })} />
          <Prompt label="No-command instruction" help="Used when spoken formatting commands are disabled." value={config.cleanup.noCommandsPrompt} max={500} error={field("cleanup.noCommandsPrompt")} onChange={(noCommandsPrompt) => change({ ...config, cleanup: { ...config.cleanup, noCommandsPrompt } })} />
          <Prompt label="Whisper vocabulary hint" help="Required once: {{glossary}}. Sent only when vocabulary terms are present." value={config.asr.glossaryPrompt} max={500} error={field("asr.glossaryPrompt")} onChange={(glossaryPrompt) => change({ ...config, asr: { ...config.asr, glossaryPrompt } })} />
        </Card>}
        {section === "test" && <Card kicker="04 · TEST WORKSPACE" title="Try the settings you’re editing" detail="Test text cleanup before publishing. This uses the selected model and AI budget; it does not change live settings or create dictation History.">
          <Field label="Sample transcript"><textarea rows={5} maxLength={4000} value={sample} onChange={(event) => setSample(event.target.value)} /></Field>
          <Field label="Protected vocabulary" help="Comma-separated terms · up to 30 terms for a test."><input value={glossary} maxLength={2400} onChange={(event) => setGlossary(event.target.value)} placeholder="WoVoice, Bengaluru" /></Field>
          <div className="ai-field-grid"><Toggle label="Start of a sentence" checked={sentenceStart} onChange={setSentenceStart} /><Toggle label="Spoken formatting commands" checked={commands} onChange={setCommands} /></div>
          <button className="primary-button" disabled={testBusy || !valid || !sample.trim()} onClick={() => void test()}>{testBusy ? "Testing cleanup…" : "Run cleanup test"}</button>
          {!valid && <p className="ai-field-error">Fix the configuration errors before testing.</p>}
          {testResult && <div className="ai-test-result" aria-live="polite"><div className="panel-heading"><h3>{testResult.status === "cleanup_disabled" ? "Recognition text · cleanup is off" : testResult.accepted ? "Passed output checks" : "Recognition text retained"}</h3><span className="status-pill">{testResult.latencyMs} ms</span></div>{testedFingerprint !== evaluationFingerprint && <p className="ai-field-error">Settings or sample changed since this test. Run again to evaluate the current draft.</p>}<pre>{testResult.text}</pre>{testResult.status === "guardrail_fallback" && <p className="ai-hint">The candidate did not pass WoVoice’s output checks. It would not be inserted.</p>}{testResult.candidate && testResult.status === "guardrail_fallback" && <details><summary>Rejected candidate</summary><pre>{testResult.candidate}</pre></details>}{testResult.usage && <p className="ai-hint">{testResult.usage.inputTokens} input · {testResult.usage.outputTokens} output tokens · estimated ${testResult.usage.estimatedCostUsd.toFixed(6)}</p>}<details><summary>Rendered model messages</summary>{testResult.messages.map((item) => <div key={item.role}><h4>{item.role}</h4><pre>{item.content}</pre></div>)}</details></div>}
        </Card>}
        {section === "availability" && <Card kicker="05 · AVAILABILITY" title="Control the dictation service" detail="Pause new dictations during maintenance, or adjust the inference deadline. Sign-in and cloud sync continue to work.">
          <Toggle label="Accept new dictations" help="Turning this off takes effect only after publishing. In-flight recordings keep their original configuration." checked={config.service.enabled} onChange={(enabled) => change({ ...config, service: { ...config.service, enabled } })} />
          <Field label="Maintenance message" help="Shown to clients while new dictations are paused." error={field("service.maintenanceMessage")}><textarea maxLength={160} value={config.service.maintenanceMessage} onChange={(event) => change({ ...config, service: { ...config.service, maintenanceMessage: event.target.value } })} /></Field>
          <NumberField label="Inference timeout (seconds)" value={config.service.timeoutMs / 1000} min={5} max={25} step={1} help="A shared deadline for recognition and cleanup. Keep it within client timeout limits." error={field("service.timeoutMs")} onChange={(seconds) => change({ ...config, service: { ...config.service, timeoutMs: seconds * 1000 } })} />
          <div className="ai-callout"><strong>Deployment-managed safeguards</strong><p>{data.safeguards.maxAudioSeconds}-second audio limit · {data.safeguards.baseDailyAudioSeconds} free seconds/user/day · {data.safeguards.globalDailyNeurons.toLocaleString()} neurons/day · {data.safeguards.monthlyEmails.toLocaleString()} emails/month</p><p>Database-enforced ceilings, credentials, privacy controls, and client language contracts stay deployment-managed. Individual quota grants remain in Users.</p></div>
        </Card>}
        {section === "history" && <Card kicker="06 · REVISIONS" title="A record of every change" detail="Restore any revision as a new draft. Nothing becomes live until you review and publish it.">
          <div className="action-row"><button className="secondary-button" disabled={historyBusy} onClick={() => void history()}>Refresh history</button><button className="secondary-button" onClick={() => { setPublishReason("Restore deployment defaults for review"); setDialog({ restore: "defaults" }); }}>Use deployment defaults</button></div>
          {revisions.length === 0 && <p className="empty">{historyBusy ? "Loading revisions…" : "No saved revisions yet. Built-in defaults are live."}</p>}
          <div className="ai-revisions">{revisions.map((item) => <article key={item.id}><div><h3>Revision {item.version} <span className={`status-pill ${data.active?.id === item.id ? "active" : ""}`}>{data.active?.id === item.id ? "Live" : data.draft?.id === item.id ? "Current draft" : item.kind}</span></h3><p>{item.reason}</p><small>{date(item.createdAt)} · {item.asrModel} → {item.cleanupEnabled ? item.cleanupModel : "cleanup off"}{!item.serviceEnabled ? " · dictation paused" : ""}</small></div><button className="secondary-button" disabled={busy} onClick={() => { setPublishReason(`Restore revision ${item.version} for review`); setDialog({ restore: item.id, version: item.version }); }}>Restore as draft</button></article>)}</div>
          {cursor && <button className="secondary-button load-more" disabled={historyBusy} onClick={() => void history(true)}>Load older revisions</button>}
        </Card>}
        {section !== "history" && <div className="ai-change-note"><Field label="Change note" help="At least 5 characters. Saved with the revision and audit event."><input maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why are you changing these settings?" /></Field><p>{changes.length} field{changes.length === 1 ? "" : "s"} differ from live. Saving a draft has no effect on users.</p>{!valid && <ul className="ai-validation" role="alert">{Object.values(configErrors).map((item) => <li key={item}>{item}</li>)}</ul>}</div>}
      </fieldset>
    </div>
    {dialog === "reload" && <Dialog title="Reload configuration?" onClose={() => setDialog(null)}><p className="muted">{dirty ? "Unsaved edits will be replaced with the latest saved draft. Live settings are unchanged." : "Load the latest published settings and saved draft."}</p><div className="modal-actions"><button className="secondary-button" onClick={() => setDialog(null)}>Keep editing</button><button className="primary-button" onClick={() => { setDialog(null); void load(); }}>Reload latest</button></div></Dialog>}
    {dialog === "publish" && <Dialog title="Review & publish" onClose={() => { if (!busy) setDialog(null); }}><p className="muted">Publish draft revision {data.draft?.version}. These settings will apply to new recordings on Android and Mac.</p><div className="ai-review-list">{changes.length ? changes.map((path) => <details key={path}><summary>{LABELS[path] ?? path}</summary><div className="ai-review-values"><div><small>LIVE</small><pre>{showValue(live, path)}</pre></div><div><small>DRAFT</small><pre>{showValue(config, path)}</pre></div></div></details>) : <p>No field differences from live. This publication records a new revision.</p>}</div><Field label="Publication note"><input value={publishReason} maxLength={500} onChange={(event) => setPublishReason(event.target.value)} /></Field><Toggle label="I reviewed the changes for live dictation" checked={reviewed} onChange={setReviewed} /><div className="modal-actions"><button className="secondary-button" disabled={busy} onClick={() => setDialog(null)}>Keep draft</button><button className="primary-button" disabled={busy || !reviewed || publishReason.trim().length < 5} onClick={() => void publish()}>{busy ? "Publishing…" : "Publish configuration"}</button></div></Dialog>}
    {dialog && typeof dialog === "object" && <Dialog title={dialog.restore === "defaults" ? "Restore deployment defaults" : `Restore revision ${dialog.version}`} onClose={() => { if (!busy) setDialog(null); }}><p className="muted">This replaces the current draft{dirty ? " and your unsaved edits" : ""}. The live configuration stays unchanged until you publish.</p><Field label="Restoration note"><input value={publishReason} maxLength={500} onChange={(event) => setPublishReason(event.target.value)} /></Field><div className="modal-actions"><button className="secondary-button" disabled={busy} onClick={() => setDialog(null)}>Cancel</button><button className="primary-button" disabled={busy || publishReason.trim().length < 5} onClick={() => void restore(dialog.restore)}>Restore as draft</button></div></Dialog>}
  </div>;
}

function Card({ kicker, title, detail, children }: { kicker: string; title: string; detail: string; children: ReactNode }) { return <section className="panel ai-card"><p className="eyebrow">{kicker}</p><h2>{title}</h2><p className="muted">{detail}</p><div className="ai-fields">{children}</div></section>; }
function Field({ label, help, error, children }: { label: string; help?: string; error?: string; children: ReactNode }) { return <label className="ai-field"><span>{label}</span>{children}{help && <small>{help}</small>}{error && <small className="ai-field-error" role="alert">{error}</small>}</label>; }
function Toggle({ label, help, checked, onChange }: { label: string; help?: string; checked: boolean; onChange(checked: boolean): void }) { return <label className="ai-toggle"><span><strong>{label}</strong>{help && <small>{help}</small>}</span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /></label>; }
function NumberField({ label, help, error, value, min, max, step, onChange }: { label: string; help?: string; error?: string; value: number; min: number; max: number; step: number; onChange(value: number): void }) { return <Field label={label} help={help} error={error}><input type="number" value={Number.isFinite(value) ? value : ""} min={min} max={max} step={step} aria-invalid={!!error} onChange={(event) => onChange(event.target.value === "" ? NaN : Number(event.target.value))} /></Field>; }
function Prompt({ label, help, error, value, max, onChange }: { label: string; help: string; error?: string; value: string; max: number; onChange(value: string): void }) { return <Field label={label} help={`${help} · ${value.length}/${max}`} error={error}><textarea className="ai-prompt" rows={label === "System prompt" || label === "User prompt template" ? 7 : 3} value={value} maxLength={max} aria-invalid={!!error} spellCheck={false} onChange={(event) => onChange(event.target.value)} /></Field>; }
function date(value: number) { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(value); }
function message(value: unknown) { return value instanceof AdminApiError && value.status === 401 ? "Your admin session expired. Sign in again before saving; your current edits remain on this screen." : value instanceof Error ? value.message : "The request could not be completed. Try again."; }
function showValue(config: AiConfiguration, path: string): string { let value: unknown = config; for (const part of path.split(".")) value = value && typeof value === "object" ? Reflect.get(value, part) : undefined; return typeof value === "boolean" ? value ? "On" : "Off" : String(value ?? "—"); }

import { describe, expect, it } from "vitest";
import { assertPolishInputFits, changedConfigFields, cleanupReservation, defaultAiConfiguration, polishMessages, validateAiConfiguration } from "../src/ai-config";

describe("AI configuration policy", () => {
  it("validates both deployment defaults without shared mutable state", () => {
    const whisper = defaultAiConfiguration();
    expect(validateAiConfiguration(whisper)).toEqual(whisper);
    expect(validateAiConfiguration(defaultAiConfiguration("nova-3")).asr.model).toBe("nova-3");
    whisper.cleanup.enabled = false;
    expect(defaultAiConfiguration().cleanup.enabled).toBe(true);
  });
  it.each(["{{transcript}}", "{{unknown}}", "{{sentenceStart}} {{glossary}} {{commandInstruction}} {{transcript}} {{transcript}}", "{{sentenceStart}} {{glossary}} {{commandInstruction}} {{transcript}} {{"])("rejects invalid template %s", (template) => {
    const config = defaultAiConfiguration(); config.cleanup.userPromptTemplate = template;
    expect(() => validateAiConfiguration(config)).toThrow("placeholder");
  });
  it("renders user values once without interpreting placeholders inside dictated text or vocabulary", () => {
    const config = defaultAiConfiguration();
    const messages = polishMessages(config, "say {{glossary}} literally", { sentenceStart: false, glossary: ["{{transcript}}"], commands: [] });
    expect(messages[1].content).toContain("Protected vocabulary: {{transcript}}");
    expect(messages[1].content).toContain("say {{glossary}} literally");
    expect(messages[1].content).toContain(config.cleanup.noCommandsPrompt);
  });
  it("bounds UTF-8 input and leaves room for transcript and dictionary terms", () => {
    const config = defaultAiConfiguration();
    config.cleanup.systemPrompt = "声".repeat(1800);
    expect(() => validateAiConfiguration(config)).toThrow("4 KB");
    expect(() => assertPolishInputFits(defaultAiConfiguration(), "😀".repeat(2000), { sentenceStart: true, commands: [], glossary: [] })).toThrow("budget");
  });
  it("reserves enough for the larger approved model and returns zero for disabled cleanup", () => {
    const config = defaultAiConfiguration();
    const normal = cleanupReservation(config);
    config.cleanup.model = "gpt-oss-120b";
    expect(cleanupReservation(config)).toBeGreaterThan(normal);
    config.cleanup.enabled = false;
    expect(cleanupReservation(config)).toBe(0);
  });
  it("reports exact changed fields for review", () => {
    const before = defaultAiConfiguration(); const after = defaultAiConfiguration();
    after.cleanup.model = "gpt-oss-120b"; after.service.enabled = false;
    expect(changedConfigFields(before, after)).toEqual(["service.enabled", "cleanup.model"]);
  });
});

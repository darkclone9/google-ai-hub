import { describe, expect, it } from "vitest";
import {
  GeminiAiClient,
  buildAiPrompt,
  cleanGeminiMarkdown,
  isSourceCurrent,
  resolveGeminiKey,
  sourceHash
} from "./gemini-ai";

describe("Gemini AI helpers", () => {
  it("prefers Secret Storage over the environment", () => {
    expect(resolveGeminiKey(" secret ", " env ")).toBe("secret");
    expect(resolveGeminiKey("", " env ")).toBe("env");
  });

  it("builds fact-preserving action prompts", () => {
    const prompt = buildAiPrompt({ action: "lengthen", title: "Test", markdown: "Original" });
    expect(prompt).toContain("150-180%");
    expect(prompt).toContain("without inventing facts");
    expect(prompt).toContain("Original");
  });

  it("removes a single Markdown fence", () => {
    expect(cleanGeminiMarkdown("```markdown\n# Result\n```" )).toBe("# Result");
  });

  it("detects a stale source", () => {
    const hash = sourceHash("before");
    expect(isSourceCurrent(hash, "before")).toBe(true);
    expect(isSourceCurrent(hash, "after")).toBe(false);
  });

  it("parses generated text through the injected transport", async () => {
    const client = new GeminiAiClient(
      { post: async () => ({ candidates: [{ content: { parts: [{ text: "Short result" }] } }] }) },
      () => "key",
      () => "model"
    );
    await expect(client.generate({ action: "shorten", title: "Test", markdown: "Long source" }))
      .resolves.toMatchObject({ markdown: "Short result", action: "shorten" });
  });

  it("turns quota failures into an actionable error", async () => {
    const client = new GeminiAiClient(
      { post: async () => Promise.reject({ status: 429 }) },
      () => "key",
      () => "model"
    );
    await expect(client.generate({ action: "summarize", title: "Test", markdown: "Source" }))
      .rejects.toThrow("quota was exceeded");
  });
});

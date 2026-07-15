import { describe, expect, it } from "vitest";
import {
  GeminiAiClient,
  buildAiPrompt,
  cleanGeminiMarkdown,
  isSourceCurrent,
  mergeGeminiModels,
  parseGeminiModelList,
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

  it("filters account models to text generation choices", () => {
    const models = parseGeminiModelList({
      models: [
        { name: "models/gemini-writing", displayName: "Writing", supportedGenerationMethods: ["generateContent"] },
        { name: "models/text-embedding", displayName: "Embedding", supportedGenerationMethods: ["embedContent"] }
      ]
    });
    expect(models).toEqual([expect.objectContaining({ id: "gemini-writing", displayName: "Writing" })]);
  });

  it("keeps recommended, discovered, and custom models available", () => {
    const models = mergeGeminiModels(
      [{ id: "models/account-model", displayName: "Account model", description: "Available" }],
      ["custom-model"]
    );
    expect(models.map(model => model.id)).toEqual(expect.arrayContaining([
      "gemini-3.1-pro-preview",
      "gemini-3.5-flash",
      "account-model",
      "custom-model"
    ]));
  });

  it("uses a per-request model override", async () => {
    let requestedUrl = "";
    const client = new GeminiAiClient(
      {
        post: async url => {
          requestedUrl = url;
          return { candidates: [{ content: { parts: [{ text: "Result" }] } }] };
        }
      },
      () => "key",
      () => "gemini-3.5-flash"
    );
    const result = await client.generate({
      action: "elaborate",
      title: "Test",
      markdown: "Source",
      model: "models/gemini-3.1-pro-preview"
    });
    expect(requestedUrl).toContain("gemini-3.1-pro-preview");
    expect(result.model).toBe("gemini-3.1-pro-preview");
  });

  it("discovers models available to the current API key", async () => {
    const client = new GeminiAiClient(
      {
        post: async () => ({}),
        get: async () => ({
          models: [{
            name: "models/gemini-account-model",
            displayName: "Account model",
            supportedGenerationMethods: ["generateContent"]
          }]
        })
      },
      () => "key",
      () => "gemini-3.5-flash"
    );
    await expect(client.listModels()).resolves.toEqual([
      expect.objectContaining({ id: "gemini-account-model", displayName: "Account model" })
    ]);
  });
});

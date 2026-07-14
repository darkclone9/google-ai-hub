export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";
export const MAX_AI_SOURCE_LENGTH = 200_000;

export type AiAction = "summarize" | "shorten" | "lengthen" | "elaborate" | "briefing" | "chat";
export type AiWritingAction = AiAction;

export interface AiDocumentSource {
  title: string;
  markdown: string;
  description: string;
  readRevision?: () => Promise<string>;
  replace?: (markdown: string) => Promise<void>;
  insert?: (markdown: string) => Promise<void>;
}

export interface DocumentAiAdapter extends AiDocumentSource {
  readRevision(): Promise<string>;
  replace(markdown: string): Promise<void>;
  insertBelow(markdown: string): Promise<void>;
}

export interface AiGenerateRequest {
  action: AiWritingAction;
  title: string;
  markdown: string;
  instruction?: string;
  conversation?: Array<{ role: "user" | "model"; text: string }>;
}

export interface AiResult {
  action: AiWritingAction;
  markdown: string;
  sourceHash: string;
}

export interface GeminiTransport {
  post(url: string, apiKey: string, body: Record<string, unknown>): Promise<unknown>;
}

const ACTION_INSTRUCTIONS: Record<Exclude<AiWritingAction, "chat">, string> = {
  summarize: "Condense the source to roughly 25-35% of its original length. Retain essential facts, names, decisions, headings, and links.",
  shorten: "Remove repetition and unnecessary wording while retaining all important meaning. Target roughly 60% of the original length.",
  lengthen: "Expand the source to roughly 150-180% of its original length. Improve transitions and useful detail without inventing facts, names, or canon.",
  elaborate: "Add clearer explanation and supported context. Preserve established names and canon and do not invent events or claims that are absent from the source.",
  briefing: "Create a concise briefing report with an executive summary, key points, open questions, and recommended next steps. Ground every statement in the source."
};

export function sourceHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function isSourceCurrent(expectedHash: string, currentMarkdown: string): boolean {
  return expectedHash === sourceHash(currentMarkdown);
}

export function resolveGeminiKey(secretValue: string | null | undefined, environmentValue: string | null | undefined): string {
  return secretValue?.trim() || environmentValue?.trim() || "";
}

export function cleanGeminiMarkdown(value: string): string {
  const trimmed = value.trim();
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  return (fenced?.[1] || trimmed).trim();
}

export function buildAiPrompt(request: AiGenerateRequest): string {
  const shared = [
    "You are an editing assistant inside Obsidian and Google Docs.",
    "Return only the requested Markdown. Do not wrap it in a code fence.",
    "Preserve useful Markdown headings, lists, emphasis, and links.",
    "Do not add facts that are not supported by the supplied source.",
    `Document title: ${request.title}`
  ];
  if (request.action === "chat") {
    return [
      ...shared,
      "Answer the question using only the source document. If the source does not support an answer, say so clearly.",
      `Question: ${request.instruction || "Summarize the source."}`,
      "",
      "--- BEGIN SOURCE ---",
      request.markdown,
      "--- END SOURCE ---"
    ].join("\n");
  }
  return [
    ...shared,
    ACTION_INSTRUCTIONS[request.action],
    request.instruction ? `Additional instruction: ${request.instruction}` : "",
    "",
    "--- BEGIN SOURCE ---",
    request.markdown,
    "--- END SOURCE ---"
  ].filter(Boolean).join("\n");
}

function responseText(payload: unknown): string {
  const response = payload as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      finishReason?: string;
    }>;
    promptFeedback?: { blockReason?: string };
    error?: { message?: string };
  };
  if (response.error?.message) throw new Error(response.error.message);
  const text = response.candidates?.[0]?.content?.parts
    ?.map(part => part.text || "")
    .join("")
    .trim();
  if (text) return text;
  if (response.promptFeedback?.blockReason) {
    throw new Error(`Gemini blocked this request: ${response.promptFeedback.blockReason}.`);
  }
  if (response.candidates?.[0]?.finishReason) {
    throw new Error(`Gemini returned no editable text (${response.candidates[0].finishReason}).`);
  }
  throw new Error("Gemini returned no editable text.");
}

function transportError(error: unknown): Error {
  const failure = error as { status?: number; message?: string };
  if (failure.status === 401 || failure.status === 403) {
    return new Error("Gemini rejected the API key or this model is not available to the key. Check AI settings and Google account access.");
  }
  if (failure.status === 429) {
    return new Error("Gemini quota was exceeded. Check the account quota or billing, then try again later.");
  }
  if (typeof failure.status === "number" && failure.status >= 500) {
    return new Error("Gemini is temporarily unavailable. Try again later.");
  }
  return new Error(failure.message
    ? `Could not reach Gemini: ${failure.message}`
    : "Could not reach Gemini. Check the network connection and try again.");
}

export class GeminiAiClient {
  constructor(
    private readonly transport: GeminiTransport,
    private readonly getApiKey: () => string,
    private readonly getModel: () => string
  ) {}

  async generate(request: AiGenerateRequest): Promise<AiResult> {
    if (!request.markdown.trim()) throw new Error("There is no document text to send to AI.");
    if (request.markdown.length > MAX_AI_SOURCE_LENGTH) {
      throw new Error(`This source is ${request.markdown.length.toLocaleString()} characters. Choose a source under ${MAX_AI_SOURCE_LENGTH.toLocaleString()} characters.`);
    }
    const apiKey = this.getApiKey();
    if (!apiKey) throw new Error("Add a Gemini API key in Google AI Hub settings or set GEMINI_API_KEY.");
    const model = this.getModel().trim() || DEFAULT_GEMINI_MODEL;
    const contents = [
      ...(request.conversation || []).slice(-6).map(message => ({
        role: message.role,
        parts: [{ text: message.text }]
      })),
      { role: "user", parts: [{ text: buildAiPrompt(request) }] }
    ];
    let payload: unknown;
    try {
      payload = await this.transport.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        apiKey,
        {
          contents,
          generationConfig: {
            temperature: request.action === "chat" ? 0.35 : 0.25,
            topP: 0.9
          }
        }
      );
    } catch (error) {
      throw transportError(error);
    }
    return {
      action: request.action,
      markdown: cleanGeminiMarkdown(responseText(payload)),
      sourceHash: sourceHash(request.markdown)
    };
  }
}

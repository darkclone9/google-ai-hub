import {
  App,
  ButtonComponent,
  Component,
  FuzzySuggestModal,
  ItemView,
  MarkdownRenderer,
  Menu,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
  TFolder,
  WorkspaceLeaf,
  requestUrl,
  type Editor,
  type ViewStateResult
} from "obsidian";
import TurndownService from "turndown";
import {
  GoogleDriveBridge,
  type GoogleDocBulletRange,
  type GoogleDocParagraphStyleRange,
  type GoogleDocTabContentUpdate,
  type GoogleDocTabInfo,
  type GoogleDocTextStyleRange,
  type NoteMirror
} from "./google-drive";
import {
  buildGeminiLoaderScript,
  buildNotebookLmLoaderScript,
  type SourceLoadResult
} from "./service-loader";
import {
  DEFAULT_GEMINI_MODEL,
  GeminiAiClient,
  isSourceCurrent,
  mergeGeminiModels,
  normalizeGeminiModelId,
  resolveGeminiKey,
  sourceHash,
  type AiDocumentSource,
  type AiResult,
  type AiWritingAction,
  type DocumentAiAdapter,
  type GeminiModelInfo
} from "./gemini-ai";
import { GoogleDocTabSyncRegistry, type GoogleDocTabChange } from "./tab-sync";

const VIEW_TYPE_GOOGLE_AI_HUB = "google-ai-hub-view";
const GEMINI_SECRET_ID = "google-ai-hub-gemini-api-key";

type ServiceKey = "home" | "notebooklm" | "gemini" | "drive";
type AiService = "notebooklm" | "gemini";
type UrlSettingKey = "notebookLmUrl" | "geminiUrl" | "driveUrl";

interface GoogleAiHubSettings {
  notebookLmUrl: string;
  geminiUrl: string;
  driveUrl: string;
  googleCredentialsPath: string;
  googleDocsFolder: string;
  autoSyncGoogleDocs: boolean;
  geminiModel: string;
  geminiKnownModels: GeminiModelInfo[];
  googleDocShortcuts: Record<string, string>;
  noteMirrors: Record<string, NoteMirror>;
  folderMirrors: Record<string, NoteMirror>;
}

interface GoogleAiHubViewState extends Record<string, unknown> {
  service?: ServiceKey;
}

interface GoogleDocShortcut {
  url?: string;
  doc_id?: string;
  resource_id?: string;
}

interface LinkEditorResult {
  text: string;
  url: string;
}

interface TabEditorResult {
  title: string;
  iconEmoji: string;
}

type TabCardPlacement = "above" | "below";

interface TabCardEditorResult extends TabEditorResult {
  placement: TabCardPlacement;
}

interface StoredGoogleDocDraft {
  markdown: string;
  updatedAt: number;
}

type AiDocumentTarget = DocumentAiAdapter;

type AiResultChoice = "replace" | "insert" | "copy" | "regenerate";

class LinkEditorModal extends Modal {
  private resolver: ((result: LinkEditorResult | null) => void) | null = null;
  private settled = false;
  private linkText: string;
  private linkUrl: string;

  constructor(
    app: App,
    private readonly needsText: boolean,
    initialText: string,
    initialUrl: string
  ) {
    super(app);
    this.linkText = initialText;
    this.linkUrl = initialUrl;
  }

  openAndWait(): Promise<LinkEditorResult | null> {
    return new Promise(resolve => {
      this.resolver = resolve;
      this.open();
    });
  }

  onOpen(): void {
    this.titleEl.setText("Add link");
    this.contentEl.empty();

    if (this.needsText) {
      new Setting(this.contentEl)
        .setName("Text to display")
        .addText(text => {
          text.setValue(this.linkText);
          text.onChange(value => this.linkText = value);
        });
    }

    const urlSetting = new Setting(this.contentEl)
      .setName("Link URL")
      .setDesc("Supports https, http, mailto, and #anchor links.")
      .addText(text => {
        text.setValue(this.linkUrl);
        text.onChange(value => this.linkUrl = value);
      });
    const urlInput = urlSetting.controlEl.querySelector<HTMLInputElement>("input");

    new Setting(this.contentEl)
      .addButton(button => button
        .setButtonText("Cancel")
        .onClick(() => this.finish(null)))
      .addButton(button => button
        .setButtonText("Save link")
        .setCta()
        .onClick(() => this.submit()));

    urlInput?.addEventListener("keydown", event => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      this.submit();
    });
    window.setTimeout(() => {
      urlInput?.focus();
      urlInput?.select();
    }, 0);
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.finish(null, false);
  }

  private submit(): void {
    if (this.needsText && !this.linkText.trim()) {
      new Notice("Enter text to display for the link.", 4000);
      return;
    }
    if (!this.linkUrl.trim()) {
      new Notice("Enter a link URL.", 4000);
      return;
    }
    this.finish({ text: this.linkText.trim(), url: this.linkUrl.trim() });
  }

  private finish(result: LinkEditorResult | null, close = true): void {
    if (this.settled) return;
    this.settled = true;
    this.resolver?.(result);
    this.resolver = null;
    if (close) this.close();
  }
}

class TabEditorModal extends Modal {
  private resolver: ((result: TabEditorResult | null) => void) | null = null;
  private settled = false;
  private titleValue: string;
  private iconValue: string;

  constructor(
    app: App,
    private readonly heading: string,
    initialTitle: string,
    initialIcon: string
  ) {
    super(app);
    this.titleValue = initialTitle;
    this.iconValue = initialIcon;
  }

  openAndWait(): Promise<TabEditorResult | null> {
    return new Promise(resolve => {
      this.resolver = resolve;
      this.open();
    });
  }

  onOpen(): void {
    this.titleEl.setText(this.heading);
    this.contentEl.empty();
    let titleInput: HTMLInputElement | null = null;

    const titleSetting = new Setting(this.contentEl)
      .setName("Tab name")
      .addText(text => {
        text.setValue(this.titleValue);
        text.onChange(value => this.titleValue = value);
      });
    titleInput = titleSetting.controlEl.querySelector<HTMLInputElement>("input");

    new Setting(this.contentEl)
      .setName("Icon emoji")
      .setDesc("Optional; use one emoji or leave blank for Google's document icon.")
      .addText(text => {
        text.setValue(this.iconValue);
        text.onChange(value => this.iconValue = value);
      });

    new Setting(this.contentEl)
      .addButton(button => button
        .setButtonText("Cancel")
        .onClick(() => this.finish(null)))
      .addButton(button => button
        .setButtonText("Save tab")
        .setCta()
        .onClick(() => this.submit()));

    titleInput?.addEventListener("keydown", event => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      this.submit();
    });
    window.setTimeout(() => {
      titleInput?.focus();
      titleInput?.select();
    }, 0);
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.finish(null, false);
  }

  private submit(): void {
    const title = this.titleValue.trim();
    if (!title) {
      new Notice("Enter a name for the tab.", 4000);
      return;
    }
    this.finish({ title, iconEmoji: this.iconValue.trim() });
  }

  private finish(result: TabEditorResult | null, close = true): void {
    if (this.settled) return;
    this.settled = true;
    this.resolver?.(result);
    this.resolver = null;
    if (close) this.close();
  }
}

class TabCardEditorModal extends Modal {
  private resolver: ((result: TabCardEditorResult | null) => void) | null = null;
  private settled = false;
  private titleValue = "New tab";
  private iconValue = "";

  constructor(app: App, private readonly sourceTabTitle: string) {
    super(app);
  }

  openAndWait(): Promise<TabCardEditorResult | null> {
    return new Promise(resolve => {
      this.resolver = resolve;
      this.open();
    });
  }

  onOpen(): void {
    this.titleEl.setText("Create a tab and Canvas card");
    this.contentEl.empty();
    this.contentEl.createEl("p", {
      text: `Choose where the new tab should sit relative to “${this.sourceTabTitle}”. The new Canvas card will open that tab.`
    });

    const titleSetting = new Setting(this.contentEl)
      .setName("Tab name")
      .addText(text => {
        text.setValue(this.titleValue);
        text.onChange(value => this.titleValue = value);
      });
    const titleInput = titleSetting.controlEl.querySelector<HTMLInputElement>("input");

    new Setting(this.contentEl)
      .setName("Icon emoji")
      .setDesc("Optional; use one emoji or leave blank for Google’s document icon.")
      .addText(text => {
        text.setValue(this.iconValue);
        text.onChange(value => this.iconValue = value);
      });

    new Setting(this.contentEl)
      .addButton(button => button
        .setButtonText("Cancel")
        .onClick(() => this.finish(null)))
      .addButton(button => button
        .setButtonText("Create above")
        .onClick(() => this.submit("above")))
      .addButton(button => button
        .setButtonText("Create below")
        .setCta()
        .onClick(() => this.submit("below")));

    titleInput?.addEventListener("keydown", event => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      this.submit("below");
    });
    window.setTimeout(() => {
      titleInput?.focus();
      titleInput?.select();
    }, 0);
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.finish(null, false);
  }

  private submit(placement: TabCardPlacement): void {
    const title = this.titleValue.trim();
    if (!title) {
      new Notice("Enter a name for the tab.", 4000);
      return;
    }
    this.finish({ title, iconEmoji: this.iconValue.trim(), placement });
  }

  private finish(result: TabCardEditorResult | null, close = true): void {
    if (this.settled) return;
    this.settled = true;
    this.resolver?.(result);
    this.resolver = null;
    if (close) this.close();
  }
}

class DeleteTabModal extends Modal {
  private resolver: ((confirmed: boolean) => void) | null = null;
  private settled = false;

  constructor(
    app: App,
    private readonly tabTitle: string,
    private readonly childCount: number
  ) {
    super(app);
  }

  openAndWait(): Promise<boolean> {
    return new Promise(resolve => {
      this.resolver = resolve;
      this.open();
    });
  }

  onOpen(): void {
    this.titleEl.setText("Delete Google Doc tab?");
    this.contentEl.empty();
    this.contentEl.createEl("p", {
      text: this.childCount
        ? `Delete “${this.tabTitle}” and its ${this.childCount} nested tab${this.childCount === 1 ? "" : "s"}? This removes their content from Google Docs.`
        : `Delete “${this.tabTitle}”? This removes the tab and its content from Google Docs.`
    });
    new Setting(this.contentEl)
      .addButton(button => button
        .setButtonText("Cancel")
        .onClick(() => this.finish(false)))
      .addButton(button => button
        .setButtonText("Delete tab")
        .setWarning()
        .onClick(() => this.finish(true)));
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.finish(false, false);
  }

  private finish(confirmed: boolean, close = true): void {
    if (this.settled) return;
    this.settled = true;
    this.resolver?.(confirmed);
    this.resolver = null;
    if (close) this.close();
  }
}

class GoogleDocTabPickerModal extends FuzzySuggestModal<GoogleDocTabInfo> {
  private resolver: ((tab: GoogleDocTabInfo | null) => void) | null = null;
  private settled = false;

  constructor(app: App, private readonly tabs: GoogleDocTabInfo[]) {
    super(app);
    this.setPlaceholder("Choose a Google Doc tab...");
  }

  openAndWait(): Promise<GoogleDocTabInfo | null> {
    return new Promise(resolve => {
      this.resolver = resolve;
      this.open();
    });
  }

  getItems(): GoogleDocTabInfo[] {
    return this.tabs;
  }

  getItemText(tab: GoogleDocTabInfo): string {
    return `${"  ".repeat(tab.nestingLevel)}${tab.iconEmoji ? `${tab.iconEmoji} ` : ""}${tab.title}`;
  }

  onChooseItem(tab: GoogleDocTabInfo): void {
    this.finish(tab);
  }

  onClose(): void {
    super.onClose();
    if (!this.settled) this.finish(null, false);
  }

  private finish(tab: GoogleDocTabInfo | null, close = true): void {
    if (this.settled) return;
    this.settled = true;
    this.resolver?.(tab);
    this.resolver = null;
    if (close) this.close();
  }
}

class GeminiModelPickerModal extends FuzzySuggestModal<GeminiModelInfo> {
  private resolver: ((model: GeminiModelInfo | null) => void) | null = null;
  private settled = false;

  constructor(
    app: App,
    private readonly models: GeminiModelInfo[],
    private readonly currentModel: string
  ) {
    super(app);
    this.setPlaceholder("Choose a Gemini model...");
  }

  openAndWait(): Promise<GeminiModelInfo | null> {
    return new Promise(resolve => {
      this.resolver = resolve;
      this.open();
    });
  }

  getItems(): GeminiModelInfo[] {
    return this.models;
  }

  getItemText(model: GeminiModelInfo): string {
    const current = model.id === this.currentModel ? "Current - " : "";
    return `${current}${model.displayName} (${model.id}) - ${model.description}`;
  }

  onChooseItem(model: GeminiModelInfo): void {
    this.finish(model);
  }

  onClose(): void {
    super.onClose();
    if (!this.settled) this.finish(null, false);
  }

  private finish(model: GeminiModelInfo | null, close = true): void {
    if (this.settled) return;
    this.settled = true;
    this.resolver?.(model);
    this.resolver = null;
    if (close) this.close();
  }
}

class AiResultModal extends Modal {
  private resolver: ((choice: AiResultChoice | null) => void) | null = null;
  private settled = false;

  constructor(
    app: App,
    private readonly action: AiWritingAction,
    private readonly original: string,
    private readonly result: string,
    private readonly canWrite: boolean,
    private readonly model = ""
  ) {
    super(app);
  }

  openAndWait(): Promise<AiResultChoice | null> {
    return new Promise(resolve => {
      this.resolver = resolve;
      this.open();
    });
  }

  onOpen(): void {
    this.titleEl.setText(`AI ${this.action === "briefing" ? "briefing report" : this.action}`);
    this.contentEl.empty();
    if (this.model) {
      this.contentEl.createEl("p", {
        cls: "google-ai-hub-ai-model-used",
        text: `Generated with ${this.model}`
      });
    }
    const comparison = this.contentEl.createDiv({ cls: "google-ai-hub-ai-comparison" });
    for (const [label, value] of [["Original", this.original], ["AI result", this.result]] as const) {
      const column = comparison.createDiv({ cls: "google-ai-hub-ai-comparison-column" });
      column.createEl("h3", { text: label });
      const textarea = column.createEl("textarea", { cls: "google-ai-hub-ai-result-text" });
      textarea.value = value;
      textarea.readOnly = true;
    }
    if (!this.canWrite) {
      this.contentEl.createEl("p", {
        cls: "google-ai-hub-ai-stale-warning",
        text: "The source changed while AI was working. Copy or regenerate the result; writing it back is disabled to prevent data loss."
      });
    }
    const buttons = this.contentEl.createDiv({ cls: "google-ai-hub-ai-result-actions" });
    new ButtonComponent(buttons).setButtonText("Cancel").onClick(() => this.finish(null));
    new ButtonComponent(buttons).setButtonText("Regenerate").onClick(() => this.finish("regenerate"));
    new ButtonComponent(buttons).setButtonText("Copy").onClick(() => this.finish("copy"));
    new ButtonComponent(buttons)
      .setButtonText("Insert below")
      .setDisabled(!this.canWrite)
      .onClick(() => this.finish("insert"));
    new ButtonComponent(buttons)
      .setButtonText("Replace")
      .setDisabled(!this.canWrite)
      .setCta()
      .onClick(() => this.finish("replace"));
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.finish(null, false);
  }

  private finish(choice: AiResultChoice | null, close = true): void {
    if (this.settled) return;
    this.settled = true;
    this.resolver?.(choice);
    this.resolver = null;
    if (close) this.close();
  }
}

interface InlineStyleState {
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  code: boolean;
  linkUrl: string;
}

function buildGoogleDocTabContent(root: HTMLElement): GoogleDocTabContentUpdate {
  let text = "";
  const textStyles: GoogleDocTextStyleRange[] = [];
  const paragraphStyles: GoogleDocParagraphStyleRange[] = [];
  const bullets: GoogleDocBulletRange[] = [];

  const appendText = (value: string, style: InlineStyleState): void => {
    const cleaned = value.replace(/\u200B/g, "");
    if (!cleaned) return;
    const startIndex = text.length;
    text += cleaned;
    const endIndex = text.length;
    if (!style.bold && !style.italic && !style.strikethrough && !style.code && !style.linkUrl) return;
    const next: GoogleDocTextStyleRange = {
      startIndex,
      endIndex,
      bold: style.bold || undefined,
      italic: style.italic || undefined,
      strikethrough: style.strikethrough || undefined,
      code: style.code || undefined,
      linkUrl: style.linkUrl || undefined
    };
    const previous = textStyles[textStyles.length - 1];
    if (
      previous
      && previous.endIndex === next.startIndex
      && previous.bold === next.bold
      && previous.italic === next.italic
      && previous.strikethrough === next.strikethrough
      && previous.code === next.code
      && previous.linkUrl === next.linkUrl
    ) {
      previous.endIndex = next.endIndex;
    } else {
      textStyles.push(next);
    }
  };

  const appendInline = (node: Node, inherited: InlineStyleState): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      appendText(node.nodeValue || "", inherited);
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.matches("button, input, .copy-code-button, .heading-collapse-indicator")) return;
    if (node.tagName === "BR") {
      appendText("\n", inherited);
      return;
    }
    if (node.tagName === "IMG") {
      appendText(node.getAttribute("alt") || "Embedded image", inherited);
      return;
    }
    if (["UL", "OL", "TABLE"].includes(node.tagName)) return;

    const style: InlineStyleState = {
      bold: inherited.bold || ["STRONG", "B"].includes(node.tagName),
      italic: inherited.italic || ["EM", "I"].includes(node.tagName),
      strikethrough: inherited.strikethrough || ["S", "DEL", "STRIKE"].includes(node.tagName),
      code: inherited.code || ["CODE", "PRE"].includes(node.tagName),
      linkUrl: node.tagName === "A" ? node.getAttribute("href") || "" : inherited.linkUrl
    };
    for (const child of Array.from(node.childNodes)) appendInline(child, style);
  };

  const normalStyle: InlineStyleState = {
    bold: false,
    italic: false,
    strikethrough: false,
    code: false,
    linkUrl: ""
  };
  const blockSelector = "h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,tr,hr,div";
  const blocks = Array.from(root.querySelectorAll<HTMLElement>(blockSelector)).filter(block => {
    if (block.tagName === "P" && block.closest("li,pre,table,blockquote")) return false;
    if (/^H[1-6]$/.test(block.tagName) && block.closest("li,table,blockquote")) return false;
    if (block.tagName === "BLOCKQUOTE" && block.parentElement?.closest("blockquote")) return false;
    if (block.tagName === "DIV") {
      if (block.closest("li,pre,table,blockquote")) return false;
      if (block.querySelector(":scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6, :scope > p, :scope > div, :scope > ul, :scope > ol, :scope > pre, :scope > blockquote, :scope > table")) {
        return false;
      }
    }
    return true;
  });

  for (const block of blocks) {
    const startIndex = text.length;
    if (block.tagName === "HR") {
      appendText("---\n", normalStyle);
      paragraphStyles.push({ startIndex, endIndex: text.length, namedStyleType: "NORMAL_TEXT" });
      continue;
    }

    if (block.tagName === "TR") {
      const cells = Array.from(block.querySelectorAll<HTMLElement>(":scope > th, :scope > td"))
        .map(cell => (cell.innerText || cell.textContent || "").replace(/\s+/g, " ").trim());
      appendText(cells.join(" | "), normalStyle);
    } else if (block.tagName === "PRE") {
      appendText(block.innerText || block.textContent || "", { ...normalStyle, code: true });
    } else if (block.tagName === "LI") {
      let depth = 0;
      let ancestor = block.parentElement?.closest("li");
      while (ancestor) {
        depth += 1;
        ancestor = ancestor.parentElement?.closest("li");
      }
      if (depth) appendText("\t".repeat(depth), normalStyle);
      appendInline(block, normalStyle);
    } else {
      appendInline(block, normalStyle);
    }

    if (!text.endsWith("\n")) appendText("\n", normalStyle);
    const endIndex = text.length;
    const headingMatch = /^H([1-6])$/.exec(block.tagName);
    paragraphStyles.push({
      startIndex,
      endIndex,
      namedStyleType: headingMatch ? `HEADING_${headingMatch[1]}` : "NORMAL_TEXT",
      indentStartPoints: block.tagName === "BLOCKQUOTE" ? 18 : block.tagName === "PRE" ? 12 : undefined
    });

    if (block.tagName === "LI") {
      bullets.push({
        startIndex,
        endIndex,
        preset: block.closest("ol") ? "NUMBERED_DECIMAL_NESTED" : "BULLET_DISC_CIRCLE_SQUARE"
      });
    }
  }

  if (!blocks.length) {
    appendText(root.innerText || root.textContent || "", normalStyle);
    if (text && !text.endsWith("\n")) text += "\n";
    if (text) paragraphStyles.push({ startIndex: 0, endIndex: text.length, namedStyleType: "NORMAL_TEXT" });
  }

  return { text, textStyles, paragraphStyles, bullets };
}

interface WebviewElement extends HTMLElement {
  canGoBack(): boolean;
  canGoForward(): boolean;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  getURL(): string;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
}

interface CanvasGoogleDocWebview extends HTMLElement {
}

interface CanvasFileNodeData {
  id: string;
  type: "file";
  file: string;
  subpath?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CanvasRuntimeNode {
  id: string;
  nodeEl?: HTMLElement;
  file?: TFile;
  getData(): CanvasFileNodeData;
}

interface CanvasRuntimeData {
  nodes: Array<Record<string, unknown> & {
    id: string;
    type: string;
  }>;
  edges: Array<Record<string, unknown>>;
}

interface CanvasRuntime {
  nodes: Map<string, CanvasRuntimeNode>;
  edgeFrom?: {
    data?: Map<string | CanvasRuntimeNode, unknown>;
  };
  getData(): CanvasRuntimeData;
  getSelectionData(): CanvasRuntimeData;
  setData(data: CanvasRuntimeData): void | Promise<void>;
  posFromClient(event: MouseEvent): { x: number; y: number };
  createFileNode(options: {
    pos: { x: number; y: number };
    position: "center";
    size: { width: number; height: number };
    file: TFile;
    subpath?: string;
    save: boolean;
    focus: boolean;
  }): CanvasRuntimeNode | null;
  requestSave(): void;
}

interface CanvasRuntimeView {
  file?: TFile;
  canvas?: CanvasRuntime;
}

interface CanvasRuntimeContext {
  canvas: CanvasRuntime;
  node: CanvasRuntimeNode;
}

interface CanvasGoogleDocConnectorAction extends CanvasRuntimeContext {
  createTabCard(addCardButton: HTMLElement): Promise<void>;
}

const GOOGLE_DOC_TAB_SUBPATH_PREFIX = "#google-ai-hub-tab=";

function googleDocTabSubpath(tabId: string): string {
  return `${GOOGLE_DOC_TAB_SUBPATH_PREFIX}${encodeURIComponent(tabId)}`;
}

function parseGoogleDocTabSubpath(subpath: string | undefined): string {
  if (!subpath?.startsWith(GOOGLE_DOC_TAB_SUBPATH_PREFIX)) return "";
  try {
    return decodeURIComponent(subpath.slice(GOOGLE_DOC_TAB_SUBPATH_PREFIX.length));
  } catch {
    return "";
  }
}

const DEFAULT_SETTINGS: GoogleAiHubSettings = {
  notebookLmUrl: "https://notebooklm.google.com/",
  geminiUrl: "https://gemini.google.com/app",
  driveUrl: "https://drive.google.com/drive/my-drive",
  googleCredentialsPath: "C:\\path\\to\\credentials.json",
  googleDocsFolder: "Google Docs",
  autoSyncGoogleDocs: true,
  geminiModel: DEFAULT_GEMINI_MODEL,
  geminiKnownModels: [],
  googleDocShortcuts: {},
  noteMirrors: {},
  folderMirrors: {}
};

const SERVICE_DETAILS: Record<Exclude<ServiceKey, "home">, {
  title: string;
  icon: string;
  description: string;
  settingKey: UrlSettingKey;
}> = {
  notebooklm: {
    title: "NotebookLM",
    icon: "notebook-tabs",
    description: "Research, source-grounded chat, and notebook generation.",
    settingKey: "notebookLmUrl"
  },
  gemini: {
    title: "Gemini",
    icon: "sparkles",
    description: "Google's AI workspace for writing, analysis, and ideation.",
    settingKey: "geminiUrl"
  },
  drive: {
    title: "Google Drive & Docs",
    icon: "hard-drive",
    description: "Browse Drive and open native Google Docs in an editable tab.",
    settingKey: "driveUrl"
  }
};

function isServiceKey(value: unknown): value is ServiceKey {
  return value === "home" || value === "notebooklm" || value === "gemini" || value === "drive";
}

function normalizeUrl(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!trimmed) return fallback;

  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" ? url.toString() : fallback;
  } catch {
    return fallback;
  }
}

function getGoogleDocId(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "docs.google.com") return null;
    return parsed.pathname.match(/^\/document\/d\/([^/]+)/)?.[1] || null;
  } catch {
    return null;
  }
}


class VaultItemSuggestModal extends FuzzySuggestModal<TFile | TFolder> {
  constructor(
    app: GoogleAiHubPlugin["app"],
    private readonly onChoose: (item: TFile | TFolder) => void
  ) {
    super(app);
    this.setPlaceholder("Choose an Obsidian note, folder, or Google Doc...");
  }

  getItems(): Array<TFile | TFolder> {
    return [
      ...this.app.vault.getAllFolders(false).filter(folder => !folder.path.startsWith(".")),
      ...this.app.vault.getFiles().filter(file => file.extension === "md" || file.extension === "gdoc")
    ];
  }

  getItemText(item: TFile | TFolder): string {
    return item instanceof TFolder ? `${item.path}/` : item.path;
  }

  onChooseItem(item: TFile | TFolder): void {
    this.onChoose(item);
  }
}

class AiSourcePickerModal extends FuzzySuggestModal<TFile | TFolder> {
  private resolver: ((item: TFile | TFolder | null) => void) | null = null;
  private settled = false;

  constructor(app: App) {
    super(app);
    this.setPlaceholder("Choose a Markdown note, folder, or Google Doc...");
  }

  openAndWait(): Promise<TFile | TFolder | null> {
    return new Promise(resolve => {
      this.resolver = resolve;
      this.open();
    });
  }

  getItems(): Array<TFile | TFolder> {
    return [
      ...this.app.vault.getAllFolders(false).filter(folder => !folder.path.startsWith(".")),
      ...this.app.vault.getFiles().filter(file => file.extension === "md" || file.extension === "gdoc")
    ];
  }

  getItemText(item: TFile | TFolder): string {
    return item instanceof TFolder ? `${item.path}/` : item.path;
  }

  onChooseItem(item: TFile | TFolder): void {
    this.finish(item);
  }

  onClose(): void {
    super.onClose();
    if (!this.settled) this.finish(null, false);
  }

  private finish(item: TFile | TFolder | null, close = true): void {
    if (this.settled) return;
    this.settled = true;
    this.resolver?.(item);
    this.resolver = null;
    if (close) this.close();
  }
}

class GoogleAiHubView extends ItemView {
  private service: ServiceKey = "home";
  private webview: WebviewElement | null = null;
  private webviewReady: Promise<void> | null = null;
  private aiSource: AiDocumentSource | null = null;
  private aiSourceInitialized = false;
  private aiOutput = "";
  private aiOutputSourceHash = "";
  private aiOutputModel = "";
  private aiBusy = false;
  private chatHistory: Array<{ role: "user" | "model"; text: string }> = [];

  constructor(leaf: WorkspaceLeaf, private readonly plugin: GoogleAiHubPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_GOOGLE_AI_HUB;
  }

  getDisplayText(): string {
    return this.service === "home" ? "Google AI Hub" : SERVICE_DETAILS[this.service].title;
  }

  getIcon(): string {
    return this.service === "home" ? "blocks" : SERVICE_DETAILS[this.service].icon;
  }

  getService(): ServiceKey {
    return this.service;
  }

  getState(): GoogleAiHubViewState {
    return { service: this.service };
  }

  async loadSource(title: string, content: string): Promise<SourceLoadResult> {
    if (!this.webview || (this.service !== "gemini" && this.service !== "notebooklm")) {
      return { ok: false, message: "The selected AI view is not ready." };
    }

    const webview = this.webview;
    const ready = this.webviewReady;
    if (!ready) {
      return { ok: false, message: `The ${SERVICE_DETAILS[this.service].title} page is not ready.` };
    }
    const becameReady = await Promise.race([
      ready.then(() => true),
      new Promise<boolean>(resolve => window.setTimeout(() => resolve(false), 30000))
    ]);
    if (!becameReady || this.webview !== webview) {
      return {
        ok: false,
        message: `${SERVICE_DETAILS[this.service].title} did not finish loading. Try the source action again.`
      };
    }

    const script = this.service === "gemini"
      ? buildGeminiLoaderScript(title, content)
      : buildNotebookLmLoaderScript(title, content);
    try {
      const result = await webview.executeJavaScript(script, true) as SourceLoadResult | null;
      return result?.message
        ? result
        : { ok: false, message: `Could not load ${title} into ${SERVICE_DETAILS[this.service].title}.` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `Could not load ${title}: ${message}` };
    }
  }

  async focusNotebookLmControl(label: string): Promise<boolean> {
    if (!this.webview || this.service !== "notebooklm" || label === "source") return label === "source";
    try {
      return await this.webview.executeJavaScript(`(() => {
        const target = ${JSON.stringify(label.toLowerCase())};
        const elements = Array.from(document.querySelectorAll('button, [role="button"], a'));
        const control = elements.find(element => (element.textContent || '').trim().toLowerCase().includes(target));
        if (!control) return false;
        control.scrollIntoView({ block: 'center', behavior: 'smooth' });
        control.focus({ preventScroll: true });
        control.style.outline = '3px solid #8b5cf6';
        control.style.outlineOffset = '3px';
        return true;
      })()`, true) as boolean;
    } catch {
      return false;
    }
  }

  async setState(state: GoogleAiHubViewState, result: ViewStateResult): Promise<void> {
    this.service = isServiceKey(state?.service) ? state.service : "home";
    await super.setState(state, result);
    this.render();
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("google-ai-hub-view");
    this.render();
  }

  async onClose(): Promise<void> {
    this.destroyWebview();
  }

  private render(): void {
    this.destroyWebview();
    this.contentEl.empty();
    this.contentEl.toggleClass("is-home", this.service === "home");

    if (this.service === "home") {
      this.renderHome();
      return;
    }

    this.renderService(this.service);
  }

  private renderHome(): void {
    const header = this.contentEl.createDiv({ cls: "google-ai-hub-home-header" });
    header.createEl("h1", { text: "Google AI Hub" });
    header.createEl("p", { text: "Research, transform, and discuss the document you are working on." });

    const sourceCard = this.contentEl.createDiv({ cls: "google-ai-hub-active-source" });
    const sourceHeading = sourceCard.createDiv({ cls: "google-ai-hub-active-source-heading" });
    sourceHeading.createEl("h2", { text: "Active source" });
    new ButtonComponent(sourceHeading)
      .setButtonText("Choose source")
      .onClick(() => void this.chooseHubSource());
    if (this.aiSource) {
      sourceCard.createEl("h3", { text: this.aiSource.title });
      sourceCard.createEl("p", { text: this.aiSource.description });
      sourceCard.createEl("small", { text: `${this.aiSource.markdown.length.toLocaleString()} characters` });
    } else {
      sourceCard.createEl("p", {
        text: this.aiSourceInitialized
          ? "Choose a Markdown note, folder, Google Doc, or Google Doc tab."
          : "Detecting the active document..."
      });
    }
    const modelRow = sourceCard.createDiv({ cls: "google-ai-hub-model-row" });
    modelRow.createEl("label", { text: "AI model" });
    const modelSelect = modelRow.createEl("select");
    modelSelect.setAttribute("aria-label", "Gemini model for AI Hub");
    for (const model of this.plugin.getGeminiModels()) {
      const option = modelSelect.createEl("option", { text: model.displayName });
      option.value = model.id;
      option.title = `${model.id} - ${model.description}`;
    }
    modelSelect.value = this.plugin.settings.geminiModel;
    modelSelect.addEventListener("change", () => {
      void this.plugin.setGeminiModel(modelSelect.value).then(() => {
        this.aiOutput = "";
        this.aiOutputModel = "";
        this.chatHistory = [];
        this.render();
      });
    });
    const refreshModels = modelRow.createEl("button", { text: "Refresh models", type: "button" });
    refreshModels.addEventListener("click", () => void this.plugin.refreshGeminiModels().then(() => this.render()));

    const research = this.contentEl.createDiv({ cls: "google-ai-hub-research-grid" });
    const direct = research.createDiv({ cls: "google-ai-hub-research-card" });
    direct.createEl("h2", { text: "Document AI" });
    direct.createEl("p", { text: "Generate grounded results without leaving Obsidian." });
    const directActions = direct.createDiv({ cls: "google-ai-hub-actions" });
    new ButtonComponent(directActions)
      .setButtonText("Summary")
      .setCta()
      .setDisabled(!this.aiSource || this.aiBusy)
      .onClick(() => void this.runHubGeneration("summarize"));
    new ButtonComponent(directActions)
      .setButtonText("Briefing report")
      .setDisabled(!this.aiSource || this.aiBusy)
      .onClick(() => void this.runHubBriefing());

    const notebook = research.createDiv({ cls: "google-ai-hub-research-card" });
    notebook.createEl("h2", { text: "NotebookLM Studio" });
    notebook.createEl("p", { text: "Load the source, then focus the Studio workflow you want to use." });
    const notebookActions = notebook.createDiv({ cls: "google-ai-hub-actions" });
    for (const [label, control] of [
      ["Add as source", "source"],
      ["Mind Map", "mind map"],
      ["Audio Overview", "audio overview"]
    ] as const) {
      new ButtonComponent(notebookActions)
        .setButtonText(label)
        .setDisabled(!this.aiSource)
        .onClick(() => this.aiSource && void this.plugin.openNotebookLmStudio(this.aiSource, control));
    }

    const chat = this.contentEl.createDiv({ cls: "google-ai-hub-chat" });
    chat.createEl("h2", { text: "Grounded chat" });
    const chatLog = chat.createDiv({ cls: "google-ai-hub-chat-log" });
    if (!this.chatHistory.length) chatLog.createEl("p", { text: "Ask a question about the selected source." });
    for (const message of this.chatHistory) {
      const item = chatLog.createDiv({ cls: `google-ai-hub-chat-message is-${message.role}` });
      item.createEl("strong", { text: message.role === "user" ? "You" : "Gemini" });
      item.createEl("p", { text: message.text });
    }
    const chatForm = chat.createEl("form", { cls: "google-ai-hub-chat-form" });
    const chatInput = chatForm.createEl("input", { type: "text", placeholder: "Ask about this source..." });
    chatInput.disabled = !this.aiSource || this.aiBusy;
    const askButton = chatForm.createEl("button", { text: "Ask", type: "submit" });
    askButton.disabled = !this.aiSource || this.aiBusy;
    chatForm.addEventListener("submit", event => {
      event.preventDefault();
      const question = chatInput.value.trim();
      if (question) void this.runHubChat(question);
    });

    if (this.aiOutput) {
      const output = this.contentEl.createDiv({ cls: "google-ai-hub-output" });
      output.createEl("h2", { text: "Generated result" });
      if (this.aiOutputModel) output.createEl("small", { text: `Model: ${this.aiOutputModel}` });
      const preview = output.createEl("textarea");
      preview.value = this.aiOutput;
      preview.readOnly = true;
      const outputActions = output.createDiv({ cls: "google-ai-hub-actions" });
      new ButtonComponent(outputActions).setButtonText("Copy").onClick(() => void navigator.clipboard.writeText(this.aiOutput));
      new ButtonComponent(outputActions)
        .setButtonText("Insert")
        .setDisabled(!this.aiSource?.insert)
        .onClick(() => void this.insertHubOutput());
    }

    const grid = this.contentEl.createDiv({ cls: "google-ai-hub-card-grid" });
    for (const service of ["notebooklm", "gemini", "drive"] as const) {
      const details = SERVICE_DETAILS[service];
      const card = grid.createDiv({ cls: "google-ai-hub-card" });
      const title = card.createDiv({ cls: "google-ai-hub-card-title" });
      title.createSpan({ cls: `google-ai-hub-card-icon google-ai-hub-icon-${service}` });
      title.createEl("h2", { text: details.title });
      card.createEl("p", { text: details.description });
      new ButtonComponent(card)
        .setButtonText(`Open ${details.title}`)
        .setCta()
        .onClick(() => void this.plugin.activateService(service));
    }

    const help = this.contentEl.createDiv({ cls: "google-ai-hub-help" });
    help.createEl("h2", { text: "Use your Obsidian notes as AI sources" });
    help.createEl("p", {
      text: "Choose any vault note, folder, or Google Doc. The plugin prepares it as context that Gemini or NotebookLM can select from Drive. You can also right-click any supported source in Files."
    });
    help.createEl("p", {
      text: `Google Docs are indexed as shortcuts under ${this.plugin.settings.googleDocsFolder} in the normal Obsidian folder view.`
    });
    const noteActions = help.createDiv({ cls: "google-ai-hub-actions" });
    new ButtonComponent(noteActions)
      .setButtonText("Choose source for Gemini")
      .onClick(() => this.plugin.openNotePicker("gemini"));
    new ButtonComponent(noteActions)
      .setButtonText("Choose source for NotebookLM")
      .onClick(() => this.plugin.openNotePicker("notebooklm"));
    new ButtonComponent(noteActions)
      .setButtonText(this.plugin.googleConnected ? "Refresh Google Docs folder" : "Connect Google Drive")
      .setCta()
      .onClick(() => void (this.plugin.googleConnected
        ? this.plugin.syncGoogleDocs()
        : this.plugin.connectGoogleDrive()));

    if (!this.aiSourceInitialized) {
      this.aiSourceInitialized = true;
      void this.plugin.getActiveAiSource().then(source => {
        this.aiSource = source;
        if (this.service === "home") this.render();
      });
    }
  }

  private async chooseHubSource(): Promise<void> {
    const source = await this.plugin.chooseAiSource();
    if (!source) return;
    this.aiSource = source;
    this.aiOutput = "";
    this.aiOutputSourceHash = "";
    this.aiOutputModel = "";
    this.chatHistory = [];
    this.render();
  }

  private async runHubGeneration(action: AiWritingAction): Promise<void> {
    if (!this.aiSource || this.aiBusy) return;
    this.aiBusy = true;
    this.render();
    try {
      const result = await this.plugin.generateForSource(action, this.aiSource);
      this.aiOutput = result.markdown;
      this.aiOutputSourceHash = result.sourceHash;
      this.aiOutputModel = result.model;
    } catch (error) {
      new Notice(`AI request failed: ${error instanceof Error ? error.message : String(error)}`, 10000);
    } finally {
      this.aiBusy = false;
      this.render();
    }
  }

  private async runHubBriefing(): Promise<void> {
    if (!this.aiSource || this.aiBusy) return;
    await this.plugin.previewSourceAction("briefing", this.aiSource);
  }

  private async runHubChat(question: string): Promise<void> {
    if (!this.aiSource || this.aiBusy) return;
    const source = this.aiSource;
    this.chatHistory.push({ role: "user", text: question });
    this.aiBusy = true;
    this.render();
    try {
      const result = await this.plugin.generateForSource("chat", source, question, this.chatHistory.slice(0, -1));
      this.chatHistory.push({ role: "model", text: result.markdown });
      this.aiOutput = result.markdown;
      this.aiOutputSourceHash = result.sourceHash;
      this.aiOutputModel = result.model;
    } catch (error) {
      new Notice(`Grounded chat failed: ${error instanceof Error ? error.message : String(error)}`, 10000);
    } finally {
      this.aiBusy = false;
      this.render();
    }
  }

  private async insertHubOutput(): Promise<void> {
    if (!this.aiSource?.insert || !this.aiOutput) return;
    if (this.aiSource.readRevision) {
      const current = await this.aiSource.readRevision();
      if (!isSourceCurrent(this.aiOutputSourceHash, current)) {
        new Notice("The source changed while AI was working. Copy or regenerate the result before inserting it.", 9000);
        return;
      }
    }
    await this.aiSource.insert(this.aiOutput);
    new Notice("AI result inserted below the source.", 5000);
  }

  private renderService(service: Exclude<ServiceKey, "home">): void {
    const details = SERVICE_DETAILS[service];
    const toolbar = this.contentEl.createDiv({ cls: "google-ai-hub-toolbar" });

    new ButtonComponent(toolbar)
      .setIcon("layout-dashboard")
      .setTooltip("Google AI Hub home")
      .onClick(() => void this.plugin.activateService("home"));

    const backButton = new ButtonComponent(toolbar)
      .setIcon("arrow-left")
      .setTooltip("Back")
      .onClick(() => this.webview?.canGoBack() && this.webview.goBack());

    const forwardButton = new ButtonComponent(toolbar)
      .setIcon("arrow-right")
      .setTooltip("Forward")
      .onClick(() => this.webview?.canGoForward() && this.webview.goForward());

    new ButtonComponent(toolbar)
      .setIcon("refresh-cw")
      .setTooltip("Reload")
      .onClick(() => this.webview?.reload());

    const status = toolbar.createSpan({ cls: "google-ai-hub-status", text: details.title });

    new ButtonComponent(toolbar)
      .setIcon("external-link")
      .setTooltip("Open current page in your browser")
      .onClick(() => {
        const url = this.webview?.getURL() || this.getServiceUrl(service);
        window.open(url, "_blank");
      });

    const host = this.contentEl.createDiv({ cls: "google-ai-hub-webview-host" });
    const webview = this.contentEl.ownerDocument.createElement("webview") as WebviewElement;
    let resolveReady: (() => void) | null = null;
    this.webviewReady = new Promise<void>(resolve => {
      resolveReady = resolve;
    });
    webview.className = "google-ai-hub-webview";
    webview.setAttribute("src", this.getServiceUrl(service));
    webview.setAttribute("webpreferences", "nativeWindowOpen=no");
    webview.setAttribute("allowpopups", "true");

    const updateNavigation = (): void => {
      backButton.setDisabled(!webview.canGoBack());
      forwardButton.setDisabled(!webview.canGoForward());
    };

    webview.addEventListener("did-start-loading", (() => {
      status.setText(`Loading ${details.title}…`);
    }) as EventListener);
    webview.addEventListener("dom-ready", (() => {
      resolveReady?.();
      resolveReady = null;
    }) as EventListener, { once: true });
    webview.addEventListener("did-stop-loading", (() => {
      status.setText(details.title);
      updateNavigation();
    }) as EventListener);
    webview.addEventListener("did-navigate", updateNavigation as EventListener);
    webview.addEventListener("did-navigate-in-page", updateNavigation as EventListener);
    webview.addEventListener("new-window", ((event: Event) => {
      const targetUrl = (event as Event & { url?: string }).url;
      event.preventDefault();
      if (targetUrl) webview.setAttribute("src", targetUrl);
    }) as EventListener);
    webview.addEventListener("did-fail-load", ((event: Event) => {
      const failure = event as Event & { errorCode?: number; errorDescription?: string };
      if (failure.errorCode === -3) return;
      status.setText(failure.errorDescription || `Could not load ${details.title}`);
    }) as EventListener);

    host.appendChild(webview);
    this.webview = webview;
  }

  private getServiceUrl(service: Exclude<ServiceKey, "home">): string {
    const details = SERVICE_DETAILS[service];
    return normalizeUrl(
      this.plugin.settings[details.settingKey],
      DEFAULT_SETTINGS[details.settingKey]
    );
  }

  private destroyWebview(): void {
    if (!this.webview) return;
    try {
      this.webview.stop();
    } catch {
      // The webview can already be detached during an Obsidian workspace reload.
    }
    this.webview.remove();
    this.webview = null;
    this.webviewReady = null;
  }
}

class GoogleAiHubSettingTab extends PluginSettingTab {
  constructor(app: GoogleAiHubPlugin["app"], private readonly plugin: GoogleAiHubPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Google AI Hub").setHeading();
    containerEl.createEl("p", {
      text: "These pages open inside desktop Obsidian using your Google sign-in. Change a URL only if you use a Workspace or NotebookLM Enterprise address."
    });

    this.addUrlSetting("NotebookLM URL", "Personal or Enterprise NotebookLM home page.", "notebookLmUrl");
    this.addUrlSetting("Gemini URL", "Gemini web application address.", "geminiUrl");
    this.addUrlSetting("Google Drive URL", "Drive location to open by default.", "driveUrl");

    new Setting(containerEl).setName("Gemini document AI").setHeading();
    containerEl.createEl("p", {
      text: "Summarize, shorten, lengthen, elaborate, chat with, and report on supported documents. The API key is kept in Obsidian Secret Storage and is never written to plugin data or logs."
    });
    const hasGeminiKey = Boolean(this.app.secretStorage.getSecret(GEMINI_SECRET_ID));
    new Setting(containerEl)
      .setName("Gemini API key")
      .setDesc(hasGeminiKey
        ? "A key is stored securely. Enter a replacement or use Clear to remove it."
        : "Create a key in Google AI Studio. GEMINI_API_KEY is also accepted during development.")
      .addText(text => {
        text.inputEl.type = "password";
        text.setPlaceholder(hasGeminiKey ? "Stored securely" : "Paste API key")
          .onChange(value => {
            const secret = value.trim();
            if (secret) this.app.secretStorage.setSecret(GEMINI_SECRET_ID, secret);
          });
      })
      .addButton(button => button
        .setButtonText("Clear")
        .setDisabled(!hasGeminiKey)
        .onClick(() => {
          this.app.secretStorage.setSecret(GEMINI_SECRET_ID, "");
          this.display();
        }));
    const currentModel = this.plugin.getGeminiModels()
      .find(model => model.id === this.plugin.settings.geminiModel);
    new Setting(containerEl)
      .setName("Default Gemini model")
      .setDesc(currentModel?.description || "Choose which Gemini model document AI uses by default.")
      .addDropdown(dropdown => {
        for (const model of this.plugin.getGeminiModels()) {
          dropdown.addOption(model.id, `${model.displayName} - ${model.id}`);
        }
        dropdown.setValue(this.plugin.settings.geminiModel)
          .onChange(async value => {
            await this.plugin.setGeminiModel(value);
            this.display();
          });
      })
      .addButton(button => button
        .setButtonText("Refresh available models")
        .onClick(async () => {
          await this.plugin.refreshGeminiModels();
          this.display();
        }));
    let customModel = "";
    new Setting(containerEl)
      .setName("Custom Gemini model ID")
      .setDesc("Use an account-specific, latest, preview, or experimental model ID returned by Google, such as gemini-flash-latest.")
      .addText(text => text
        .setPlaceholder("gemini-model-name")
        .onChange(value => {
          customModel = value.trim().replace(/^models\//, "");
        }))
      .addButton(button => button
        .setButtonText("Use custom model")
        .onClick(async () => {
          if (!customModel) {
            new Notice("Enter a Gemini model ID first.", 5000);
            return;
          }
          await this.plugin.setGeminiModel(customModel);
          this.display();
        }));

    new Setting(containerEl).setName("Google Drive library").setHeading();
    containerEl.createEl("p", {
      text: "Connect once to index and read Drive, edit native Google Docs, and publish selected Obsidian notes. The plugin requests Google Docs edit access, read-only Drive access, and per-file Drive access for documents it creates. The OAuth refresh token is stored outside the synced vault."
    });
    new Setting(containerEl)
      .setName("Connection")
      .setDesc(this.plugin.googleConnected
        ? `Connected. Token stored at ${this.plugin.driveBridge.getTokenPath()}`
        : "Not connected. Google will open in your system browser for consent.")
      .addButton(button => button
        .setButtonText(this.plugin.googleConnected ? "Reconnect" : "Connect Google Drive")
        .setCta()
        .onClick(async () => {
          await this.plugin.connectGoogleDrive();
          this.display();
        }))
      .addButton(button => button
        .setButtonText("Refresh shortcuts")
        .setDisabled(!this.plugin.googleConnected)
        .onClick(() => void this.plugin.syncGoogleDocs()));
    new Setting(containerEl)
      .setName("OAuth credentials file")
      .setDesc("Path to the desktop OAuth client JSON downloaded from Google Cloud.")
      .addText(text => text
        .setPlaceholder(DEFAULT_SETTINGS.googleCredentialsPath)
        .setValue(this.plugin.settings.googleCredentialsPath)
        .onChange(async value => {
          this.plugin.settings.googleCredentialsPath = value.trim();
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName("Google Docs shortcut folder")
      .setDesc("Generated .gdoc shortcuts appear here in Obsidian's Files view.")
      .addText(text => text
        .setPlaceholder(DEFAULT_SETTINGS.googleDocsFolder)
        .setValue(this.plugin.settings.googleDocsFolder)
        .onChange(async value => {
          this.plugin.settings.googleDocsFolder = value.trim() || DEFAULT_SETTINGS.googleDocsFolder;
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName("Refresh at startup")
      .setDesc("Update the generated Google Docs folder whenever this vault opens.")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoSyncGoogleDocs)
        .onChange(async value => {
          this.plugin.settings.autoSyncGoogleDocs = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl).setName("Privacy and credentials").setHeading();
    containerEl.createEl("p", {
      text: "The plugin never stores your Google password. The Gemini key is kept in Obsidian Secret Storage, and the Drive refresh token is kept in your local AppData folder rather than the synced vault. Document text is sent to Gemini only when you choose an AI action."
    });
  }

  private addUrlSetting(
    name: string,
    description: string,
    key: UrlSettingKey
  ): void {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(description)
      .addText(text => text
        .setPlaceholder(DEFAULT_SETTINGS[key])
        .setValue(this.plugin.settings[key])
        .onChange(async value => {
          this.plugin.settings[key] = normalizeUrl(value, DEFAULT_SETTINGS[key]);
          await this.plugin.saveSettings();
        }));
  }
}

export default class GoogleAiHubPlugin extends Plugin {
  settings: GoogleAiHubSettings = DEFAULT_SETTINGS;
  driveBridge!: GoogleDriveBridge;
  geminiAi!: GeminiAiClient;
  readonly tabSync = new GoogleDocTabSyncRegistry();
  googleConnected = false;
  private canvasGoogleDocObserver: MutationObserver | null = null;
  private readonly canvasGoogleDocEmbeds = new Map<CanvasGoogleDocWebview, AbortController>();
  private readonly canvasGoogleDocConnectorActions = new Map<CanvasRuntimeNode, CanvasGoogleDocConnectorAction>();

  async onload(): Promise<void> {
    await this.loadSettings();
    this.driveBridge = new GoogleDriveBridge(this.app, () => this.settings.googleCredentialsPath);
    this.geminiAi = new GeminiAiClient(
      {
        post: async (url, apiKey, body) => {
          const response = await requestUrl({
            url,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": apiKey
            },
            body: JSON.stringify(body)
          });
          return response.json;
        },
        get: async (url, apiKey) => {
          const response = await requestUrl({
            url,
            method: "GET",
            headers: { "x-goog-api-key": apiKey }
          });
          return response.json;
        }
      },
      () => resolveGeminiKey(
        this.app.secretStorage.getSecret(GEMINI_SECRET_ID),
        typeof process !== "undefined" ? process.env.GEMINI_API_KEY : ""
      ),
      () => this.settings.geminiModel
    );
    this.googleConnected = await this.driveBridge.hasStoredToken();

    this.registerView(
      VIEW_TYPE_GOOGLE_AI_HUB,
      leaf => new GoogleAiHubView(leaf, this)
    );

    this.addRibbonIcon("blocks", "Open Google AI Hub", () => {
      void this.activateService("home");
    });

    this.addCommand({
      id: "open-hub",
      name: "Open Google AI Hub",
      callback: () => void this.activateService("home")
    });
    this.addCommand({
      id: "open-notebooklm",
      name: "Open NotebookLM",
      callback: () => void this.activateService("notebooklm")
    });
    this.addCommand({
      id: "open-gemini",
      name: "Open Gemini",
      callback: () => void this.activateService("gemini")
    });
    this.addCommand({
      id: "open-google-drive",
      name: "Open Google Drive and Docs",
      callback: () => void this.activateService("drive")
    });
    this.addCommand({
      id: "copy-active-note-for-gemini",
      name: "Use active note in Gemini",
      checkCallback: checking => this.copyActiveNoteForService("gemini", checking)
    });
    this.addCommand({
      id: "copy-active-note-for-notebooklm",
      name: "Use active note in NotebookLM",
      checkCallback: checking => this.copyActiveNoteForService("notebooklm", checking)
    });
    this.addCommand({
      id: "choose-note-for-gemini",
      name: "Choose a vault source for Gemini",
      callback: () => this.openNotePicker("gemini")
    });
    this.addCommand({
      id: "choose-note-for-notebooklm",
      name: "Choose a vault source for NotebookLM",
      callback: () => this.openNotePicker("notebooklm")
    });
    this.addCommand({
      id: "connect-google-drive",
      name: "Connect Google Drive",
      callback: () => void this.connectGoogleDrive()
    });
    this.addCommand({
      id: "refresh-google-doc-shortcuts",
      name: "Refresh Google Docs folder",
      callback: () => void this.syncGoogleDocs()
    });
    this.addCommand({
      id: "publish-active-note-to-google-docs",
      name: "Publish active note to Google Docs",
      checkCallback: checking => this.publishActiveNote(checking)
    });
    this.addCommand({
      id: "choose-gemini-model",
      name: "AI: Choose Gemini model",
      callback: () => void this.chooseGeminiModel()
    });
    for (const action of ["summarize", "shorten", "lengthen", "elaborate"] as const) {
      this.addCommand({
        id: `ai-${action}-selection-or-note`,
        name: `AI: ${this.aiActionLabel(action)} selection or note`,
        editorCallback: (editor, view) => void this.runMarkdownAiAction(action, editor, view)
      });
    }

    this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor, view) => {
      menu.addSeparator();
      menu.addItem(item => item
        .setTitle(`AI model: ${this.currentGeminiModelLabel()}`)
        .setIcon("settings-2")
        .onClick(() => void this.chooseGeminiModel()));
      menu.addSeparator();
      for (const action of ["summarize", "shorten", "lengthen", "elaborate"] as const) {
        menu.addItem(item => item
          .setTitle(`AI: ${this.aiActionLabel(action)}`)
          .setIcon("sparkles")
          .onClick(() => void this.runMarkdownAiAction(action, editor, view)));
      }
    }));

    this.registerEvent(this.app.workspace.on("file-menu", (menu, item) => {
      if (!this.isSupportedAiSource(item)) return;
      const sourceType = item instanceof TFolder
        ? "folder"
        : item.extension === "gdoc" ? "Google Doc" : "note";

      menu.addItem(menuItem => menuItem
        .setTitle(`Use ${sourceType} in Gemini`)
        .setIcon("sparkles")
        .onClick(() => void this.prepareItemForService(item, "gemini")));
      menu.addItem(menuItem => menuItem
        .setTitle(`Use ${sourceType} in NotebookLM`)
        .setIcon("notebook-tabs")
        .onClick(() => void this.prepareItemForService(item, "notebooklm")));
      if (item instanceof TFile && item.extension === "gdoc") {
        menu.addSeparator();
        menu.addItem(menuItem => menuItem
          .setTitle(`AI model: ${this.currentGeminiModelLabel()}`)
          .setIcon("settings-2")
          .onClick(() => void this.chooseGeminiModel()));
        menu.addSeparator();
        for (const action of ["summarize", "shorten", "lengthen", "elaborate"] as const) {
          menu.addItem(menuItem => menuItem
            .setTitle(`AI: ${this.aiActionLabel(action)} Google Doc tab`)
            .setIcon("sparkles")
            .onClick(() => void this.runStandaloneGoogleDocAiAction(action, item)));
        }
      }
    }));

    this.addSettingTab(new GoogleAiHubSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      this.enableCanvasGoogleDocPreviews();
      if (this.googleConnected && this.settings.autoSyncGoogleDocs) {
        void this.syncGoogleDocs(false);
      }
    });
  }

  onunload(): void {
    this.disableCanvasGoogleDocPreviews();
    this.tabSync.clear();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_GOOGLE_AI_HUB);
  }

  private enableCanvasGoogleDocPreviews(): void {
    this.disableCanvasGoogleDocPreviews();

    this.canvasGoogleDocObserver = new MutationObserver(() => {
      this.refreshCanvasGoogleDocPreviews();
      this.refreshCanvasGoogleDocConnectorMenus();
    });
    this.canvasGoogleDocObserver.observe(document.body, { childList: true, subtree: true });
    this.refreshCanvasGoogleDocPreviews();
    this.refreshCanvasGoogleDocConnectorMenus();
  }

  private disableCanvasGoogleDocPreviews(): void {
    this.canvasGoogleDocObserver?.disconnect();
    this.canvasGoogleDocObserver = null;

    for (const [webview, controller] of this.canvasGoogleDocEmbeds) {
      controller.abort();
      const embed = webview.closest<HTMLElement>(".gdocs-embed");
      embed?.classList.remove("google-ai-hub-gdoc-canvas-preview");
      embed?.closest<HTMLElement>(".canvas-node")?.classList.remove("google-ai-hub-gdoc-canvas-node");
      embed?.querySelectorAll(
        ".google-ai-hub-gdoc-canvas-toolbar, .google-ai-hub-gdoc-canvas-tabs, .google-ai-hub-gdoc-formatting, .google-ai-hub-gdoc-canvas-content"
      ).forEach(element => element.remove());
    }
    this.canvasGoogleDocEmbeds.clear();
    this.canvasGoogleDocConnectorActions.clear();
    document.querySelectorAll(".google-ai-hub-gdoc-connector-add").forEach(element => element.remove());
  }

  private refreshCanvasGoogleDocPreviews(): void {
    for (const [webview, controller] of this.canvasGoogleDocEmbeds) {
      if (webview.isConnected && webview.closest(".canvas-node")) continue;
      controller.abort();
      this.canvasGoogleDocEmbeds.delete(webview);
    }

    const webviews = Array.from(document.querySelectorAll<CanvasGoogleDocWebview>(
      ".canvas-node .gdocs-embed .gdocs-webview"
    ));
    for (const webview of webviews) {
      this.setupCanvasGoogleDocPreview(webview);
    }
  }

  private refreshCanvasGoogleDocConnectorMenus(): void {
    // Canvas' connector popover uses plain divs in current Obsidian builds,
    // rather than the button/menu-item elements used by standard menus.
    const itemSelector = "button, [role='button'], .menu-item, div";
    const menuItems = Array.from(document.querySelectorAll<HTMLElement>(itemSelector));
    const exactText = (element: HTMLElement, value: string): boolean =>
      (element.textContent || "").replace(/\s+/g, " ").trim() === value;

    for (const addCardButton of menuItems.filter(element => exactText(element, "Add card"))) {
      let menu: HTMLElement | null = addCardButton.parentElement;
      let addNoteButton: HTMLElement | null = null;
      for (let depth = 0; menu && menu !== document.body && depth < 6; depth += 1) {
        addNoteButton = Array.from(menu.querySelectorAll<HTMLElement>(itemSelector))
          .find(element => exactText(element, "Add note from vault")) || null;
        if (addNoteButton) break;
        menu = menu.parentElement;
      }
      if (!menu || !addNoteButton || menu.querySelector(".google-ai-hub-gdoc-connector-add")) continue;

      const action = Array.from(this.canvasGoogleDocConnectorActions.values()).find(candidate => {
        try {
          const selected = candidate.canvas.getSelectionData().nodes.some(node => node.id === candidate.node.id);
          if (selected) return true;
          const connectorSources = candidate.canvas.edgeFrom?.data?.keys();
          if (!connectorSources) return false;
          return Array.from(connectorSources).some(source =>
            (typeof source === "string" ? source : source.id) === candidate.node.id
          );
        } catch {
          return candidate.node.nodeEl?.classList.contains("is-selected") || false;
        }
      });
      if (!action) continue;

      const addTabButton = addCardButton.cloneNode(true) as HTMLElement;
      addTabButton.classList.add("google-ai-hub-gdoc-connector-add");
      addTabButton.removeAttribute("disabled");
      addTabButton.setAttribute("aria-label", "Add Google Doc tab");
      addTabButton.setAttribute("title", "Create a Google Doc tab and connected Canvas card");
      addTabButton.textContent = "Add Google Doc tab";
      addTabButton.addEventListener("pointerdown", event => {
        event.preventDefault();
        event.stopPropagation();
      });
      addTabButton.addEventListener("click", event => {
        event.preventDefault();
        event.stopImmediatePropagation();
        void action.createTabCard(addCardButton);
      });
      addNoteButton.insertAdjacentElement("afterend", addTabButton);
    }
  }

  private findCanvasRuntimeContext(element: HTMLElement): CanvasRuntimeContext | null {
    const canvasNodeEl = element.closest<HTMLElement>(".canvas-node");
    if (!canvasNodeEl) return null;

    for (const leaf of this.app.workspace.getLeavesOfType("canvas")) {
      const view = leaf.view as unknown as CanvasRuntimeView;
      const canvas = view.canvas;
      if (!canvas?.nodes) continue;
      for (const node of canvas.nodes.values()) {
        if (node.nodeEl === canvasNodeEl || node.nodeEl?.contains(element)) {
          return { canvas, node };
        }
      }
    }
    return null;
  }

  private setupCanvasGoogleDocPreview(webview: CanvasGoogleDocWebview): void {
    if (this.canvasGoogleDocEmbeds.has(webview)) return;

    const editUrl = webview.getAttribute("src");
    const documentId = editUrl ? getGoogleDocId(editUrl) : null;
    const embed = webview.closest<HTMLElement>(".gdocs-embed");
    if (!editUrl || !documentId || !embed) return;

    const controller = new AbortController();
    this.canvasGoogleDocEmbeds.set(webview, controller);
    embed.querySelectorAll(
      ".google-ai-hub-gdoc-canvas-toolbar, .google-ai-hub-gdoc-canvas-tabs, .google-ai-hub-gdoc-formatting, .google-ai-hub-gdoc-canvas-content"
    ).forEach(element => element.remove());
    embed.classList.add("google-ai-hub-gdoc-canvas-preview");
    embed.closest<HTMLElement>(".canvas-node")?.classList.add("google-ai-hub-gdoc-canvas-node");

    const toolbar = embed.ownerDocument.createElement("div");
    toolbar.className = "google-ai-hub-gdoc-canvas-toolbar";
    toolbar.addEventListener("click", event => event.stopPropagation(), { signal: controller.signal });
    toolbar.addEventListener("pointerdown", event => event.stopPropagation(), { signal: controller.signal });

    const label = embed.ownerDocument.createElement("span");
    label.className = "google-ai-hub-gdoc-canvas-title";
    label.textContent = "Google Doc · edit below";
    toolbar.appendChild(label);

    const status = embed.ownerDocument.createElement("span");
    status.className = "google-ai-hub-gdoc-canvas-status";
    status.textContent = "Saved";
    toolbar.appendChild(status);

    const linkButton = embed.ownerDocument.createElement("button");
    linkButton.type = "button";
    linkButton.textContent = "Link";
    linkButton.title = "Select text and add a link (Ctrl+K)";
    toolbar.appendChild(linkButton);

    const saveButton = embed.ownerDocument.createElement("button");
    saveButton.type = "button";
    saveButton.textContent = "Save";
    saveButton.title = "Save now (Ctrl+S)";
    saveButton.disabled = true;
    toolbar.appendChild(saveButton);

    const refreshButton = embed.ownerDocument.createElement("button");
    refreshButton.type = "button";
    refreshButton.textContent = "Refresh";
    toolbar.appendChild(refreshButton);

    embed.prepend(toolbar);
    const tabsBar = embed.ownerDocument.createElement("div");
    tabsBar.className = "google-ai-hub-gdoc-canvas-tabs";
    tabsBar.setAttribute("role", "tablist");
    tabsBar.addEventListener("click", event => event.stopPropagation(), { signal: controller.signal });
    tabsBar.addEventListener("pointerdown", event => event.stopPropagation(), { signal: controller.signal });
    toolbar.insertAdjacentElement("afterend", tabsBar);

    const formattingBar = embed.ownerDocument.createElement("div");
    formattingBar.className = "google-ai-hub-gdoc-formatting";
    formattingBar.setAttribute("aria-label", "Obsidian formatting");
    formattingBar.addEventListener("click", event => event.stopPropagation(), { signal: controller.signal });
    formattingBar.addEventListener("pointerdown", event => event.stopPropagation(), { signal: controller.signal });
    tabsBar.insertAdjacentElement("afterend", formattingBar);

    const blockStyleSelect = embed.ownerDocument.createElement("select");
    blockStyleSelect.title = "Paragraph style";
    blockStyleSelect.setAttribute("aria-label", "Paragraph style");
    for (const [value, text] of [
      ["p", "Paragraph"],
      ["h1", "Heading 1"],
      ["h2", "Heading 2"],
      ["h3", "Heading 3"],
      ["blockquote", "Quote"],
      ["pre", "Code block"]
    ]) {
      const option = embed.ownerDocument.createElement("option");
      option.value = value;
      option.textContent = text;
      blockStyleSelect.appendChild(option);
    }
    formattingBar.appendChild(blockStyleSelect);

    const createFormattingButton = (text: string, title: string): HTMLButtonElement => {
      const button = embed.ownerDocument.createElement("button");
      button.type = "button";
      button.textContent = text;
      button.title = title;
      button.setAttribute("aria-label", title);
      formattingBar.appendChild(button);
      return button;
    };
    const boldButton = createFormattingButton("B", "Bold (Ctrl+B)");
    boldButton.classList.add("is-bold");
    const italicButton = createFormattingButton("I", "Italic (Ctrl+I)");
    italicButton.classList.add("is-italic");
    const strikeButton = createFormattingButton("S", "Strikethrough");
    strikeButton.classList.add("is-strike");
    const bulletButton = createFormattingButton("•", "Bulleted list");
    const numberedButton = createFormattingButton("1.", "Numbered list");
    const aiButton = createFormattingButton("AI", "AI writing tools");
    aiButton.classList.add("google-ai-hub-gdoc-ai-button");

    const contentShell = embed.ownerDocument.createElement("div");
    contentShell.className = "google-ai-hub-gdoc-canvas-editor-shell";
    embed.appendChild(contentShell);
    const content = embed.ownerDocument.createElement("div");
    content.className = "google-ai-hub-gdoc-canvas-content markdown-rendered";
    content.contentEditable = "false";
    content.spellcheck = true;
    content.setAttribute("role", "textbox");
    content.setAttribute("aria-label", "Editable Google Doc content");
    content.setAttribute("aria-multiline", "true");
    contentShell.appendChild(content);
    const emptyGuide = embed.ownerDocument.createElement("div");
    emptyGuide.className = "google-ai-hub-gdoc-empty-guide";
    emptyGuide.textContent = "Start typing. Use Paragraph for headings, quotes, and code; B/I/S for emphasis; •/1. for lists; Link or Ctrl+K for links; AI for Summarize, Lengthen, Shorten, and Elaborate.";
    contentShell.appendChild(emptyGuide);

    const turndown = new TurndownService({
      headingStyle: "atx",
      bulletListMarker: "-",
      codeBlockStyle: "fenced",
      emDelimiter: "_",
      strongDelimiter: "**"
    });
    let renderComponent: Component | null = null;
    let lastSavedMarkdown = "";
    let dirty = false;
    let saveInFlight = false;
    let saveQueued = false;
    let saveTimer: number | null = null;
    let savedSelection: Range | null = null;
    let tabs: GoogleDocTabInfo[] = [];
    let activeTabId = "";
    let nativeTabsAvailable = false;
    let tabsWarning = "";
    const canvasContext = this.findCanvasRuntimeContext(embed);
    const pinnedCanvasTabId = parseGoogleDocTabSubpath(canvasContext?.node.getData().subpath);
    let createTabCardFromDrag: (event: DragEvent, tab: GoogleDocTabInfo) => Promise<void> = async () => {};
    let createTabCardFromConnector: (addCardButton: HTMLElement) => Promise<void> = async () => {};
    const draftStorageKey = (): string =>
      `google-ai-hub:gdoc-draft:${documentId}:${activeTabId || "document"}`;

    const readDraft = (): StoredGoogleDocDraft | null => {
      try {
        const value = localStorage.getItem(draftStorageKey());
        if (!value) return null;
        const parsed = JSON.parse(value) as Partial<StoredGoogleDocDraft>;
        return typeof parsed.markdown === "string"
          ? { markdown: parsed.markdown, updatedAt: Number(parsed.updatedAt) || Date.now() }
          : null;
      } catch {
        return null;
      }
    };

    const storeDraft = (markdown: string): void => {
      try {
        localStorage.setItem(draftStorageKey(), JSON.stringify({
          markdown,
          updatedAt: Date.now()
        } satisfies StoredGoogleDocDraft));
      } catch {
        // Saving to Google Drive remains available if local draft storage is unavailable.
      }
    };

    const clearDraft = (): void => {
      try {
        localStorage.removeItem(draftStorageKey());
      } catch {
        // Ignore unavailable local draft storage.
      }
    };

    const editableMarkdown = (): string => {
      const markdown = turndown.turndown(content.innerHTML).trimEnd();
      return markdown ? `${markdown}\n` : "\n";
    };

    const updateEmptyGuide = (): void => {
      const empty = content.contentEditable === "true" && !editableMarkdown().trim();
      contentShell.classList.toggle("is-empty", empty);
      emptyGuide.setAttribute("aria-hidden", String(!empty));
    };

    const setSaveState = (text: string, state: "saved" | "dirty" | "saving" | "error"): void => {
      status.textContent = text;
      status.dataset.state = state;
      saveButton.disabled = state === "saved" || state === "saving";
      content.setAttribute("aria-busy", String(state === "saving"));
    };

    const scheduleSave = (): void => {
      if (saveTimer !== null) window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        saveTimer = null;
        void saveDocument();
      }, 1800);
    };

    const markDirty = (): void => {
      updateEmptyGuide();
      const markdown = editableMarkdown();
      dirty = markdown !== lastSavedMarkdown;
      if (!dirty) {
        clearDraft();
        setSaveState(nativeTabsAvailable ? "Saved" : "Setup needed", "saved");
        return;
      }
      storeDraft(markdown);
      if (!nativeTabsAvailable || !activeTabId) {
        setSaveState("Local draft", "dirty");
        return;
      }
      setSaveState("Unsaved", "dirty");
      scheduleSave();
    };

    const saveDocument = async (showSetupNotice = false): Promise<void> => {
      if (controller.signal.aborted || !dirty) return;
      if (saveInFlight) {
        saveQueued = true;
        return;
      }

      if (saveTimer !== null) {
        window.clearTimeout(saveTimer);
        saveTimer = null;
      }
      const markdown = editableMarkdown();
      if (markdown === lastSavedMarkdown) {
        dirty = false;
        setSaveState(nativeTabsAvailable ? "Saved" : "Setup needed", "saved");
        return;
      }

      if (!nativeTabsAvailable || !activeTabId) {
        dirty = true;
        storeDraft(markdown);
        setSaveState("Local draft", "dirty");
        if (showSetupNotice) {
          new Notice(
            tabsWarning || "Connect Google Docs editing to publish this local draft.",
            10000
          );
        }
        return;
      }

      saveInFlight = true;
      setSaveState("Saving…", "saving");
      let saveFailed = false;
      try {
        await this.driveBridge.updateGoogleDocTabContent(
          documentId,
          activeTabId,
          buildGoogleDocTabContent(content)
        );
        lastSavedMarkdown = markdown;
        const activeTab = tabs.find(tab => tab.id === activeTabId);
        if (activeTab) activeTab.markdown = markdown;
        dirty = editableMarkdown() !== lastSavedMarkdown;
        if (dirty) storeDraft(editableMarkdown());
        else clearDraft();
        setSaveState(dirty ? "Unsaved" : "Saved", dirty ? "dirty" : "saved");
      } catch (error) {
        saveFailed = true;
        dirty = true;
        storeDraft(markdown);
        setSaveState("Save failed", "error");
        new Notice(`Could not save the Google Doc: ${this.errorMessage(error)}`, 9000);
      } finally {
        saveInFlight = false;
        const shouldSaveAgain = saveQueued || dirty;
        saveQueued = false;
        if (!saveFailed && shouldSaveAgain && nativeTabsAvailable && !controller.signal.aborted) {
          scheduleSave();
        }
      }
    };

    const renderActiveTab = async (): Promise<void> => {
      const activeTab = tabs.find(tab => tab.id === activeTabId);
      if (!activeTab) throw new Error("The selected Google Doc tab is no longer available.");

      renderComponent?.unload();
      renderComponent = new Component();
      this.addChild(renderComponent);
      content.contentEditable = "false";
      content.replaceChildren();
      content.createDiv({
        cls: "google-ai-hub-gdoc-canvas-loading",
        text: `Loading ${activeTab.title}…`
      });

      content.replaceChildren();
      const sourcePath = this.settings.googleDocShortcuts[documentId] || "";
      await MarkdownRenderer.render(this.app, activeTab.markdown, content, sourcePath, renderComponent);
      content.contentEditable = "true";
      content.setAttribute("aria-label", `Editable Google Doc tab: ${activeTab.title}`);
      label.textContent = `Google Doc · ${activeTab.title}`;
      lastSavedMarkdown = editableMarkdown();
      savedSelection = null;

      const draft = readDraft();
      if (draft && draft.markdown !== lastSavedMarkdown) {
        content.replaceChildren();
        await MarkdownRenderer.render(this.app, draft.markdown, content, sourcePath, renderComponent);
        dirty = editableMarkdown() !== lastSavedMarkdown;
        if (dirty) {
          setSaveState(nativeTabsAvailable ? "Unsaved draft" : "Local draft", "dirty");
          new Notice(`Restored unsaved edits for ${activeTab.title}.`, 7000);
        } else {
          clearDraft();
          setSaveState(nativeTabsAvailable ? "Saved" : "Setup needed", "saved");
        }
      } else {
        clearDraft();
        dirty = false;
        setSaveState(nativeTabsAvailable ? "Saved" : "Setup needed", "saved");
      }
      updateEmptyGuide();
    };

    const descendantIds = (tabId: string): Set<string> => {
      const result = new Set<string>();
      const collect = (parentId: string): void => {
        for (const child of tabs.filter(tab => tab.parentTabId === parentId)) {
          result.add(child.id);
          collect(child.id);
        }
      };
      collect(tabId);
      return result;
    };

    const renderTabsBar = (): void => {
      tabsBar.replaceChildren();
      for (const tab of tabs) {
        const button = embed.ownerDocument.createElement("button");
        button.type = "button";
        button.className = "google-ai-hub-gdoc-tab";
        button.classList.toggle("is-active", tab.id === activeTabId);
        button.setAttribute("role", "tab");
        button.setAttribute("aria-selected", String(tab.id === activeTabId));
        button.style.setProperty("--google-ai-hub-tab-depth", String(tab.nestingLevel));
        button.textContent = `${tab.iconEmoji || (tab.nestingLevel ? "↳" : "▤")} ${tab.title}`;
        button.title = nativeTabsAvailable
          ? `${tab.title} — drag onto the Canvas to create a new tab card; double-click to rename; right-click for actions`
          : tab.title;
        button.draggable = nativeTabsAvailable;
        let dragOrigin: { x: number; y: number } | null = null;
        button.addEventListener("click", () => void switchTab(tab.id), { signal: controller.signal });
        button.addEventListener("dblclick", event => {
          event.preventDefault();
          if (nativeTabsAvailable) void editTab(tab);
        }, { signal: controller.signal });
        button.addEventListener("contextmenu", event => {
          event.preventDefault();
          if (nativeTabsAvailable) showTabMenu(event, tab);
        }, { signal: controller.signal });
        button.addEventListener("dragstart", event => {
          event.stopPropagation();
          dragOrigin = { x: event.clientX, y: event.clientY };
          button.classList.add("is-dragging");
          if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = "copy";
            event.dataTransfer.setData("application/x-google-ai-hub-tab", tab.id);
          }
        }, { signal: controller.signal });
        button.addEventListener("dragend", event => {
          event.stopPropagation();
          button.classList.remove("is-dragging");
          const distance = dragOrigin
            ? Math.hypot(event.clientX - dragOrigin.x, event.clientY - dragOrigin.y)
            : 0;
          dragOrigin = null;
          if (distance >= 36) void createTabCardFromDrag(event, tab);
        }, { signal: controller.signal });
        tabsBar.appendChild(button);
      }

      const addButton = embed.ownerDocument.createElement("button");
      addButton.type = "button";
      addButton.className = "google-ai-hub-gdoc-tab-add";
      addButton.textContent = "+";
      addButton.title = nativeTabsAvailable ? "Add a Google Doc tab" : tabsWarning;
      addButton.disabled = !nativeTabsAvailable;
      addButton.addEventListener("click", () => void addTab(""), { signal: controller.signal });
      tabsBar.appendChild(addButton);

      if (tabsWarning) {
        const warning = embed.ownerDocument.createElement("span");
        warning.className = "google-ai-hub-gdoc-tabs-warning";
        warning.textContent = "Tabs setup needed";
        warning.title = tabsWarning;
        tabsBar.appendChild(warning);
      }
    };

    const refreshTabsOnly = async (change: GoogleDocTabChange): Promise<void> => {
      if (controller.signal.aborted) return;
      const previousActiveTabId = activeTabId;
      const result = await this.driveBridge.getGoogleDocTabs(documentId);
      if (controller.signal.aborted) return;
      tabs = result.tabs;
      nativeTabsAvailable = result.nativeTabsAvailable;
      tabsWarning = result.warning || "";
      if (!tabs.some(tab => tab.id === activeTabId) && !dirty && !saveInFlight) {
        activeTabId = tabs.find(tab => tab.id === change.tabId)?.id
          || tabs.find(tab => tab.id === pinnedCanvasTabId)?.id
          || tabs[0]?.id
          || "";
      }
      renderTabsBar();
      if (previousActiveTabId !== activeTabId && !dirty && !saveInFlight && activeTabId) {
        await renderActiveTab();
      }
    };

    const switchTab = async (tabId: string): Promise<void> => {
      if (tabId === activeTabId || saveInFlight) return;
      if (dirty) await saveDocument();
      if (dirty) storeDraft(editableMarkdown());
      activeTabId = tabId;
      dirty = false;
      renderTabsBar();
      try {
        await renderActiveTab();
      } catch (error) {
        new Notice(`Could not open the Google Doc tab: ${this.errorMessage(error)}`, 9000);
      }
    };

    const runTabMutation = async (
      action: () => Promise<void>,
      nextActiveTabId: () => string = () => activeTabId,
      kind: GoogleDocTabChange["kind"] = "updated"
    ): Promise<void> => {
      if (!nativeTabsAvailable) {
        new Notice(tabsWarning || "Native Google Doc tabs are not available yet.", 9000);
        return;
      }
      if (dirty) await saveDocument();
      if (dirty) storeDraft(editableMarkdown());
      setSaveState("Updating tabs…", "saving");
      try {
        await action();
        activeTabId = nextActiveTabId();
        dirty = false;
        await this.tabSync.notify({ documentId, kind, tabId: activeTabId });
        await renderDocument(true);
      } catch (error) {
        setSaveState(dirty ? "Unsaved draft" : "Saved", dirty ? "dirty" : "saved");
        new Notice(`Could not update Google Doc tabs: ${this.errorMessage(error)}`, 10000);
      }
    };

    const addTab = async (parentTabId: string): Promise<void> => {
      const parent = tabs.find(tab => tab.id === parentTabId);
      const editor = await new TabEditorModal(
        this.app,
        parent ? `Add a tab under ${parent.title}` : "Add Google Doc tab",
        "New tab",
        ""
      ).openAndWait();
      if (!editor) return;
      let createdTabId = "";
      await runTabMutation(async () => {
        createdTabId = await this.driveBridge.addGoogleDocTab(
          documentId,
          editor.title,
          parentTabId,
          editor.iconEmoji
        );
      }, () => createdTabId || activeTabId, "created");
    };

    createTabCardFromDrag = async (event: DragEvent, sourceTab: GoogleDocTabInfo): Promise<void> => {
      if (!nativeTabsAvailable) {
        new Notice(tabsWarning || "Native Google Doc tabs are not available yet.", 9000);
        return;
      }
      if (!canvasContext?.node.nodeEl || event.clientX <= 0 || event.clientY <= 0) return;

      const canvasLeaf = canvasContext.node.nodeEl.closest<HTMLElement>(".workspace-leaf-content");
      const canvasBounds = canvasLeaf?.getBoundingClientRect();
      if (
        !canvasBounds
        || event.clientX < canvasBounds.left
        || event.clientX > canvasBounds.right
        || event.clientY < canvasBounds.top
        || event.clientY > canvasBounds.bottom
      ) return;

      const sourceBounds = canvasContext.node.nodeEl.getBoundingClientRect();
      if (
        event.clientX >= sourceBounds.left
        && event.clientX <= sourceBounds.right
        && event.clientY >= sourceBounds.top
        && event.clientY <= sourceBounds.bottom
      ) return;

      const editor = await new TabCardEditorModal(this.app, sourceTab.title).openAndWait();
      if (!editor) return;
      if (dirty) {
        await saveDocument(true);
        if (dirty) return;
      }

      const sourceData = canvasContext.node.getData();
      const sourceFile = canvasContext.node.file
        || this.app.vault.getAbstractFileByPath(sourceData.file);
      if (!(sourceFile instanceof TFile)) {
        new Notice("Could not find the Google Doc shortcut for the new Canvas card.", 8000);
        return;
      }

      setSaveState("Creating tab…", "saving");
      try {
        const createdTabId = await this.driveBridge.addGoogleDocTab(
          documentId,
          editor.title,
          sourceTab.parentTabId,
          editor.iconEmoji,
          sourceTab.index + (editor.placement === "below" ? 1 : 0)
        );
        if (!createdTabId) throw new Error("Google Docs did not return the new tab ID.");

        const dropPosition = canvasContext.canvas.posFromClient(event);
        const createdNode = canvasContext.canvas.createFileNode({
          pos: dropPosition,
          position: "center",
          size: {
            width: Math.max(300, sourceData.width || 400),
            height: Math.max(260, sourceData.height || 400)
          },
          file: sourceFile,
          subpath: googleDocTabSubpath(createdTabId),
          save: true,
          focus: true
        });
        if (!createdNode) throw new Error("Obsidian could not create the new Canvas card.");
        canvasContext.canvas.requestSave();
        await this.tabSync.notify({ documentId, kind: "created", tabId: createdTabId });
        await renderDocument(true);
        new Notice(`Created ${editor.title} ${editor.placement} ${sourceTab.title} and opened it in a new card.`, 8000);
      } catch (error) {
        setSaveState(dirty ? "Unsaved draft" : "Saved", dirty ? "dirty" : "saved");
        new Notice(`Could not create the tab card: ${this.errorMessage(error)}`, 10000);
      }
    };

    createTabCardFromConnector = async (addCardButton: HTMLElement): Promise<void> => {
      if (!nativeTabsAvailable) {
        new Notice(tabsWarning || "Native Google Doc tabs are not available yet.", 9000);
        return;
      }
      if (!canvasContext) return;

      const sourceTab = tabs.find(tab => tab.id === activeTabId);
      if (!sourceTab) {
        new Notice("Choose a Google Doc tab before creating its connected card.", 7000);
        return;
      }
      if (dirty) {
        await saveDocument(true);
        if (dirty) return;
      }

      const canvas = canvasContext.canvas;
      const sourceData = canvasContext.node.getData();
      const beforeData = JSON.parse(JSON.stringify(canvas.getData())) as CanvasRuntimeData;
      const beforeNodeIds = new Set(beforeData.nodes.map(node => node.id));

      addCardButton.click();
      let placeholderNode: CanvasRuntimeNode | null = null;
      for (let attempt = 0; attempt < 20 && !placeholderNode; attempt += 1) {
        placeholderNode = Array.from(canvas.nodes.values())
          .find(node => !beforeNodeIds.has(node.id)) || null;
        if (!placeholderNode) {
          await new Promise<void>(resolve => window.setTimeout(resolve, 25));
        }
      }
      if (!placeholderNode) {
        new Notice("Obsidian could not create the connected Canvas card.", 8000);
        return;
      }

      const restoreCanvas = async (): Promise<void> => {
        await Promise.resolve(canvas.setData(beforeData));
        canvas.requestSave();
      };
      const editor = await new TabCardEditorModal(this.app, sourceTab.title).openAndWait();
      if (!editor) {
        await restoreCanvas();
        return;
      }

      setSaveState("Creating tabâ€¦", "saving");
      try {
        const createdTabId = await this.driveBridge.addGoogleDocTab(
          documentId,
          editor.title,
          sourceTab.parentTabId,
          editor.iconEmoji,
          sourceTab.index + (editor.placement === "below" ? 1 : 0)
        );
        if (!createdTabId) throw new Error("Google Docs did not return the new tab ID.");

        const currentData = canvas.getData();
        const nextNodes = currentData.nodes.map(node => {
          if (node.id !== placeholderNode.id) return node;
          const fileNode: Record<string, unknown> & { id: string; type: string } = {
            ...node,
            type: "file",
            file: sourceData.file,
            subpath: googleDocTabSubpath(createdTabId)
          };
          delete fileNode.text;
          delete fileNode.url;
          return fileNode;
        });
        if (!nextNodes.some(node => node.id === placeholderNode.id && node.type === "file")) {
          throw new Error("Obsidian could not convert the connected card to a Google Doc tab card.");
        }

        await Promise.resolve(canvas.setData({ ...currentData, nodes: nextNodes }));
        canvas.requestSave();
        await this.tabSync.notify({ documentId, kind: "created", tabId: createdTabId });
        new Notice(`Created ${editor.title} ${editor.placement} ${sourceTab.title} in the connected card.`, 8000);
      } catch (error) {
        await restoreCanvas();
        setSaveState(dirty ? "Unsaved draft" : "Saved", dirty ? "dirty" : "saved");
        new Notice(`Could not create the connected tab card: ${this.errorMessage(error)}`, 10000);
      }
    };

    const editTab = async (tab: GoogleDocTabInfo): Promise<void> => {
      const editor = await new TabEditorModal(
        this.app,
        "Edit Google Doc tab",
        tab.title,
        tab.iconEmoji
      ).openAndWait();
      if (!editor || (editor.title === tab.title && editor.iconEmoji === tab.iconEmoji)) return;
      await runTabMutation(() => this.driveBridge.editGoogleDocTab(
        documentId,
        tab.id,
        editor.title,
        editor.iconEmoji
      ));
    };

    const moveTab = async (tab: GoogleDocTabInfo, direction: -1 | 1): Promise<void> => {
      const siblings = tabs
        .filter(item => item.parentTabId === tab.parentTabId)
        .sort((left, right) => left.index - right.index);
      const current = siblings.findIndex(item => item.id === tab.id);
      const nextIndex = current + direction;
      if (current < 0 || nextIndex < 0 || nextIndex >= siblings.length) return;
      await runTabMutation(() => this.driveBridge.moveGoogleDocTab(
        documentId,
        tab.id,
        tab.parentTabId,
        nextIndex
      ), undefined, "moved");
    };

    const nestTab = async (tab: GoogleDocTabInfo): Promise<void> => {
      const siblings = tabs
        .filter(item => item.parentTabId === tab.parentTabId)
        .sort((left, right) => left.index - right.index);
      const current = siblings.findIndex(item => item.id === tab.id);
      if (current <= 0) return;
      const newParent = siblings[current - 1];
      const childIndex = tabs.filter(item => item.parentTabId === newParent.id).length;
      await runTabMutation(() => this.driveBridge.moveGoogleDocTab(
        documentId,
        tab.id,
        newParent.id,
        childIndex
      ), undefined, "moved");
    };

    const outdentTab = async (tab: GoogleDocTabInfo): Promise<void> => {
      if (!tab.parentTabId) return;
      const parent = tabs.find(item => item.id === tab.parentTabId);
      if (!parent) return;
      await runTabMutation(() => this.driveBridge.moveGoogleDocTab(
        documentId,
        tab.id,
        parent.parentTabId,
        parent.index + 1
      ), undefined, "moved");
    };

    const deleteTab = async (tab: GoogleDocTabInfo): Promise<void> => {
      if (tabs.length === 1) {
        new Notice("Google Docs must keep at least one tab.", 6000);
        return;
      }
      const descendants = descendantIds(tab.id);
      const confirmed = await new DeleteTabModal(
        this.app,
        tab.title,
        descendants.size
      ).openAndWait();
      if (!confirmed) return;
      const remaining = tabs.filter(item => item.id !== tab.id && !descendants.has(item.id));
      const nextTab = remaining.find(item => item.id === tab.parentTabId)
        || remaining[Math.max(0, tabs.findIndex(item => item.id === tab.id) - 1)]
        || remaining[0];
      await runTabMutation(
        () => this.driveBridge.deleteGoogleDocTab(documentId, tab.id),
        () => nextTab?.id || "",
        "deleted"
      );
    };

    const showTabMenu = (event: MouseEvent, tab: GoogleDocTabInfo): void => {
      const siblings = tabs
        .filter(item => item.parentTabId === tab.parentTabId)
        .sort((left, right) => left.index - right.index);
      const position = siblings.findIndex(item => item.id === tab.id);
      const menu = new Menu();
      menu.addItem(item => item
        .setTitle("Rename or change icon")
        .setIcon("pencil")
        .onClick(() => void editTab(tab)));
      menu.addItem(item => item
        .setTitle("Add child tab")
        .setIcon("plus")
        .onClick(() => void addTab(tab.id)));
      menu.addSeparator();
      menu.addItem(item => item
        .setTitle("Move earlier")
        .setIcon("arrow-left")
        .setDisabled(position <= 0)
        .onClick(() => void moveTab(tab, -1)));
      menu.addItem(item => item
        .setTitle("Move later")
        .setIcon("arrow-right")
        .setDisabled(position < 0 || position >= siblings.length - 1)
        .onClick(() => void moveTab(tab, 1)));
      menu.addItem(item => item
        .setTitle("Nest under previous tab")
        .setIcon("corner-down-right")
        .setDisabled(position <= 0)
        .onClick(() => void nestTab(tab)));
      menu.addItem(item => item
        .setTitle("Move out one level")
        .setIcon("corner-left-up")
        .setDisabled(!tab.parentTabId)
        .onClick(() => void outdentTab(tab)));
      menu.addSeparator();
      menu.addItem(item => item
        .setTitle(`Delete ${tab.title}`)
        .setIcon("trash-2")
        .onClick(() => void deleteTab(tab)));
      menu.showAtMouseEvent(event);
    };

    const renderDocument = async (force = false): Promise<void> => {
      if ((dirty || saveInFlight) && !force) {
        new Notice("Save the current tab before refreshing this Google Doc.", 5000);
        return;
      }
      if (force && dirty) storeDraft(editableMarkdown());
      renderComponent?.unload();
      content.contentEditable = "false";
      content.replaceChildren();
      content.createDiv({
        cls: "google-ai-hub-gdoc-canvas-loading",
        text: "Loading Google Doc tabs…"
      });

      try {
        const result = await this.driveBridge.getGoogleDocTabs(documentId);
        if (controller.signal.aborted) return;
        tabs = result.tabs;
        nativeTabsAvailable = result.nativeTabsAvailable;
        tabsWarning = result.warning || "";
        if (!tabs.some(tab => tab.id === activeTabId)) {
          activeTabId = tabs.find(tab => tab.id === pinnedCanvasTabId)?.id || tabs[0]?.id || "";
        }
        renderTabsBar();
        await renderActiveTab();
      } catch (error) {
        if (controller.signal.aborted) return;
        content.contentEditable = "false";
        content.replaceChildren();
        content.createDiv({
          cls: "google-ai-hub-gdoc-canvas-error",
          text: `Could not load the document preview: ${this.errorMessage(error)}`
        });
      }
    };

    const selectionBelongsToContent = (range: Range): boolean => {
      const container = range.commonAncestorContainer;
      const element = container.nodeType === Node.ELEMENT_NODE
        ? container as Element
        : container.parentElement;
      return element === content || Boolean(element && content.contains(element));
    };

    const rememberSelection = (): void => {
      const selection = embed.ownerDocument.getSelection();
      if (!selection?.rangeCount) return;
      const range = selection.getRangeAt(0);
      if (selectionBelongsToContent(range)) savedSelection = range.cloneRange();
    };

    const restoreEditorSelection = (): Selection | null => {
      content.focus({ preventScroll: true });
      const selection = embed.ownerDocument.getSelection();
      if (!selection) return null;
      if (savedSelection && selectionBelongsToContent(savedSelection)) {
        selection.removeAllRanges();
        selection.addRange(savedSelection);
      }
      return selection;
    };

    const applyFormattingCommand = (command: string, value?: string): void => {
      const selection = restoreEditorSelection();
      if (!selection?.rangeCount || !selectionBelongsToContent(selection.getRangeAt(0))) {
        new Notice("Place the cursor in the document or select text first.", 5000);
        return;
      }
      embed.ownerDocument.execCommand(command, false, value);
      rememberSelection();
      markDirty();
    };

    const preserveFormattingSelection = (event: PointerEvent): void => {
      event.preventDefault();
      event.stopPropagation();
    };
    for (const button of [boldButton, italicButton, strikeButton, bulletButton, numberedButton]) {
      button.addEventListener("pointerdown", preserveFormattingSelection, { signal: controller.signal });
    }
    boldButton.addEventListener("click", () => applyFormattingCommand("bold"), { signal: controller.signal });
    italicButton.addEventListener("click", () => applyFormattingCommand("italic"), { signal: controller.signal });
    strikeButton.addEventListener("click", () => applyFormattingCommand("strikeThrough"), { signal: controller.signal });
    bulletButton.addEventListener("click", () => applyFormattingCommand("insertUnorderedList"), { signal: controller.signal });
    numberedButton.addEventListener("click", () => applyFormattingCommand("insertOrderedList"), { signal: controller.signal });
    blockStyleSelect.addEventListener("change", () => {
      applyFormattingCommand("formatBlock", blockStyleSelect.value);
    }, { signal: controller.signal });

    const normalizeLinkUrl = (value: string): string | null => {
      let candidate = value.trim();
      if (!candidate) return null;
      if (candidate.startsWith("#")) return candidate;
      if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) candidate = `https://${candidate}`;
      try {
        const protocol = new URL(candidate).protocol;
        return protocol === "http:" || protocol === "https:" || protocol === "mailto:"
          ? candidate
          : null;
      } catch {
        return null;
      }
    };

    const addOrEditLink = async (): Promise<void> => {
      const selection = restoreEditorSelection();
      if (!selection) return;

      const range = selection.rangeCount ? selection.getRangeAt(0) : null;
      if (!range || !selectionBelongsToContent(range)) {
        new Notice("Place the cursor in the document or select text first.", 5000);
        return;
      }

      const commonElement = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? range.commonAncestorContainer as Element
        : range.commonAncestorContainer.parentElement;
      const existingLink = commonElement?.closest("a");
      const selectedText = selection.toString();
      const editorResult = await new LinkEditorModal(
        this.app,
        range.collapsed && !existingLink,
        selectedText || "Link",
        existingLink?.getAttribute("href") || "https://"
      ).openAndWait();
      if (!editorResult) return;

      const url = normalizeLinkUrl(editorResult.url);
      if (!url) {
        new Notice("Use an http, https, mailto, or #anchor link.", 6000);
        return;
      }

      content.focus({ preventScroll: true });
      selection.removeAllRanges();
      selection.addRange(range);

      if (existingLink && !selectedText) {
        existingLink.setAttribute("href", url);
      } else if (range.collapsed) {
        const anchor = embed.ownerDocument.createElement("a");
        anchor.setAttribute("href", url);
        anchor.textContent = editorResult.text;
        range.insertNode(anchor);
        range.setStartAfter(anchor);
        range.collapse(true);
      } else {
        const selectedFragment = range.cloneContents();
        if (selectedFragment.querySelector("p, div, h1, h2, h3, h4, h5, h6, li, table")) {
          new Notice("Select text within a single paragraph to create a link.", 6000);
          return;
        }
        const anchor = embed.ownerDocument.createElement("a");
        anchor.setAttribute("href", url);
        anchor.appendChild(range.extractContents());
        range.insertNode(anchor);
        range.selectNodeContents(anchor);
      }

      selection.removeAllRanges();
      selection.addRange(range);
      savedSelection = range.cloneRange();
      markDirty();
    };

    const renderMarkdownFragment = async (markdown: string): Promise<DocumentFragment> => {
      const host = embed.ownerDocument.createElement("div");
      const component = new Component();
      this.addChild(component);
      try {
        await MarkdownRenderer.render(
          this.app,
          markdown,
          host,
          this.settings.googleDocShortcuts[documentId] || "",
          component
        );
        const fragment = embed.ownerDocument.createDocumentFragment();
        fragment.append(...Array.from(host.childNodes));
        return fragment;
      } finally {
        component.unload();
        this.removeChild(component);
      }
    };

    const canvasAiTarget = (): AiDocumentTarget => {
      const selection = embed.ownerDocument.getSelection();
      const currentRange = selection?.rangeCount ? selection.getRangeAt(0) : null;
      const selectedRange = currentRange && selectionBelongsToContent(currentRange)
        ? currentRange
        : savedSelection && selectionBelongsToContent(savedSelection)
          ? savedSelection
          : null;
      const useSelection = Boolean(
        selectedRange
        && !selectedRange.collapsed
        && selectionBelongsToContent(selectedRange)
      );
      const range = useSelection ? selectedRange!.cloneRange() : null;
      const selectionHost = embed.ownerDocument.createElement("div");
      if (range) selectionHost.appendChild(range.cloneContents());
      const selectedMarkdown = range ? turndown.turndown(selectionHost.innerHTML).trim() : "";
      const applyAtRange = async (markdown: string, insertBelow: boolean): Promise<void> => {
        if (!range) {
          const next = insertBelow
            ? `${editableMarkdown().trimEnd()}\n\n${markdown}\n`
            : markdown;
          renderComponent?.unload();
          renderComponent = new Component();
          this.addChild(renderComponent);
          content.replaceChildren();
          await MarkdownRenderer.render(
            this.app,
            next,
            content,
            this.settings.googleDocShortcuts[documentId] || "",
            renderComponent
          );
          content.contentEditable = "true";
          markDirty();
          return;
        }
        const targetRange = range.cloneRange();
        if (insertBelow) targetRange.collapse(false);
        else targetRange.deleteContents();
        const fragment = await renderMarkdownFragment(markdown);
        const lastNode = fragment.lastChild;
        targetRange.insertNode(fragment);
        if (lastNode) {
          const nextRange = embed.ownerDocument.createRange();
          nextRange.setStartAfter(lastNode);
          nextRange.collapse(true);
          savedSelection = nextRange;
        }
        markDirty();
      };
      return {
        title: tabs.find(tab => tab.id === activeTabId)?.title || "Google Doc tab",
        description: range ? "Selected Google Doc tab text" : "Google Doc tab",
        markdown: selectedMarkdown || editableMarkdown(),
        readRevision: async () => editableMarkdown(),
        replace: markdown => applyAtRange(markdown, false),
        insertBelow: markdown => applyAtRange(markdown, true)
      };
    };

    aiButton.addEventListener("pointerdown", preserveFormattingSelection, { signal: controller.signal });
    aiButton.addEventListener("click", event => {
      event.preventDefault();
      const menu = new Menu();
      menu.addItem(item => item
        .setTitle(`Model: ${this.currentGeminiModelLabel()}`)
        .setIcon("settings-2")
        .onClick(() => void this.chooseGeminiModel()));
      menu.addSeparator();
      for (const action of ["summarize", "shorten", "lengthen", "elaborate"] as const) {
        menu.addItem(item => item
          .setTitle(this.aiActionLabel(action))
          .setIcon("sparkles")
          .onClick(() => void this.runAiWritingAction(action, canvasAiTarget())));
      }
      menu.showAtMouseEvent(event);
    }, { signal: controller.signal });

    controller.signal.addEventListener("abort", () => {
      renderComponent?.unload();
      if (saveTimer !== null) window.clearTimeout(saveTimer);
    }, { once: true });
    embed.ownerDocument.addEventListener("selectionchange", rememberSelection, { signal: controller.signal });
    const stopCanvasEditingEvent = (event: Event): void => event.stopPropagation();
    content.addEventListener("pointerdown", event => {
      event.stopPropagation();
      if (event.button === 0 && content.contentEditable === "true") {
        content.focus({ preventScroll: true });
      }
    }, { signal: controller.signal });
    content.addEventListener("selectstart", stopCanvasEditingEvent, { signal: controller.signal });
    content.addEventListener("dragstart", stopCanvasEditingEvent, { signal: controller.signal });
    content.addEventListener("pointerup", stopCanvasEditingEvent, { signal: controller.signal });
    content.addEventListener("mousedown", stopCanvasEditingEvent, { signal: controller.signal });
    content.addEventListener("mouseup", stopCanvasEditingEvent, { signal: controller.signal });
    content.addEventListener("dblclick", stopCanvasEditingEvent, { signal: controller.signal });
    content.addEventListener("click", event => {
      event.stopPropagation();
      const anchor = (event.target as Element | null)?.closest?.("a");
      if (anchor && !(event.ctrlKey || event.metaKey)) event.preventDefault();
    }, { signal: controller.signal });
    content.addEventListener("input", () => markDirty(), { signal: controller.signal });
    content.addEventListener("focusout", () => {
      if (dirty && nativeTabsAvailable) void saveDocument();
    }, { signal: controller.signal });
    content.addEventListener("keydown", event => {
      event.stopPropagation();
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === "s") {
        event.preventDefault();
        void saveDocument(true);
      } else if (key === "k") {
        event.preventDefault();
        void addOrEditLink();
      } else if (key === "b") {
        event.preventDefault();
        applyFormattingCommand("bold");
      } else if (key === "i") {
        event.preventDefault();
        applyFormattingCommand("italic");
      } else if (key === "x" && event.shiftKey) {
        event.preventDefault();
        applyFormattingCommand("strikeThrough");
      }
    }, { signal: controller.signal });
    content.addEventListener("keypress", stopCanvasEditingEvent, { signal: controller.signal });
    content.addEventListener("keyup", stopCanvasEditingEvent, { signal: controller.signal });
    linkButton.addEventListener("pointerdown", event => event.preventDefault(), { signal: controller.signal });
    linkButton.addEventListener("click", event => {
      event.preventDefault();
      void addOrEditLink();
    }, { signal: controller.signal });
    saveButton.addEventListener("click", event => {
      event.preventDefault();
      void saveDocument(true);
    }, { signal: controller.signal });
    refreshButton.addEventListener("click", event => {
      event.preventDefault();
      void renderDocument();
    }, { signal: controller.signal });
    if (canvasContext) {
      const connectorAction: CanvasGoogleDocConnectorAction = {
        ...canvasContext,
        createTabCard: addCardButton => createTabCardFromConnector(addCardButton)
      };
      this.canvasGoogleDocConnectorActions.set(canvasContext.node, connectorAction);
      controller.signal.addEventListener("abort", () => {
        if (this.canvasGoogleDocConnectorActions.get(canvasContext.node) === connectorAction) {
          this.canvasGoogleDocConnectorActions.delete(canvasContext.node);
        }
      }, { once: true });
      this.refreshCanvasGoogleDocConnectorMenus();
    }
    const unregisterTabSync = this.tabSync.register(documentId, refreshTabsOnly);
    controller.signal.addEventListener("abort", unregisterTabSync, { once: true });
    void renderDocument();
  }

  private aiActionLabel(action: AiWritingAction): string {
    return action === "briefing"
      ? "Briefing report"
      : action.charAt(0).toUpperCase() + action.slice(1);
  }

  private async runAiWritingAction(
    action: AiWritingAction,
    target: AiDocumentTarget,
    model = this.settings.geminiModel
  ): Promise<void> {
    const original = target.markdown;
    const revisionHash = sourceHash(await target.readRevision());
    let generated: AiResult | null = null;
    new Notice(`${this.aiActionLabel(action)} with ${this.currentGeminiModelLabel(model)}...`, 5000);

    while (true) {
      try {
        generated = await this.geminiAi.generate({
          action,
          title: target.title,
          markdown: original,
          model
        });
      } catch (error) {
        new Notice(`AI action failed: ${this.errorMessage(error)} The document was not changed.`, 12000);
        return;
      }

      const canWrite = isSourceCurrent(revisionHash, await target.readRevision());
      const choice = await new AiResultModal(
        this.app,
        action,
        original,
        generated.markdown,
        canWrite,
        generated.model
      ).openAndWait();
      if (!choice) return;
      if (choice === "regenerate") continue;
      if (choice === "copy") {
        await navigator.clipboard.writeText(generated.markdown);
        new Notice("AI result copied to the clipboard.", 5000);
        return;
      }
      if (!canWrite) return;
      try {
        if (choice === "replace") await target.replace(generated.markdown);
        else await target.insertBelow(generated.markdown);
        new Notice(`AI ${choice === "replace" ? "replacement" : "result"} applied.`, 5000);
      } catch (error) {
        new Notice(`Could not apply the AI result: ${this.errorMessage(error)}`, 10000);
      }
      return;
    }
  }

  private async runMarkdownAiAction(
    action: AiWritingAction,
    editor: Editor,
    view: { file?: TFile | null }
  ): Promise<void> {
    const selected = editor.getSelection();
    const originalFrom = editor.getCursor("from");
    const originalTo = editor.getCursor("to");
    const operatesOnSelection = Boolean(selected);
    const target: AiDocumentTarget = {
      title: view.file?.basename || "Obsidian note",
      description: operatesOnSelection ? "Selected Markdown" : "Current Markdown note",
      markdown: selected || editor.getValue(),
      readRevision: async () => editor.getValue(),
      replace: async markdown => {
        if (operatesOnSelection) editor.replaceRange(markdown, originalFrom, originalTo);
        else editor.setValue(markdown);
      },
      insertBelow: async markdown => {
        if (operatesOnSelection) editor.replaceRange(`\n\n${markdown}`, originalTo);
        else editor.setValue(`${editor.getValue().trimEnd()}\n\n${markdown}\n`);
      }
    };
    await this.runAiWritingAction(action, target);
  }

  private async googleDocShortcutInfo(file: TFile): Promise<{ documentId: string; url: string }> {
    const raw = await this.app.vault.cachedRead(file);
    const shortcut = JSON.parse(raw) as GoogleDocShortcut;
    const url = shortcut.url || (shortcut.doc_id
      ? `https://docs.google.com/document/d/${shortcut.doc_id}/edit`
      : "");
    const documentId = shortcut.doc_id || (url ? getGoogleDocId(url) : "") || "";
    if (!documentId || !url) throw new Error("The shortcut does not contain a Google Docs document ID and URL.");
    return { documentId, url };
  }

  private async markdownToGoogleDocUpdate(markdown: string, sourcePath: string): Promise<GoogleDocTabContentUpdate> {
    const host = document.createElement("div");
    const component = new Component();
    this.addChild(component);
    try {
      await MarkdownRenderer.render(this.app, markdown, host, sourcePath, component);
      return buildGoogleDocTabContent(host);
    } finally {
      component.unload();
      this.removeChild(component);
    }
  }

  private async runStandaloneGoogleDocAiAction(action: AiWritingAction, file: TFile): Promise<void> {
    if (!this.googleConnected) {
      new Notice("Connect Google Drive before using document AI on a Google Doc.", 8000);
      return;
    }
    try {
      const { documentId } = await this.googleDocShortcutInfo(file);
      const result = await this.driveBridge.getGoogleDocTabs(documentId);
      const tab = await new GoogleDocTabPickerModal(this.app, result.tabs).openAndWait();
      if (!tab) return;
      const readTab = async (): Promise<GoogleDocTabInfo> => {
        const latest = await this.driveBridge.getGoogleDocTabs(documentId);
        const current = latest.tabs.find(item => item.id === tab.id);
        if (!current) throw new Error("The selected Google Doc tab no longer exists.");
        return current;
      };
      const target: AiDocumentTarget = {
        title: `${file.basename} - ${tab.title}`,
        description: "Google Doc tab",
        markdown: tab.markdown,
        readRevision: async () => (await readTab()).markdown,
        replace: async markdown => {
          await this.driveBridge.updateGoogleDocTabContent(
            documentId,
            tab.id,
            await this.markdownToGoogleDocUpdate(markdown, file.path)
          );
          await this.tabSync.notify({ documentId, kind: "updated", tabId: tab.id });
        },
        insertBelow: async markdown => {
          const current = await readTab();
          await this.driveBridge.updateGoogleDocTabContent(
            documentId,
            tab.id,
            await this.markdownToGoogleDocUpdate(`${current.markdown.trimEnd()}\n\n${markdown}\n`, file.path)
          );
          await this.tabSync.notify({ documentId, kind: "updated", tabId: tab.id });
        }
      };
      await this.runAiWritingAction(action, target);
    } catch (error) {
      new Notice(`Could not use document AI: ${this.errorMessage(error)}`, 10000);
    }
  }

  async activateService(service: ServiceKey): Promise<GoogleAiHubView | null> {
    const existing = service === "home"
      ? undefined
      : this.app.workspace.getLeavesOfType(VIEW_TYPE_GOOGLE_AI_HUB)
        .find(leaf => (leaf.view as unknown as GoogleAiHubView).getService() === service);

    if (existing) {
      this.app.workspace.setActiveLeaf(existing, { focus: true });
      await this.app.workspace.revealLeaf(existing);
      return existing.view as unknown as GoogleAiHubView;
    }

    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({
      type: VIEW_TYPE_GOOGLE_AI_HUB,
      active: true,
      state: { service }
    });
    await this.app.workspace.revealLeaf(leaf);
    return leaf.view instanceof GoogleAiHubView ? leaf.view : null;
  }

  async loadSettings(): Promise<void> {
    const saved = await this.loadData() as Partial<GoogleAiHubSettings> | null;
    this.settings = {
      notebookLmUrl: normalizeUrl(saved?.notebookLmUrl ?? "", DEFAULT_SETTINGS.notebookLmUrl),
      geminiUrl: normalizeUrl(saved?.geminiUrl ?? "", DEFAULT_SETTINGS.geminiUrl),
      driveUrl: normalizeUrl(saved?.driveUrl ?? "", DEFAULT_SETTINGS.driveUrl),
      googleCredentialsPath: saved?.googleCredentialsPath || DEFAULT_SETTINGS.googleCredentialsPath,
      googleDocsFolder: saved?.googleDocsFolder || DEFAULT_SETTINGS.googleDocsFolder,
      autoSyncGoogleDocs: saved?.autoSyncGoogleDocs ?? DEFAULT_SETTINGS.autoSyncGoogleDocs,
      geminiModel: saved?.geminiModel || DEFAULT_SETTINGS.geminiModel,
      geminiKnownModels: Array.isArray(saved?.geminiKnownModels) ? saved.geminiKnownModels : [],
      googleDocShortcuts: saved?.googleDocShortcuts || {},
      noteMirrors: saved?.noteMirrors || {},
      folderMirrors: saved?.folderMirrors || {}
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  getGeminiModels(): GeminiModelInfo[] {
    return mergeGeminiModels(this.settings.geminiKnownModels, [this.settings.geminiModel]);
  }

  currentGeminiModelLabel(modelId = this.settings.geminiModel): string {
    return this.getGeminiModels().find(model => model.id === modelId)?.displayName || modelId;
  }

  async setGeminiModel(value: string): Promise<void> {
    const modelId = normalizeGeminiModelId(value) || DEFAULT_GEMINI_MODEL;
    this.settings.geminiModel = modelId;
    if (!this.getGeminiModels().some(model => model.id === modelId)) {
      this.settings.geminiKnownModels.push({
        id: modelId,
        displayName: modelId,
        description: "Custom or account-specific Gemini model."
      });
    }
    await this.saveSettings();
    new Notice(`Google AI Hub will use ${this.currentGeminiModelLabel(modelId)}.`, 6000);
  }

  async chooseGeminiModel(): Promise<GeminiModelInfo | null> {
    const model = await new GeminiModelPickerModal(
      this.app,
      this.getGeminiModels(),
      this.settings.geminiModel
    ).openAndWait();
    if (model) await this.setGeminiModel(model.id);
    return model;
  }

  async refreshGeminiModels(): Promise<GeminiModelInfo[]> {
    new Notice("Checking models available to this Gemini API key...", 5000);
    try {
      const models = await this.geminiAi.listModels();
      this.settings.geminiKnownModels = models;
      await this.saveSettings();
      new Notice(`Found ${models.length} Gemini text-generation models.`, 7000);
      return models;
    } catch (error) {
      new Notice(`Could not refresh Gemini models: ${this.errorMessage(error)}`, 10000);
      return this.getGeminiModels();
    }
  }

  async generateForSource(
    action: AiWritingAction,
    source: AiDocumentSource,
    instruction?: string,
    conversation?: Array<{ role: "user" | "model"; text: string }>,
    model = this.settings.geminiModel
  ): Promise<AiResult> {
    return this.geminiAi.generate({
      action,
      title: source.title,
      markdown: source.markdown,
      instruction,
      conversation,
      model
    });
  }

  async previewSourceAction(action: AiWritingAction, source: AiDocumentSource): Promise<void> {
    if (source.readRevision && source.replace && source.insert) {
      await this.runAiWritingAction(action, {
        ...source,
        readRevision: source.readRevision,
        replace: source.replace,
        insertBelow: source.insert
      });
      return;
    }
    while (true) {
      let result: AiResult;
      try {
        result = await this.generateForSource(action, source);
      } catch (error) {
        new Notice(`AI request failed: ${this.errorMessage(error)} The source was not changed.`, 11000);
        return;
      }
      const choice = await new AiResultModal(
        this.app,
        action,
        source.markdown,
        result.markdown,
        false,
        result.model
      ).openAndWait();
      if (choice === "regenerate") continue;
      if (choice === "copy") {
        await navigator.clipboard.writeText(result.markdown);
        new Notice("AI result copied to the clipboard.", 5000);
      }
      return;
    }
  }

  async getActiveAiSource(): Promise<AiDocumentSource | null> {
    const file = this.app.workspace.getActiveFile();
    if (file instanceof TFile && (file.extension === "md" || file.extension === "gdoc")) {
      return this.aiSourceForItem(file);
    }

    const content = document.querySelector<HTMLElement>(
      ".canvas-node.is-focused .google-ai-hub-gdoc-canvas-content, .canvas-node.is-selected .google-ai-hub-gdoc-canvas-content"
    );
    if (!content) return null;
    const turndown = new TurndownService({ headingStyle: "atx", bulletListMarker: "-" });
    const read = async (): Promise<string> => {
      const markdown = turndown.turndown(content.innerHTML).trimEnd();
      return markdown ? `${markdown}\n` : "\n";
    };
    const apply = async (markdown: string, insert: boolean): Promise<void> => {
      const component = new Component();
      this.addChild(component);
      const host = document.createElement("div");
      try {
        await MarkdownRenderer.render(this.app, markdown, host, "", component);
        if (!insert) content.replaceChildren();
        content.append(...Array.from(host.childNodes));
        content.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
      } finally {
        component.unload();
        this.removeChild(component);
      }
    };
    const markdown = await read();
    return {
      title: content.getAttribute("aria-label") || "Canvas Google Doc tab",
      description: "Active Canvas Google Doc tab",
      markdown,
      readRevision: read,
      replace: value => apply(value, false),
      insert: value => apply(value, true)
    };
  }

  async chooseAiSource(): Promise<AiDocumentSource | null> {
    const item = await new AiSourcePickerModal(this.app).openAndWait();
    return item ? this.aiSourceForItem(item) : null;
  }

  private async aiSourceForItem(item: TFile | TFolder): Promise<AiDocumentSource | null> {
    if (item instanceof TFolder) {
      const files = this.getMarkdownFiles(item);
      const sections = await Promise.all(files.map(async file => [
        `## ${file.basename}`,
        `Vault path: ${file.path}`,
        "",
        await this.app.vault.cachedRead(file)
      ].join("\n")));
      return {
        title: item.isRoot() ? this.app.vault.getName() : item.name,
        description: `${files.length} Markdown notes from ${item.path || "/"}`,
        markdown: sections.join("\n\n")
      };
    }
    if (item.extension === "md") {
      const read = () => this.app.vault.cachedRead(item);
      const markdown = await read();
      return {
        title: item.basename,
        description: `Markdown note - ${item.path}`,
        markdown,
        readRevision: read,
        replace: value => this.app.vault.modify(item, value),
        insert: async value => this.app.vault.modify(item, `${(await read()).trimEnd()}\n\n${value}\n`)
      };
    }
    if (!this.googleConnected) {
      new Notice("Connect Google Drive before selecting a Google Doc as an AI source.", 8000);
      return null;
    }
    const { documentId } = await this.googleDocShortcutInfo(item);
    const tabsResult = await this.driveBridge.getGoogleDocTabs(documentId);
    const tab = await new GoogleDocTabPickerModal(this.app, tabsResult.tabs).openAndWait();
    if (!tab) return null;
    const readTab = async (): Promise<GoogleDocTabInfo> => {
      const latest = await this.driveBridge.getGoogleDocTabs(documentId);
      const current = latest.tabs.find(candidate => candidate.id === tab.id);
      if (!current) throw new Error("The selected Google Doc tab no longer exists.");
      return current;
    };
    const writeTab = async (value: string): Promise<void> => {
      await this.driveBridge.updateGoogleDocTabContent(
        documentId,
        tab.id,
        await this.markdownToGoogleDocUpdate(value, item.path)
      );
      await this.tabSync.notify({ documentId, kind: "updated", tabId: tab.id });
    };
    return {
      title: `${item.basename} - ${tab.title}`,
      description: `Google Doc tab - ${item.path}`,
      markdown: tab.markdown,
      readRevision: async () => (await readTab()).markdown,
      replace: writeTab,
      insert: async value => writeTab(`${(await readTab()).markdown.trimEnd()}\n\n${value}\n`)
    };
  }

  async openNotebookLmStudio(source: AiDocumentSource, control: "source" | "mind map" | "audio overview"): Promise<void> {
    const result = await this.loadSourceIntoService("notebooklm", source.title, source.markdown);
    if (!result.ok) {
      new Notice(result.message, 14000);
      return;
    }
    const view = this.app.workspace.getLeavesOfType(VIEW_TYPE_GOOGLE_AI_HUB)
      .map(leaf => leaf.view)
      .find(candidate => candidate instanceof GoogleAiHubView && candidate.getService() === "notebooklm") as GoogleAiHubView | undefined;
    const focused = result.ok && view ? await view.focusNotebookLmControl(control) : false;
    const next = control === "source"
      ? result.message
      : focused
        ? `${result.message} ${control === "mind map" ? "Mind Map" : "Audio Overview"} is focused; generation has not been started.`
        : `${result.message} Open Studio and choose ${control === "mind map" ? "Mind Map" : "Audio Overview"}; generation has not been started.`;
    new Notice(next, 12000);
  }

  openNotePicker(service: AiService): void {
    new VaultItemSuggestModal(this.app, item => {
      void this.prepareItemForService(item, service);
    }).open();
  }

  async connectGoogleDrive(): Promise<void> {
    new Notice("Complete Google Drive authorization in your browser.", 8000);
    try {
      await this.driveBridge.connect();
      this.googleConnected = true;
      new Notice("Google Drive connected. Building the Google Docs folder...", 7000);
      await this.syncGoogleDocs();
    } catch (error) {
      new Notice(`Google Drive connection failed: ${this.errorMessage(error)}`, 10000);
    }
  }

  async syncGoogleDocs(showNotice = true): Promise<void> {
    if (!this.googleConnected) {
      if (showNotice) new Notice("Connect Google Drive before refreshing document shortcuts.", 7000);
      return;
    }

    if (showNotice) new Notice("Refreshing Google Docs shortcuts...");
    try {
      const result = await this.driveBridge.syncGoogleDocShortcuts(
        this.settings.googleDocsFolder,
        this.settings.googleDocShortcuts
      );
      this.settings.googleDocShortcuts = result.shortcuts;
      await this.saveSettings();
      if (showNotice) {
        new Notice(`${result.count} Google Docs are available under ${this.settings.googleDocsFolder}.`, 8000);
      }
    } catch (error) {
      if (showNotice) new Notice(`Could not refresh Google Docs: ${this.errorMessage(error)}`, 10000);
    }
  }

  private copyActiveNoteForService(
    service: AiService,
    checking: boolean
  ): boolean {
    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile) || file.extension !== "md") return false;
    if (checking) return true;

    void this.prepareNoteForService(file, service);
    return true;
  }

  private isSupportedAiSource(item: TAbstractFile): item is TFile | TFolder {
    return item instanceof TFolder
      || (item instanceof TFile && (item.extension === "md" || item.extension === "gdoc"));
  }

  private async prepareItemForService(
    item: TFile | TFolder,
    service: AiService
  ): Promise<void> {
    if (item instanceof TFolder) {
      await this.prepareFolderForService(item, service);
      return;
    }
    if (item.extension === "gdoc") {
      await this.prepareGoogleDocForService(item, service);
      return;
    }
    await this.prepareNoteForService(item, service);
  }

  private publishActiveNote(checking: boolean): boolean {
    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile) || file.extension !== "md") return false;
    if (checking) return true;
    void this.publishNote(file, true);
    return true;
  }

  private async loadSourceIntoService(
    service: AiService,
    title: string,
    content: string
  ): Promise<SourceLoadResult> {
    let notebookLmClipboardReady = false;
    if (service === "notebooklm") {
      try {
        await navigator.clipboard.writeText(`# ${title}\n\n${content}`);
        notebookLmClipboardReady = true;
      } catch {
        // Automatic insertion can still work. If it does not, report that the clipboard fallback is unavailable.
      }
    }
    const view = await this.activateService(service);
    if (!view) return { ok: false, message: "The AI view could not be opened." };
    const result = await view.loadSource(title, content);
    if (!result.ok && result.mode === "notebooklm-clipboard" && !notebookLmClipboardReady) {
      return {
        ...result,
        message: "NotebookLM rejected automatic input and Obsidian could not access the clipboard. Return to the source document, copy its text, then paste it into the focused Copied text box and click Insert."
      };
    }
    return result;
  }

  private async prepareNoteForService(
    file: TFile,
    service: AiService
  ): Promise<void> {
    const content = await this.app.vault.cachedRead(file);
    const context = [
      "Use the following Obsidian note as source context.",
      `Title: ${file.basename}`,
      `Vault path: ${file.path}`,
      "",
      "--- BEGIN NOTE ---",
      content,
      "--- END NOTE ---"
    ].join("\n");

    await navigator.clipboard.writeText(context);
    const result = await this.loadSourceIntoService(service, file.basename, context);
    new Notice(result.ok ? result.message : `${result.message} The note is also on your clipboard.`, 12000);
  }

  private async prepareGoogleDocForService(file: TFile, service: AiService): Promise<void> {
    try {
      const raw = await this.app.vault.cachedRead(file);
      const shortcut = JSON.parse(raw) as GoogleDocShortcut;
      const url = shortcut.url || (shortcut.doc_id
        ? `https://docs.google.com/document/d/${shortcut.doc_id}/edit`
        : "");
      if (!url) throw new Error("The shortcut does not contain a Google Docs URL.");

      const documentId = shortcut.doc_id || url.match(/\/document\/d\/([^/]+)/)?.[1] || "";
      if (!documentId) throw new Error("The shortcut does not contain a Google Docs document ID.");
      if (!this.googleConnected) {
        await navigator.clipboard.writeText(url);
        await this.activateService(service);
        new Notice("Reconnect Google Drive from Google AI Hub once to allow document content to load. The document link is on your clipboard.", 12000);
        return;
      }

      const documentContent = await this.driveBridge.exportGoogleDoc(documentId);
      const context = [
        "Use the following Google Doc as source context.",
        `Title: ${file.basename}`,
        `Google Docs URL: ${url}`,
        "",
        "--- BEGIN GOOGLE DOC ---",
        documentContent,
        "--- END GOOGLE DOC ---"
      ].join("\n");
      await navigator.clipboard.writeText(context);
      const result = await this.loadSourceIntoService(service, file.basename, context);
      new Notice(result.ok ? result.message : `${result.message} The document text is also on your clipboard.`, 12000);
    } catch (error) {
      new Notice(`Could not prepare ${file.basename}: ${this.errorMessage(error)}`, 10000);
    }
  }

  private async prepareFolderForService(folder: TFolder, service: AiService): Promise<void> {
    const files = this.getMarkdownFiles(folder);
    const folderLabel = folder.isRoot() ? this.app.vault.getName() : folder.name;
    if (!files.length) {
      new Notice(`${folderLabel} does not contain any Markdown notes.`, 7000);
      return;
    }

    new Notice(`Preparing ${files.length} notes from ${folderLabel}...`, 5000);
    const sections = await Promise.all(files.map(async file => {
      const content = await this.app.vault.cachedRead(file);
      return [
        `## ${file.basename}`,
        `Vault path: ${file.path}`,
        "",
        content
      ].join("\n");
    }));
    const context = [
      "Use the following Obsidian folder as source context.",
      `Folder: ${folder.path || "/"}`,
      `Notes: ${files.length}`,
      "",
      "--- BEGIN FOLDER ---",
      ...sections,
      "--- END FOLDER ---"
    ].join("\n\n");

    await navigator.clipboard.writeText(context);
    const result = await this.loadSourceIntoService(service, folderLabel, context);
    new Notice(result.ok ? result.message : `${result.message} The folder context is also on your clipboard.`, 14000);
  }

  private getMarkdownFiles(folder: TFolder): TFile[] {
    const files: TFile[] = [];
    const collect = (item: TAbstractFile): void => {
      if (item instanceof TFile && item.extension === "md") {
        files.push(item);
      } else if (item instanceof TFolder) {
        item.children.forEach(collect);
      }
    };
    folder.children.forEach(collect);
    return files.sort((left, right) => left.path.localeCompare(right.path));
  }

  private async publishNote(file: TFile, showNotice: boolean): Promise<NoteMirror | null> {
    if (!this.googleConnected) {
      if (showNotice) new Notice("Connect Google Drive before publishing an Obsidian note.", 7000);
      return null;
    }

    try {
      const mirror = await this.driveBridge.publishNote(file, this.settings.noteMirrors[file.path]);
      this.settings.noteMirrors[file.path] = mirror;
      await this.saveSettings();
      await this.syncGoogleDocs(false);
      if (showNotice) {
        new Notice(`${file.basename} is available in Google Drive under Obsidian Notes.`, 8000);
      }
      return mirror;
    } catch (error) {
      new Notice(`Could not publish ${file.basename}: ${this.errorMessage(error)}`, 10000);
      return null;
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

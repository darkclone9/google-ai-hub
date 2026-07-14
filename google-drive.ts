import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { randomBytes } from "crypto";
import { promises as fs } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import type { AddressInfo } from "net";
import {
  App,
  TFile,
  normalizePath,
  requestUrl
} from "obsidian";

const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";
const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder";
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive.readonly"
];

interface OAuthClientDefinition {
  client_id: string;
  client_secret: string;
  auth_uri?: string;
  token_uri?: string;
}

interface OAuthCredentialsFile {
  installed?: OAuthClientDefinition;
  web?: OAuthClientDefinition;
}

interface StoredOAuthToken {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  scope?: string;
  token_type?: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

export interface DriveFile {
  id: string;
  name: string;
  parents?: string[];
  modifiedTime?: string;
  webViewLink?: string;
}

export interface NoteMirror {
  id: string;
  name: string;
  webViewLink: string;
  modifiedTime: number;
}

export interface ShortcutSyncResult {
  count: number;
  shortcuts: Record<string, string>;
}

export interface GoogleDocTextStyleRange {
  startIndex: number;
  endIndex: number;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  code?: boolean;
  linkUrl?: string;
}

export interface GoogleDocParagraphStyleRange {
  startIndex: number;
  endIndex: number;
  namedStyleType: string;
  indentStartPoints?: number;
}

export interface GoogleDocBulletRange {
  startIndex: number;
  endIndex: number;
  preset: "BULLET_DISC_CIRCLE_SQUARE" | "NUMBERED_DECIMAL_NESTED";
}

export interface GoogleDocTabContentUpdate {
  text: string;
  textStyles: GoogleDocTextStyleRange[];
  paragraphStyles: GoogleDocParagraphStyleRange[];
  bullets: GoogleDocBulletRange[];
}

export interface GoogleDocTabInfo {
  id: string;
  title: string;
  parentTabId: string;
  index: number;
  nestingLevel: number;
  iconEmoji: string;
  markdown: string;
}

export interface GoogleDocTabsResult {
  tabs: GoogleDocTabInfo[];
  nativeTabsAvailable: boolean;
  warning?: string;
}

interface DriveListResponse {
  files?: DriveFile[];
  nextPageToken?: string;
}

interface DocsTabProperties {
  tabId?: string;
  title?: string;
  parentTabId?: string;
  index?: number;
  nestingLevel?: number;
  iconEmoji?: string;
}

interface DocsTextStyle {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  link?: { url?: string; tabId?: string };
}

interface DocsParagraphElement {
  textRun?: { content?: string; textStyle?: DocsTextStyle };
  inlineObjectElement?: unknown;
  person?: { personProperties?: { name?: string } };
  richLink?: { richLinkProperties?: { title?: string; uri?: string } };
  horizontalRule?: unknown;
  pageBreak?: unknown;
}

interface DocsParagraph {
  elements?: DocsParagraphElement[];
  paragraphStyle?: { namedStyleType?: string };
  bullet?: { nestingLevel?: number };
}

interface DocsStructuralElement {
  startIndex?: number;
  endIndex?: number;
  paragraph?: DocsParagraph;
  table?: {
    tableRows?: Array<{
      tableCells?: Array<{ content?: DocsStructuralElement[] }>;
    }>;
  };
  tableOfContents?: { content?: DocsStructuralElement[] };
}

interface DocsDocumentTab {
  body?: { content?: DocsStructuralElement[] };
}

interface DocsTab {
  tabProperties?: DocsTabProperties;
  childTabs?: DocsTab[];
  documentTab?: DocsDocumentTab;
}

interface DocsDocumentResponse {
  tabs?: DocsTab[];
}

interface DocsBatchUpdateResponse {
  replies?: Array<{
    addDocumentTab?: { tabProperties?: DocsTabProperties };
  }>;
}

interface DriveFileResponse extends DriveFile {
  error?: { message?: string };
}

interface GoogleRequestError {
  message?: string;
  text?: string;
  json?: {
    error?: {
      message?: string;
      errors?: Array<{ reason?: string }>;
      details?: Array<{ reason?: string }>;
    };
  };
}

function getGoogleRequestError(error: unknown): { message: string; reason: string } {
  if (!error || typeof error !== "object") {
    return { message: error instanceof Error ? error.message : String(error || ""), reason: "" };
  }

  const requestError = error as GoogleRequestError;
  let payload = requestError.json;
  if (!payload && requestError.text) {
    try {
      payload = JSON.parse(requestError.text) as GoogleRequestError["json"];
    } catch {
      // Google can occasionally return a non-JSON proxy or network error.
    }
  }

  return {
    message: payload?.error?.message || requestError.message || "",
    reason: payload?.error?.errors?.[0]?.reason || payload?.error?.details?.[0]?.reason || ""
  };
}

function getElectronShell(): { openExternal(url: string): Promise<void> } {
  const electron = require("electron") as {
    shell: { openExternal(url: string): Promise<void> };
  };
  return electron.shell;
}

function sanitizePathSegment(value: string): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/[. ]+$/g, "")
    .trim();
  const safe = cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "Untitled";
  return safe.slice(0, 100);
}

function escapeMarkdownText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/([`*_\[\]])/g, "\\$1");
}

function docsTextRunToMarkdown(element: DocsParagraphElement): string {
  if (element.textRun) {
    const raw = (element.textRun.content || "").replace(/\n$/, "");
    if (!raw) return "";
    const style = element.textRun.textStyle || {};
    let text = escapeMarkdownText(raw).replace(/\n/g, "  \n");
    if (style.link?.url) text = `[${text}](${style.link.url})`;
    else if (style.link?.tabId) text = `[${text}](#tab-${style.link.tabId})`;
    if (style.strikethrough) text = `~~${text}~~`;
    if (style.italic) text = `_${text}_`;
    if (style.bold) text = `**${text}**`;
    return text;
  }
  if (element.person?.personProperties?.name) {
    return `@${escapeMarkdownText(element.person.personProperties.name)}`;
  }
  if (element.richLink?.richLinkProperties) {
    const richLink = element.richLink.richLinkProperties;
    const label = escapeMarkdownText(richLink.title || richLink.uri || "Link");
    return richLink.uri ? `[${label}](${richLink.uri})` : label;
  }
  if (element.inlineObjectElement) return "![Embedded image]";
  if (element.horizontalRule || element.pageBreak) return "\n---\n";
  return "";
}

function docsParagraphToMarkdown(paragraph: DocsParagraph): string {
  const text = (paragraph.elements || [])
    .map(docsTextRunToMarkdown)
    .join("")
    .replace(/\s+$/, "");
  if (!text) return "";

  if (paragraph.bullet) {
    const depth = Math.max(0, paragraph.bullet.nestingLevel || 0);
    return `${"  ".repeat(depth)}- ${text}\n`;
  }

  const namedStyle = paragraph.paragraphStyle?.namedStyleType || "NORMAL_TEXT";
  const headingLevel = /^HEADING_([1-6])$/.exec(namedStyle)?.[1];
  if (headingLevel) return `${"#".repeat(Number(headingLevel))} ${text}\n\n`;
  if (namedStyle === "TITLE") return `# ${text}\n\n`;
  if (namedStyle === "SUBTITLE") return `_${text}_\n\n`;
  return `${text}\n\n`;
}

function docsStructuralElementsToMarkdown(elements: DocsStructuralElement[]): string {
  const sections: string[] = [];
  for (const element of elements) {
    if (element.paragraph) {
      sections.push(docsParagraphToMarkdown(element.paragraph));
      continue;
    }
    if (element.table) {
      const rows = element.table.tableRows || [];
      const markdownRows = rows.map(row => {
        const cells = (row.tableCells || []).map(cell => docsStructuralElementsToMarkdown(
          cell.content || []
        ).replace(/\s+/g, " ").trim());
        return `| ${cells.join(" | ")} |`;
      });
      if (markdownRows.length) {
        const columnCount = Math.max(1, element.table.tableRows?.[0]?.tableCells?.length || 1);
        markdownRows.splice(1, 0, `| ${Array(columnCount).fill("---").join(" | ")} |`);
        sections.push(`${markdownRows.join("\n")}\n\n`);
      }
      continue;
    }
    if (element.tableOfContents) {
      sections.push(docsStructuralElementsToMarkdown(element.tableOfContents.content || []));
    }
  }
  return sections.join("").replace(/\n{3,}/g, "\n\n");
}

function docsDocumentTabToMarkdown(tab: DocsDocumentTab | undefined): string {
  const markdown = docsStructuralElementsToMarkdown(tab?.body?.content || []).trimEnd();
  return markdown ? `${markdown}\n` : "\n";
}

export class GoogleDriveBridge {
  constructor(
    private readonly app: App,
    private readonly getCredentialsPath: () => string
  ) {}

  getTokenPath(): string {
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(appData, "obsidian-google-ai-hub", "google-oauth.json");
  }

  async hasStoredToken(): Promise<boolean> {
    try {
      const raw = await fs.readFile(this.getTokenPath(), "utf8");
      const token = JSON.parse(raw) as StoredOAuthToken;
      const grantedScopes = new Set((token.scope || "").split(/\s+/).filter(Boolean));
      return GOOGLE_SCOPES.every(scope => grantedScopes.has(scope));
    } catch {
      return false;
    }
  }

  async connect(): Promise<void> {
    const client = await this.readOAuthClient();
    const state = randomBytes(24).toString("hex");
    let settled = false;
    let resolveCode: (code: string) => void = () => undefined;
    let rejectCode: (error: Error) => void = () => undefined;

    const codePromise = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });

    const server = createServer((request, response) => {
      this.handleOAuthCallback(request, response, state, code => {
        if (settled) return;
        settled = true;
        resolveCode(code);
      }, error => {
        if (settled) return;
        settled = true;
        rejectCode(error);
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address() as AddressInfo;
    const redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
    const authUrl = new URL(client.auth_uri || "https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.search = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: GOOGLE_SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      state
    }).toString();

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectCode(new Error("Google authorization timed out."));
    }, 10 * 60 * 1000);

    try {
      await getElectronShell().openExternal(authUrl.toString());
      const code = await codePromise;
      const token = await this.exchangeAuthorizationCode(client, code, redirectUri);
      await this.saveToken(token);
    } finally {
      clearTimeout(timeout);
      server.close();
    }
  }

  async disconnect(): Promise<void> {
    try {
      await fs.unlink(this.getTokenPath());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
  }

  async syncGoogleDocShortcuts(
    rootFolder: string,
    previousShortcuts: Record<string, string>
  ): Promise<ShortcutSyncResult> {
    const [documents, folders] = await Promise.all([
      this.listFiles(`mimeType='${GOOGLE_DOC_MIME}' and trashed=false`, "id,name,parents,modifiedTime,webViewLink"),
      this.listFiles(`mimeType='${GOOGLE_FOLDER_MIME}' and trashed=false`, "id,name,parents")
    ]);
    const folderMap = new Map(folders.map(folder => [folder.id, folder]));
    const shortcuts: Record<string, string> = {};
    const usedPaths = new Set<string>();

    await this.ensureVaultFolder(normalizePath(rootFolder));

    for (const document of documents) {
      const drivePath = this.getDriveFolderPath(document.parents?.[0], folderMap);
      const localFolder = normalizePath([rootFolder, ...drivePath].filter(Boolean).join("/"));
      await this.ensureVaultFolder(localFolder);

      let shortcutPath = normalizePath(`${localFolder}/${sanitizePathSegment(document.name)}.gdoc`);
      if (usedPaths.has(shortcutPath.toLocaleLowerCase())) {
        shortcutPath = normalizePath(
          `${localFolder}/${sanitizePathSegment(document.name)} (${document.id.slice(0, 8)}).gdoc`
        );
      }
      usedPaths.add(shortcutPath.toLocaleLowerCase());

      const oldPath = previousShortcuts[document.id];
      if (oldPath && oldPath !== shortcutPath) {
        const oldFile = this.app.vault.getAbstractFileByPath(oldPath);
        const target = this.app.vault.getAbstractFileByPath(shortcutPath);
        if (oldFile instanceof TFile && !target) {
          await this.app.vault.rename(oldFile, shortcutPath);
        }
      }

      await this.writeShortcut(shortcutPath, document);
      shortcuts[document.id] = shortcutPath;
    }

    return { count: documents.length, shortcuts };
  }

  async publishNote(file: TFile, existing?: NoteMirror): Promise<NoteMirror> {
    const content = await this.app.vault.cachedRead(file);
    const name = `${file.basename} (Obsidian)`;
    return this.publishText(name, content, existing, "obsidian-note");
  }

  async publishText(
    name: string,
    content: string,
    existing?: NoteMirror,
    sourceType = "obsidian-note"
  ): Promise<NoteMirror> {
    const accessToken = await this.getAccessToken();

    if (existing?.id) {
      try {
        await this.updateGoogleDoc(accessToken, existing.id, name, content);
        return {
          id: existing.id,
          name,
          webViewLink: `https://docs.google.com/document/d/${existing.id}/edit`,
          modifiedTime: Date.now()
        };
      } catch {
        // The mirror may have been removed from Drive. Recreate it below.
      }
    }

    const folderId = await this.getOrCreateObsidianNotesFolder(accessToken);
    const created = await this.createGoogleDoc(accessToken, name, content, folderId, sourceType);
    return {
      id: created.id,
      name: created.name || name,
      webViewLink: created.webViewLink || `https://docs.google.com/document/d/${created.id}/edit`,
      modifiedTime: Date.now()
    };
  }

  async exportGoogleDoc(documentId: string): Promise<string> {
    const accessToken = await this.getAccessToken();
    const safeId = encodeURIComponent(documentId);
    try {
      const response = await requestUrl({
        url: `https://www.googleapis.com/drive/v3/files/${safeId}/export?mimeType=text%2Fplain`,
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      if (!response.text.trim()) throw new Error("Google returned an empty document.");
      return response.text;
    } catch {
      throw new Error("Google Drive could not read this document. Reconnect Google Drive in Google AI Hub and approve document read access.");
    }
  }

  async exportGoogleDocMarkdown(documentId: string): Promise<string> {
    const accessToken = await this.getAccessToken();
    const safeId = encodeURIComponent(documentId);
    try {
      const response = await requestUrl({
        url: `https://www.googleapis.com/drive/v3/files/${safeId}/export?mimeType=text%2Fmarkdown`,
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      if (!response.text.trim()) throw new Error("Google returned an empty document.");
      return response.text;
    } catch {
      throw new Error("Google Drive could not export this document as Markdown. Reconnect Google Drive in Google AI Hub and approve document read access.");
    }
  }

  async getGoogleDocTabs(documentId: string): Promise<GoogleDocTabsResult> {
    const accessToken = await this.getAccessToken();
    try {
      const document = await this.getDocsDocument(accessToken, documentId);
      const tabs: GoogleDocTabInfo[] = [];
      const collectTabs = (items: DocsTab[]): void => {
        for (const tab of [...items].sort((left, right) =>
          (left.tabProperties?.index || 0) - (right.tabProperties?.index || 0))) {
          const properties = tab.tabProperties || {};
          if (!properties.tabId) continue;
          tabs.push({
            id: properties.tabId,
            title: properties.title || "Untitled tab",
            parentTabId: properties.parentTabId || "",
            index: properties.index || 0,
            nestingLevel: properties.nestingLevel || 0,
            iconEmoji: properties.iconEmoji || "",
            markdown: docsDocumentTabToMarkdown(tab.documentTab)
          });
          collectTabs(tab.childTabs || []);
        }
      };
      collectTabs(document.tabs || []);
      if (!tabs.length) throw new Error("Google Docs returned no document tabs.");
      return { tabs, nativeTabsAvailable: true };
    } catch (error) {
      const apiError = getGoogleRequestError(error);
      if (
        apiError.reason === "SERVICE_DISABLED"
        || /Docs API.*disabled|status 403/i.test(apiError.message)
      ) {
        const markdown = await this.exportGoogleDocMarkdown(documentId);
        return {
          tabs: [{
            id: "legacy-document",
            title: "Document",
            parentTabId: "",
            index: 0,
            nestingLevel: 0,
            iconEmoji: "",
            markdown
          }],
          nativeTabsAvailable: false,
          warning: "Enable the Google Docs API for OAuth project 194334912349 and reconnect Google Drive once to manage native tabs."
        };
      }
      throw new Error(apiError.message
        ? `Google Docs could not load tabs: ${apiError.message}`
        : "Google Docs could not load this document's tabs.");
    }
  }

  async addGoogleDocTab(
    documentId: string,
    title: string,
    parentTabId = "",
    iconEmoji = "",
    index?: number
  ): Promise<string> {
    const tabProperties: DocsTabProperties = { title };
    if (parentTabId) tabProperties.parentTabId = parentTabId;
    if (iconEmoji) tabProperties.iconEmoji = iconEmoji;
    if (Number.isInteger(index) && (index as number) >= 0) tabProperties.index = index;
    const result = await this.batchUpdateGoogleDoc(documentId, [{
      addDocumentTab: { tabProperties }
    }]);
    return result.replies?.[0]?.addDocumentTab?.tabProperties?.tabId || "";
  }

  async editGoogleDocTab(
    documentId: string,
    tabId: string,
    title: string,
    iconEmoji: string
  ): Promise<void> {
    await this.batchUpdateGoogleDoc(documentId, [{
      updateDocumentTabProperties: {
        tabProperties: { tabId, title, iconEmoji },
        fields: "title,iconEmoji"
      }
    }]);
  }

  async moveGoogleDocTab(
    documentId: string,
    tabId: string,
    parentTabId: string,
    index: number
  ): Promise<void> {
    await this.batchUpdateGoogleDoc(documentId, [{
      updateDocumentTabProperties: {
        tabProperties: { tabId, parentTabId, index },
        fields: "parentTabId,index"
      }
    }]);
  }

  async deleteGoogleDocTab(documentId: string, tabId: string): Promise<void> {
    await this.batchUpdateGoogleDoc(documentId, [{ deleteTab: { tabId } }]);
  }

  async updateGoogleDocTabContent(
    documentId: string,
    tabId: string,
    content: GoogleDocTabContentUpdate
  ): Promise<void> {
    const accessToken = await this.getAccessToken();
    const document = await this.getDocsDocument(accessToken, documentId);
    const findTab = (items: DocsTab[]): DocsTab | null => {
      for (const tab of items) {
        if (tab.tabProperties?.tabId === tabId) return tab;
        const child = findTab(tab.childTabs || []);
        if (child) return child;
      }
      return null;
    };
    const targetTab = findTab(document.tabs || []);
    if (!targetTab) throw new Error("The selected Google Doc tab no longer exists. Refresh the Canvas card.");

    const bodyContent = targetTab.documentTab?.body?.content || [];
    const endIndex = bodyContent.reduce((maximum, element) =>
      Math.max(maximum, element.endIndex || 0), 0);
    const requests: Array<Record<string, unknown>> = [];
    if (endIndex > 2) {
      requests.push({
        deleteContentRange: {
          range: { startIndex: 1, endIndex: endIndex - 1, tabId }
        }
      });
    }

    let text = content.text.replace(/\r\n/g, "\n");
    if (text.trim() && !text.endsWith("\n")) text += "\n";
    if (text.trim()) {
      requests.push({ insertText: { location: { index: 1, tabId }, text } });

      for (const paragraph of content.paragraphStyles) {
        const startIndex = Math.max(0, Math.min(text.length, paragraph.startIndex));
        const end = Math.max(startIndex, Math.min(text.length, paragraph.endIndex));
        if (end <= startIndex) continue;
        requests.push({
          updateParagraphStyle: {
            range: { startIndex: startIndex + 1, endIndex: end + 1, tabId },
            paragraphStyle: {
              namedStyleType: paragraph.namedStyleType,
              ...(paragraph.indentStartPoints
                ? { indentStart: { magnitude: paragraph.indentStartPoints, unit: "PT" } }
                : {})
            },
            fields: paragraph.indentStartPoints ? "namedStyleType,indentStart" : "namedStyleType"
          }
        });
      }

      for (const style of content.textStyles) {
        const startIndex = Math.max(0, Math.min(text.length, style.startIndex));
        const end = Math.max(startIndex, Math.min(text.length, style.endIndex));
        if (end <= startIndex) continue;
        const textStyle: Record<string, unknown> = {};
        const fields: string[] = [];
        if (style.bold) {
          textStyle.bold = true;
          fields.push("bold");
        }
        if (style.italic) {
          textStyle.italic = true;
          fields.push("italic");
        }
        if (style.strikethrough) {
          textStyle.strikethrough = true;
          fields.push("strikethrough");
        }
        if (style.code) {
          textStyle.weightedFontFamily = { fontFamily: "Roboto Mono" };
          fields.push("weightedFontFamily");
        }
        if (style.linkUrl) {
          const internalTab = /^#tab-(.+)$/.exec(style.linkUrl)?.[1];
          textStyle.link = internalTab ? { tabId: internalTab } : { url: style.linkUrl };
          fields.push("link");
        }
        if (!fields.length) continue;
        requests.push({
          updateTextStyle: {
            range: { startIndex: startIndex + 1, endIndex: end + 1, tabId },
            textStyle,
            fields: fields.join(",")
          }
        });
      }

      for (const bullet of content.bullets) {
        const startIndex = Math.max(0, Math.min(text.length, bullet.startIndex));
        const end = Math.max(startIndex, Math.min(text.length, bullet.endIndex));
        if (end <= startIndex) continue;
        requests.push({
          createParagraphBullets: {
            range: { startIndex: startIndex + 1, endIndex: end + 1, tabId },
            bulletPreset: bullet.preset
          }
        });
      }
    }

    if (requests.length) await this.batchUpdateGoogleDoc(documentId, requests, accessToken);
  }

  async updateGoogleDocMarkdown(documentId: string, markdown: string): Promise<void> {
    const accessToken = await this.getAccessToken();
    const safeId = encodeURIComponent(documentId);
    try {
      await requestUrl({
        url: `https://www.googleapis.com/upload/drive/v3/files/${safeId}?uploadType=media`,
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "text/markdown; charset=UTF-8"
        },
        body: markdown || "\n"
      });
    } catch (error) {
      const apiError = getGoogleRequestError(error);
      if (
        apiError.reason === "appNotAuthorizedToFile"
        || /not granted.*write access/i.test(apiError.message)
      ) {
        throw new Error("Reconnect Google Drive once in Google AI Hub settings to authorize editing existing documents. Your unsaved Canvas text is kept as a local draft.");
      }
      throw new Error(apiError.message
        ? `Google Drive could not save this document: ${apiError.message}`
        : "Google Drive could not save this document. Confirm that you have edit access, then reconnect Google Drive if needed.");
    }
  }

  private async getDocsDocument(
    accessToken: string,
    documentId: string
  ): Promise<DocsDocumentResponse> {
    const safeId = encodeURIComponent(documentId);
    const response = await requestUrl({
      url: `https://docs.googleapis.com/v1/documents/${safeId}?includeTabsContent=true`,
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    return response.json as DocsDocumentResponse;
  }

  private async batchUpdateGoogleDoc(
    documentId: string,
    requests: Array<Record<string, unknown>>,
    existingAccessToken?: string
  ): Promise<DocsBatchUpdateResponse> {
    const accessToken = existingAccessToken || await this.getAccessToken();
    const safeId = encodeURIComponent(documentId);
    try {
      const response = await requestUrl({
        url: `https://docs.googleapis.com/v1/documents/${safeId}:batchUpdate`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ requests })
      });
      return response.json as DocsBatchUpdateResponse;
    } catch (error) {
      const apiError = getGoogleRequestError(error);
      if (apiError.reason === "SERVICE_DISABLED" || /Docs API.*disabled/i.test(apiError.message)) {
        throw new Error("Enable the Google Docs API for OAuth project 194334912349 before managing document tabs.");
      }
      if (/insufficient.*scope|Request had insufficient authentication scopes/i.test(apiError.message)) {
        throw new Error("Reconnect Google Drive in Google AI Hub settings once to authorize Google Docs editing.");
      }
      throw new Error(apiError.message
        ? `Google Docs could not apply this tab change: ${apiError.message}`
        : "Google Docs could not apply this tab change.");
    }
  }

  private handleOAuthCallback(
    request: IncomingMessage,
    response: ServerResponse,
    expectedState: string,
    onCode: (code: string) => void,
    onError: (error: Error) => void
  ): void {
    const callbackUrl = new URL(request.url || "/", "http://127.0.0.1");
    if (callbackUrl.pathname !== "/oauth2callback") {
      response.writeHead(404).end();
      return;
    }

    const returnedState = callbackUrl.searchParams.get("state");
    const code = callbackUrl.searchParams.get("code");
    const oauthError = callbackUrl.searchParams.get("error");

    if (returnedState !== expectedState) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Invalid authorization state. Return to Obsidian and try again.");
      onError(new Error("Google returned an invalid authorization state."));
      return;
    }

    if (oauthError || !code) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Google Drive authorization was not completed. You can close this tab.");
      onError(new Error(`Google authorization failed: ${oauthError || "missing code"}`));
      return;
    }

    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Google AI Hub connected</title><style>body{font:18px system-ui;padding:48px;max-width:680px;margin:auto}</style><h1>Google Drive connected</h1><p>You can close this tab and return to Obsidian.</p>");
    onCode(code);
  }

  private async readOAuthClient(): Promise<OAuthClientDefinition> {
    const credentialsPath = this.getCredentialsPath().trim();
    if (!credentialsPath) throw new Error("Set the Google OAuth credentials file in plugin settings.");

    const raw = await fs.readFile(credentialsPath, "utf8");
    const credentials = JSON.parse(raw) as OAuthCredentialsFile;
    const client = credentials.installed || credentials.web;
    if (!client?.client_id || !client.client_secret) {
      throw new Error("The selected file is not a valid Google OAuth client credentials file.");
    }
    return client;
  }

  private async exchangeAuthorizationCode(
    client: OAuthClientDefinition,
    code: string,
    redirectUri: string
  ): Promise<StoredOAuthToken> {
    const response = await requestUrl({
      url: client.token_uri || "https://oauth2.googleapis.com/token",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: client.client_id,
        client_secret: client.client_secret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code"
      }).toString()
    });
    const token = response.json as TokenResponse;
    if (!token.access_token) {
      throw new Error(token.error_description || token.error || "Google did not return an access token.");
    }
    return {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: Date.now() + (token.expires_in || 3600) * 1000,
      scope: token.scope,
      token_type: token.token_type
    };
  }

  private async getAccessToken(): Promise<string> {
    const token = await this.loadToken();
    if (token.access_token && token.expires_at > Date.now() + 60_000) return token.access_token;
    if (!token.refresh_token) throw new Error("Reconnect Google Drive to refresh access.");

    const client = await this.readOAuthClient();
    const response = await requestUrl({
      url: client.token_uri || "https://oauth2.googleapis.com/token",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: client.client_id,
        client_secret: client.client_secret,
        refresh_token: token.refresh_token,
        grant_type: "refresh_token"
      }).toString()
    });
    const refreshed = response.json as TokenResponse;
    if (!refreshed.access_token) {
      throw new Error(refreshed.error_description || "Google Drive access expired. Reconnect in settings.");
    }

    const updated: StoredOAuthToken = {
      ...token,
      access_token: refreshed.access_token,
      expires_at: Date.now() + (refreshed.expires_in || 3600) * 1000,
      scope: refreshed.scope || token.scope,
      token_type: refreshed.token_type || token.token_type
    };
    await this.saveToken(updated);
    return updated.access_token;
  }

  private async loadToken(): Promise<StoredOAuthToken> {
    try {
      const raw = await fs.readFile(this.getTokenPath(), "utf8");
      return JSON.parse(raw) as StoredOAuthToken;
    } catch {
      throw new Error("Google Drive is not connected. Use Connect Google Drive first.");
    }
  }

  private async saveToken(token: StoredOAuthToken): Promise<void> {
    const path = this.getTokenPath();
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, JSON.stringify(token, null, 2), { encoding: "utf8", mode: 0o600 });
  }

  private async listFiles(query: string, fields: string): Promise<DriveFile[]> {
    const accessToken = await this.getAccessToken();
    const files: DriveFile[] = [];
    let pageToken = "";

    do {
      const params = new URLSearchParams({
        q: query,
        spaces: "drive",
        pageSize: "1000",
        orderBy: "name_natural",
        fields: `nextPageToken,files(${fields})`
      });
      if (pageToken) params.set("pageToken", pageToken);
      const response = await requestUrl({
        url: `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const page = response.json as DriveListResponse;
      files.push(...(page.files || []));
      pageToken = page.nextPageToken || "";
    } while (pageToken);

    return files;
  }

  private getDriveFolderPath(
    parentId: string | undefined,
    folderMap: Map<string, DriveFile>
  ): string[] {
    const path: string[] = [];
    const seen = new Set<string>();
    let currentId = parentId;

    while (currentId && currentId !== "root" && !seen.has(currentId) && path.length < 20) {
      seen.add(currentId);
      const folder = folderMap.get(currentId);
      if (!folder) break;
      path.unshift(sanitizePathSegment(folder.name));
      currentId = folder.parents?.[0];
    }
    return path;
  }

  private async ensureVaultFolder(path: string): Promise<void> {
    if (!path) return;
    const segments = normalizePath(path).split("/").filter(Boolean);
    let current = "";
    for (const segment of segments) {
      current = normalizePath(current ? `${current}/${segment}` : segment);
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  private async writeShortcut(path: string, document: DriveFile): Promise<void> {
    const content = JSON.stringify({
      url: document.webViewLink || `https://docs.google.com/document/d/${document.id}/edit`,
      doc_id: document.id,
      resource_id: `document:${document.id}`
    }, null, 2);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      const current = await this.app.vault.read(existing);
      if (current !== content) await this.app.vault.modify(existing, content);
    } else if (!existing) {
      await this.app.vault.create(path, content);
    }
  }

  private async getOrCreateObsidianNotesFolder(accessToken: string): Promise<string> {
    const query = [
      `mimeType='${GOOGLE_FOLDER_MIME}'`,
      "trashed=false",
      "appProperties has { key='googleAiHub' and value='obsidian-notes-folder' }"
    ].join(" and ");
    const existing = await this.listFiles(query, "id,name");
    if (existing[0]?.id) return existing[0].id;

    const response = await requestUrl({
      url: "https://www.googleapis.com/drive/v3/files?fields=id,name",
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        name: "Obsidian Notes",
        mimeType: GOOGLE_FOLDER_MIME,
        appProperties: { googleAiHub: "obsidian-notes-folder" }
      })
    });
    const folder = response.json as DriveFileResponse;
    if (!folder.id) throw new Error(folder.error?.message || "Could not create the Obsidian Notes folder in Drive.");
    return folder.id;
  }

  private async createGoogleDoc(
    accessToken: string,
    name: string,
    content: string,
    parentId: string,
    sourceType: string
  ): Promise<DriveFileResponse> {
    const boundary = `google_ai_hub_${randomBytes(12).toString("hex")}`;
    const metadata = {
      name,
      mimeType: GOOGLE_DOC_MIME,
      parents: [parentId],
      appProperties: { googleAiHub: sourceType }
    };
    const body = [
      `--${boundary}`,
      "Content-Type: application/json; charset=UTF-8",
      "",
      JSON.stringify(metadata),
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "",
      content,
      `--${boundary}--`,
      ""
    ].join("\r\n");

    const response = await requestUrl({
      url: "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink",
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`
      },
      body
    });
    const document = response.json as DriveFileResponse;
    if (!document.id) throw new Error(document.error?.message || "Could not publish the Obsidian note to Google Docs.");
    return document;
  }

  private async updateGoogleDoc(
    accessToken: string,
    fileId: string,
    name: string,
    content: string
  ): Promise<void> {
    const safeId = encodeURIComponent(fileId);
    await requestUrl({
      url: `https://www.googleapis.com/drive/v3/files/${safeId}`,
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ name })
    });
    await requestUrl({
      url: `https://www.googleapis.com/upload/drive/v3/files/${safeId}?uploadType=media`,
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "text/plain; charset=UTF-8"
      },
      body: content
    });
  }
}

export interface SourceLoadResult {
  ok: boolean;
  message: string;
  mode?: "gemini-prompt" | "notebooklm-source" | "notebooklm-dialog";
}

export function buildGeminiLoaderScript(title: string, content: string): string {
  const payload = JSON.stringify({ title, content });
  return `
(async () => {
  const payload = ${payload};
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const visible = element => {
    if (!element?.getClientRects().length) return false;
    const view = element.ownerDocument?.defaultView || window;
    const style = view.getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none";
  };
  const deepElements = () => {
    const roots = [document];
    const elements = [];
    for (let index = 0; index < roots.length; index += 1) {
      const root = roots[index];
      for (const element of root.querySelectorAll("*")) {
        elements.push(element);
        if (element.shadowRoot) roots.push(element.shadowRoot);
        if (element.tagName === "IFRAME") {
          try {
            if (element.contentDocument) roots.push(element.contentDocument);
          } catch (_) {
            // Cross-origin frames cannot be inspected, but Gemini's editor is in the main page.
          }
        }
      }
    }
    return elements;
  };
  const editorScore = element => {
    const tag = element.tagName?.toLowerCase() || "";
    const editable = element.getAttribute?.("contenteditable") === "true" || element.isContentEditable;
    const textbox = element.getAttribute?.("role") === "textbox";
    if (tag !== "textarea" && tag !== "input" && !editable && !textbox) return -1;
    const label = [
      element.getAttribute?.("aria-label") || "",
      element.getAttribute?.("placeholder") || "",
      element.getAttribute?.("data-placeholder") || "",
      element.getAttribute?.("class") || ""
    ].join(" ").toLowerCase();
    if (/search|filter|address/.test(label)) return -1;
    let score = 0;
    if (/enter a prompt|ask gemini|prompt/.test(label)) score += 100;
    if (/ql-editor|textarea|input-area/.test(label)) score += 30;
    if (editable || textbox) score += 20;
    if (tag === "textarea") score += 10;
    const rect = element.getBoundingClientRect?.();
    if (rect && rect.width > 250 && rect.height > 30) score += 10;
    return score;
  };
  const setNativeValue = (element, value) => {
    const view = element.ownerDocument.defaultView || window;
    const prototype = element.tagName === "TEXTAREA"
      ? view.HTMLTextAreaElement.prototype
      : view.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
  };
  const readValue = element => "value" in element
    ? element.value
    : (element.innerText || element.textContent || "");
  const normalized = value => String(value || "").replace(/\\s+/g, " ").trim();

  let editor = null;
  for (let attempt = 0; attempt < 80 && !editor; attempt += 1) {
    const candidates = deepElements()
      .filter(visible)
      .map(element => ({ element, score: editorScore(element) }))
      .filter(candidate => candidate.score >= 0)
      .sort((left, right) => right.score - left.score);
    editor = candidates[0]?.element || null;
    if (!editor) await sleep(250);
  }

  if (!editor) {
    return { ok: false, message: "Gemini's prompt is not available. Sign in, then try the source action again." };
  }

  editor.focus();
  if (editor.tagName === "TEXTAREA" || editor.tagName === "INPUT") {
    setNativeValue(editor, payload.content);
  } else {
    const ownerDocument = editor.ownerDocument;
    const selection = ownerDocument.getSelection();
    const range = ownerDocument.createRange();
    range.selectNodeContents(editor);
    selection?.removeAllRanges();
    selection?.addRange(range);
    const inserted = ownerDocument.execCommand?.("insertText", false, payload.content);
    if (!inserted || !normalized(readValue(editor))) {
      editor.replaceChildren(ownerDocument.createTextNode(payload.content));
    }
  }
  editor.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    inputType: "insertText",
    data: payload.content
  }));
  editor.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(400);

  const expected = normalized(payload.content).slice(0, 80);
  const actual = normalized(readValue(editor));
  if (!actual.includes(expected)) {
    return {
      ok: false,
      message: "Gemini's prompt was found, but Gemini did not accept the note text. Try the source action once more."
    };
  }

  return {
    ok: true,
    mode: "gemini-prompt",
    message: payload.title + " is loaded in Gemini's prompt. Review it and add your question before sending."
  };
})()
`;
}

export function buildNotebookLmLoaderScript(title: string, content: string): string {
  const payload = JSON.stringify({ title, content: `# ${title}\n\n${content}` });
  return `
(async () => {
  const payload = ${payload};
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const visible = element => Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== "hidden");
  const label = element => [
    element.getAttribute?.("aria-label") || "",
    element.getAttribute?.("title") || "",
    element.textContent || ""
  ].join(" ").replace(/\\s+/g, " ").trim();
  const clickable = root => Array.from(root.querySelectorAll('button, [role="button"], mat-card, .mat-mdc-card'))
    .filter(visible);

  let addSource = null;
  for (let attempt = 0; attempt < 32 && !addSource; attempt += 1) {
    addSource = clickable(document).find(element => /add source/i.test(label(element))) || null;
    if (!addSource) await sleep(250);
  }
  if (!addSource) {
    return {
      ok: false,
      message: "Open the NotebookLM notebook that should receive this source, then run the source action again."
    };
  }
  addSource.click();

  let copiedText = null;
  for (let attempt = 0; attempt < 32 && !copiedText; attempt += 1) {
    const dialog = document.querySelector('[role="dialog"], mat-dialog-container, .mat-mdc-dialog-container') || document;
    copiedText = clickable(dialog).find(element => /copied text|paste text/i.test(label(element))) || null;
    if (!copiedText) await sleep(250);
  }
  if (!copiedText) {
    return { ok: false, message: "NotebookLM opened the source picker, but Copied text was not available." };
  }
  copiedText.click();

  let editor = null;
  let dialog = null;
  for (let attempt = 0; attempt < 40 && !editor; attempt += 1) {
    dialog = document.querySelector('[role="dialog"], mat-dialog-container, .mat-mdc-dialog-container') || document;
    const candidates = Array.from(dialog.querySelectorAll('textarea, [contenteditable="true"][role="textbox"], [contenteditable="true"]'));
    editor = candidates.find(visible) || null;
    if (!editor) await sleep(250);
  }
  if (!editor) {
    return { ok: false, message: "NotebookLM opened Copied text, but its text box was not available." };
  }

  editor.focus();
  if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
    const prototype = editor instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(editor, payload.content);
    else editor.value = payload.content;
  } else {
    editor.replaceChildren(document.createTextNode(payload.content));
  }
  editor.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    inputType: "insertText",
    data: payload.content
  }));
  editor.dispatchEvent(new Event("change", { bubbles: true }));

  let insertButton = null;
  for (let attempt = 0; attempt < 24 && !insertButton; attempt += 1) {
    dialog = document.querySelector('[role="dialog"], mat-dialog-container, .mat-mdc-dialog-container') || document;
    insertButton = clickable(dialog).find(element => /^(insert|add source|save)$/i.test(label(element)) && !element.disabled) || null;
    if (!insertButton) await sleep(250);
  }
  if (!insertButton) {
    return {
      ok: true,
      mode: "notebooklm-dialog",
      message: payload.title + " is loaded in NotebookLM's Copied text dialog. Click Insert to finish adding it."
    };
  }

  insertButton.click();
  return {
    ok: true,
    mode: "notebooklm-source",
    message: payload.title + " was added to NotebookLM as a Copied text source."
  };
})()
`;
}

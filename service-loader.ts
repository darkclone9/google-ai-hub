export interface SourceLoadResult {
  ok: boolean;
  message: string;
  mode?: "gemini-prompt" | "notebooklm-source" | "notebooklm-dialog" | "notebooklm-clipboard";
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
  const visible = element => {
    if (!element?.getClientRects?.().length) return false;
    const view = element.ownerDocument?.defaultView || window;
    const style = view.getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || "1") > 0;
  };
  const deepElements = () => {
    const roots = [document];
    const elements = [];
    for (let index = 0; index < roots.length; index += 1) {
      const root = roots[index];
      for (const element of root.querySelectorAll?.("*") || []) {
        elements.push(element);
        if (element.shadowRoot) roots.push(element.shadowRoot);
        if (element.tagName === "IFRAME") {
          try {
            if (element.contentDocument) roots.push(element.contentDocument);
          } catch (_) {
            // Ignore cross-origin frames. NotebookLM currently renders controls in the main document.
          }
        }
      }
    }
    return elements;
  };
  const label = element => [
    element.getAttribute?.("aria-label") || "",
    element.getAttribute?.("title") || "",
    element.getAttribute?.("placeholder") || "",
    element.innerText || element.textContent || ""
  ].join(" ").replace(/\\s+/g, " ").trim();
  const normalized = value => String(value || "").replace(/\\s+/g, " ").trim();
  const disabled = element => Boolean(
    element.disabled
    || element.getAttribute?.("aria-disabled") === "true"
    || element.classList?.contains("mat-mdc-button-disabled")
  );
  const clickable = () => deepElements().filter(element =>
    visible(element)
    && !disabled(element)
    && (element.matches?.('button, [role="button"], mat-card, .mat-mdc-card, [tabindex="0"]'))
  );
  const dialogElement = () => deepElements().find(element =>
    visible(element)
    && (element.getAttribute?.("role") === "dialog"
      || element.matches?.("mat-dialog-container, .mat-mdc-dialog-container"))
  ) || null;
  const inside = (element, root) => !root || root === element || root.contains?.(element);
  const findClickable = (pattern, root = null) => clickable()
    .filter(element => inside(element, root) && pattern.test(label(element)))
    .sort((left, right) => normalized(label(left)).length - normalized(label(right)).length)[0] || null;
  const readValue = element => "value" in element
    ? element.value
    : (element.innerText || element.textContent || "");
  const setNativeValue = (element, value) => {
    const view = element.ownerDocument?.defaultView || window;
    const tag = element.tagName?.toLowerCase();
    const prototype = tag === "textarea"
      ? view.HTMLTextAreaElement?.prototype
      : view.HTMLInputElement?.prototype;
    const setter = prototype && Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
  };
  const dispatchInput = (element, value) => {
    const view = element.ownerDocument?.defaultView || window;
    try {
      element.dispatchEvent(new view.InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: value
      }));
    } catch (_) {
      // Older embedded Chromium builds may not construct beforeinput directly.
    }
    try {
      element.dispatchEvent(new view.InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: value
      }));
    } catch (_) {
      element.dispatchEvent(new view.Event("input", { bubbles: true }));
    }
    element.dispatchEvent(new view.Event("change", { bubbles: true }));
  };
  const fillEditor = (element, value) => {
    element.focus();
    const tag = element.tagName?.toLowerCase();
    if (tag === "textarea" || tag === "input") {
      setNativeValue(element, value);
      if (element.setSelectionRange) element.setSelectionRange(value.length, value.length);
      dispatchInput(element, value);
      return;
    }
    const ownerDocument = element.ownerDocument || document;
    const selection = ownerDocument.getSelection();
    const range = ownerDocument.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
    const inserted = ownerDocument.execCommand?.("insertText", false, value);
    if (!inserted || !normalized(readValue(element))) {
      element.replaceChildren(ownerDocument.createTextNode(value));
    }
    dispatchInput(element, value);
  };

  let addSource = null;
  for (let attempt = 0; attempt < 48 && !addSource; attempt += 1) {
    addSource = findClickable(/add source|add sources|upload source|^\\+?\\s*add$/i);
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
  for (let attempt = 0; attempt < 48 && !copiedText; attempt += 1) {
    const dialog = dialogElement();
    copiedText = findClickable(/copied text|paste text|text from clipboard/i, dialog) || null;
    if (!copiedText) await sleep(250);
  }
  if (!copiedText) {
    return { ok: false, message: "NotebookLM opened the source picker, but Copied text was not available." };
  }
  copiedText.click();

  let editor = null;
  let dialog = null;
  for (let attempt = 0; attempt < 60 && !editor; attempt += 1) {
    dialog = dialogElement();
    const candidates = deepElements()
      .filter(element => inside(element, dialog) && visible(element))
      .filter(element => element.matches?.('textarea, [role="textbox"], [contenteditable="true"], .ProseMirror'))
      .map(element => {
        const text = label(element).toLowerCase();
        const rect = element.getBoundingClientRect?.();
        let score = 0;
        if (/paste|copied text|source text|text content/.test(text)) score += 100;
        if (element.tagName === "TEXTAREA") score += 60;
        if (element.isContentEditable || element.getAttribute?.("contenteditable") === "true") score += 45;
        if (element.getAttribute?.("role") === "textbox") score += 25;
        if (rect && rect.width > 300 && rect.height > 100) score += 50;
        if (/title|search|url|website/.test(text)) score -= 150;
        return { element, score };
      })
      .sort((left, right) => right.score - left.score);
    editor = candidates[0]?.score >= 0 ? candidates[0].element : null;
    if (!editor) await sleep(250);
  }
  if (!editor) {
    return { ok: false, message: "NotebookLM opened Copied text, but its text box was not available." };
  }

  const titleInput = deepElements().find(element =>
    inside(element, dialog)
    && visible(element)
    && element.matches?.('input[type="text"], input:not([type])')
    && /title|source name/.test(label(element).toLowerCase())
  );
  if (titleInput) {
    setNativeValue(titleInput, payload.title);
    dispatchInput(titleInput, payload.title);
  }

  fillEditor(editor, payload.content);
  await sleep(500);

  const expected = normalized(payload.content);
  const actual = normalized(readValue(editor));
  const fingerprint = expected.slice(0, Math.min(100, expected.length));
  const minimumLength = Math.min(expected.length, 160);
  if (!actual.includes(fingerprint) || actual.length < minimumLength) {
    editor.focus();
    return {
      ok: false,
      mode: "notebooklm-clipboard",
      message: "NotebookLM opened Copied text but rejected automatic input. The text box is focused and the full source is on your clipboard; press Ctrl+V, verify the text appears, then click Insert."
    };
  }

  let insertButton = null;
  for (let attempt = 0; attempt < 40 && !insertButton; attempt += 1) {
    dialog = dialogElement();
    insertButton = findClickable(/^(insert|add|add source|save|submit)$/i, dialog);
    if (!insertButton) await sleep(250);
  }
  if (!insertButton) {
    return {
      ok: false,
      mode: "notebooklm-dialog",
      message: payload.title + " is loaded and verified in NotebookLM's Copied text dialog, but the Insert button could not be activated. Click Insert to finish adding it."
    };
  }

  insertButton.click();
  let submitted = false;
  for (let attempt = 0; attempt < 60 && !submitted; attempt += 1) {
    await sleep(250);
    const activeDialog = dialogElement();
    const pageLabels = deepElements().filter(visible).map(label);
    submitted = !editor.isConnected
      || !visible(editor)
      || (activeDialog && !inside(editor, activeDialog))
      || !activeDialog
      || pageLabels.some(text => /source added|adding source|processing source|uploading source/i.test(text));
  }
  if (!submitted) {
    return {
      ok: false,
      mode: "notebooklm-dialog",
      message: "NotebookLM received the source text, but did not confirm the insertion. The content remains in the dialog and on your clipboard; click Insert once and confirm the new source appears."
    };
  }
  return {
    ok: true,
    mode: "notebooklm-source",
    message: payload.title + " was submitted to NotebookLM with its copied text verified before insertion."
  };
})()
`;
}

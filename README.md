# Google AI Hub for Obsidian

Google AI Hub adds desktop Obsidian tabs for NotebookLM, Gemini, Google Drive, and native Google Docs.

It indexes native Google Docs as `.gdoc` shortcuts in Obsidian's Files view. Right-click any Markdown note, folder, or `.gdoc` shortcut and select **Use note/folder/Google Doc in Gemini** or **Use note/folder/Google Doc in NotebookLM**.

## Source loading

The plugin loads sources rather than merely opening the destination:

1. Gemini receives the formatted source directly in its prompt. The plugin does not submit the prompt.
2. NotebookLM receives the source through its **Copied text** workflow in the currently open notebook.
3. Folders recursively combine every nested Markdown note into one source.
4. Google Doc shortcuts export the existing document text instead of creating duplicates.
5. Every source is also copied to the clipboard as a fallback.

NotebookLM requires an open destination notebook. If no notebook is open, open one and run the source action again.

## Google Drive connection

1. Open **Google AI Hub** from the ribbon.
2. Select **Connect Google Drive**.
3. Complete Google's consent screen in the system browser.
4. Return to Obsidian. The generated `Google Docs` folder will appear in Files.

The connection requests Google Docs edit access, read-only Drive access for indexing/export, and `drive.file` access for documents created by the plugin. This is narrower than full Google Drive access while still allowing the Canvas editor to update existing Docs. Upgrading from an earlier version requires reconnecting once to approve Google Docs write access.

Native tab management also requires the Google Docs API to be enabled for the OAuth client project. Until it is enabled, Canvas cards continue to show the full-document fallback preview and keep tab-management controls disabled. Text typed into that fallback stays in a local draft; the plugin does not attempt a Drive save or discard the draft while Docs authorization is unavailable.

The plugin never stores a Google password or Gemini API key. The Google Drive refresh token is stored locally under `%APPDATA%\obsidian-google-ai-hub`, outside the synced vault. Embedded Google pages keep their own Obsidian web session.

## Commands

- `Google AI Hub: Open Google AI Hub`
- `Google AI Hub: Open NotebookLM`
- `Google AI Hub: Open Gemini`
- `Google AI Hub: Open Google Drive and Docs`
- `Google AI Hub: Use active note in Gemini`
- `Google AI Hub: Use active note in NotebookLM`
- `Google AI Hub: Choose a vault source for Gemini`
- `Google AI Hub: Choose a vault source for NotebookLM`
- `Google AI Hub: Publish active note to Google Docs`
- `Google AI Hub: Refresh Google Docs folder`

## Google Docs in Obsidian

After connecting, the plugin mirrors the Drive folder structure under `Google Docs` using lightweight `.gdoc` shortcut files. The enabled GDocs community plugin opens those shortcuts as editable Google Docs tabs inside Obsidian.

### Canvas previews

When a Google Doc shortcut is added to an Obsidian Canvas, Google AI Hub renders the document text directly in an editable card. Click and drag normally to select text, then use the Obsidian-styled toolbar for paragraph and heading styles, quotes, code blocks, bold, italic, strikethrough, and lists. Those structures are mapped to native Google Docs formatting when the tab saves. Changes autosave after a short pause; use **Save** or `Ctrl+S` to save immediately, and use **Link** or `Ctrl+K` to create a hyperlink. `Ctrl+click` follows an existing link while normal clicks position the editing caret.

Editing existing Google Docs requires a one-time Google Drive reconnection after installing this version so the local plugin can request document write access. If a save is rejected or the plugin reloads, the current Canvas text is retained as a local draft and restored until it saves successfully.

The Canvas card has a native Google Docs tab strip. Click a tab to edit its content independently, click **+** to add a root tab, double-click a tab to change its title or emoji, and right-click it to add a child, reorder, nest, outdent, or delete it. Drag a tab out onto an empty Canvas location to create a sibling tab above or below it and place a new card pinned to that tab. Deleting a tab always opens a confirmation and warns when nested tabs will also be removed.

## Development

```powershell
npm install
npm run build
```

Install `manifest.json`, `main.js`, and `styles.css` in:

```text
<vault>/.obsidian/plugins/google-ai-hub/
```

# Google AI Hub for Obsidian

Google AI Hub brings editable Google Docs tabs, Gemini document tools, grounded research, and NotebookLM Studio launchers into desktop Obsidian.

![Google AI Hub with neutral demo content](docs/google-ai-hub-0.7.svg)

## Highlights

- Edit a Google Doc tab directly inside an Obsidian Canvas card with headings, lists, emphasis, links, quotes, and code formatting.
- Create, rename, reorder, nest, outdent, and delete native Google Docs tabs. Every open card for the document refreshes its tab strip immediately while keeping its own active tab and draft.
- Summarize, shorten, lengthen, or elaborate a selection or whole document through Gemini with an Original/Result review before anything is changed.
- Use the same AI workflow in Markdown notes, Canvas Google Doc tabs, and standalone `.gdoc` shortcuts.
- Research the active source in AI Hub with a summary, briefing report, grounded chat, and NotebookLM Studio launchers.
- Index Google Drive documents as lightweight `.gdoc` shortcuts without duplicating their contents in the vault.

## Requirements

- Desktop Obsidian 1.11.4 or newer.
- A Google Cloud desktop OAuth client with the Google Drive API and Google Docs API enabled.
- A Gemini API key for direct document AI. Availability, quota, and billing depend on the Google account and model being used.
- An open NotebookLM notebook for NotebookLM source and Studio workflows.

## Installation

### From source

```powershell
npm install
npm run test
npm run build
```

Copy `manifest.json`, `main.js`, and `styles.css` into:

```text
<vault>/.obsidian/plugins/google-ai-hub/
```

Enable **Google AI Hub** in **Settings > Community plugins**. This repository does not require a separate GitHub Pages site.

## Google OAuth and Docs API setup

1. Create or select a project in Google Cloud Console.
2. Enable both **Google Drive API** and **Google Docs API**.
3. Configure the OAuth consent screen for your account.
4. Create an OAuth client with application type **Desktop app** and download its JSON credentials.
5. In Obsidian, open **Settings > Google AI Hub**, set the credentials file path, and select **Connect Google Drive**.
6. Complete consent in the system browser. Reconnect after an upgrade if Google asks for newly required Docs edit access.

The plugin requests Google Docs edit access, Drive read access for indexing/export, and `drive.file` access for files it creates. The refresh token is stored under the local application-data directory, outside the vault.

## Gemini key setup

1. Create a Gemini API key in Google AI Studio.
2. Open **Settings > Google AI Hub > Gemini document AI**.
3. Paste the key into **Gemini API key**.
4. Leave the model at `gemini-3.5-flash` or enter another model available to your account.

The key is stored through Obsidian Secret Storage. It is never written to `data.json` or logged. Developers may instead set `GEMINI_API_KEY`; Secret Storage takes precedence when both exist. See Google's [Gemini API key guide](https://ai.google.dev/gemini-api/docs/api-key) and [model reference](https://ai.google.dev/gemini-api/docs/models).

## Supported sources

| Source | AI scope | Write-back |
| --- | --- | --- |
| Markdown note | Selection first, otherwise whole note | Replace or insert below |
| Canvas Google Doc card | Selection first, otherwise active tab | Replace or insert below, then save to Google Docs |
| Standalone `.gdoc` shortcut | Chosen Google Doc tab | Replace or insert below |
| Folder in AI Hub | All nested Markdown notes | Read-only research source |

Sources over 200,000 characters are rejected with an actionable message and are never silently truncated.

## Document AI workflow

Use the **AI** dropdown in a Canvas card, the Markdown command palette or editor context menu, or a `.gdoc` file context menu.

- **Summarize** keeps essential facts at about 25-35% of the source length.
- **Shorten** removes repetition and targets about 60%.
- **Lengthen** expands to about 150-180% without inventing facts.
- **Elaborate** adds clearer supported explanation while preserving established names and canon.

Every transformation opens an Original/Result preview with **Replace**, **Insert below**, **Copy**, **Regenerate**, and **Cancel**. A source hash is captured before generation. If the document changes while Gemini is responding, write actions are disabled and Copy remains available.

Missing keys, authentication failures, quota errors, blocked responses, oversized sources, and network errors leave the source untouched.

## Canvas editor and synchronized tabs

Add a `.gdoc` shortcut to Canvas to get a native Obsidian editor instead of an unreadable embedded page. Empty tabs show a temporary formatting guide that disappears on the first input and is never saved to Google Docs.

- Select text normally with click-and-drag.
- Use **Paragraph** for headings, quotes, and code; **B/I/S** for emphasis; **•/1.** for lists; and **Link** or `Ctrl+K` for links.
- Use **Save** or `Ctrl+S` to save immediately; otherwise changes autosave after a short pause.
- Use **+** for a root tab, double-click a tab to rename it, and right-click for move, nesting, outdent, child, and delete actions.
- Drag a tab into an empty Canvas location to create a sibling above or below it. The new card points to the new native Google Docs tab, not a Markdown mirror.
- Creating or changing a tab broadcasts a document-scoped refresh to every open card. Other cards retain their active tab, caret, selection, and unsaved draft.

Local draft recovery protects edits if Google rejects a save or Obsidian reloads before the request succeeds.

## AI Hub and NotebookLM

AI Hub starts with the active document when possible. Use **Choose source** to select one Markdown note, folder, Google Doc, or Google Doc tab.

- **Summary** generates a direct grounded result with Copy and Insert actions.
- **Briefing report** uses the complete Original/Result preview workflow.
- **Grounded chat** answers from the selected source. History is session-only and resets when the source changes.
- **Add as source**, **Mind Map**, and **Audio Overview** load the source into the open NotebookLM notebook and focus the requested Studio area without automatically starting generation.

NotebookLM is kept as an embedded research and Studio surface because it does not provide this plugin a reliable editor-result API. Its web interface can change, an open destination notebook is required, and Studio controls may need to be selected manually when NotebookLM cannot be focused automatically. Direct editor transformations use Gemini's REST API so their returned text can be reviewed safely. Google's [NotebookLM feature guide](https://support.google.com/notebooklm/answer/16206563) describes the available Studio outputs.

## Privacy

- Document text is sent to Gemini only after an explicit AI action.
- NotebookLM receives a selected source only after an explicit Studio/source action.
- Gemini keys use Obsidian Secret Storage.
- Google OAuth refresh tokens are stored outside the vault.
- Google passwords are never stored by the plugin.
- Grounded-chat history stays in memory for the current AI Hub session and is not serialized.

## Troubleshooting

### Google Docs saves return 403

Enable the Google Docs API for the OAuth project, confirm that the signed-in account can edit the document, then reconnect Google Drive in plugin settings so the current scopes are approved.

### Native tabs say setup is needed

Confirm that the Google Docs API is enabled and reconnect. The Canvas editor retains text as a local draft until tab editing is available.

### Gemini says the key is missing or invalid

Re-enter the key in Obsidian Secret Storage, verify that the configured model is available to the key, and check Gemini quota or billing. The source is not modified on failure.

### NotebookLM did not add or focus the source

Open the intended notebook inside the embedded NotebookLM view and run the action again. The prepared source is also copied by the legacy source workflow when automatic insertion is unavailable.

### An AI result cannot be applied

The source changed while Gemini was responding. Copy the result or regenerate it from the current source.

## Commands

- `Google AI Hub: Open Google AI Hub`
- `Google AI Hub: Open NotebookLM`
- `Google AI Hub: Open Gemini`
- `Google AI Hub: Open Google Drive and Docs`
- `Google AI Hub: AI: Summarize selection or note`
- `Google AI Hub: AI: Shorten selection or note`
- `Google AI Hub: AI: Lengthen selection or note`
- `Google AI Hub: AI: Elaborate selection or note`
- `Google AI Hub: Use active note in Gemini`
- `Google AI Hub: Use active note in NotebookLM`
- `Google AI Hub: Choose a vault source for Gemini`
- `Google AI Hub: Choose a vault source for NotebookLM`
- `Google AI Hub: Publish active note to Google Docs`
- `Google AI Hub: Refresh Google Docs folder`

## Development

```powershell
npm install
npm run test
npm run build
```

Vitest covers prompt contracts, response cleanup, Secret Storage/environment key precedence, stale-source protection, and document-scoped tab notifications. Keep credentials, OAuth tokens, vault content, test output, and built artifacts outside commits.

## License

[MIT](LICENSE)

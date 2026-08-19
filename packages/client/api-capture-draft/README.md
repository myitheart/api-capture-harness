# API Capture draft bridge

English | [中文](README.zh.md)

This dual-face Web plugin accepts a product or developer capture as an editable Prompt and places it in the native DeepSeek Harness composer. Developer drafts target the current project Session; product drafts create an independent `api-capture-analysis` Session whose cwd is the managed analysis directory and whose permission preset is Read Only. It never submits the Prompt and does not add a second task, approval, Worktree, or commit workflow.

## Model Experience

Indirectly, through the Prompt that the user reviews and sends from the native composer.

#### KV Cache effect

Creating or opening a draft has no effect; only the user's later submission adds the reviewed Prompt to model history.

## Known Limitations and Deferred Work

- **Ephemeral draft storage** — an unopened draft expires after `draftTtlMs` or disappears when the Web Host stops; the extension must create another draft.
- **Ephemeral acknowledgement** — a product draft remains readable until the native composer acknowledges it with `DELETE`; refresh can retry a failed placement without losing the Prompt.
- **Prompt-only request** — `POST /api-capture/drafts` and `POST /api-capture/chat-drafts` accept only `{ "prompt": "..." }`; large evidence belongs in the separate evidence-package API.

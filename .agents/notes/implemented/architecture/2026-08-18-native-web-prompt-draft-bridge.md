# Agent Note: Native Web Prompt draft bridge

Status: implemented

English | [中文](2026-08-18-native-web-prompt-draft-bridge.zh.md)

## Problem

API Capture Assistant records product workflows and developer Network evidence, but a separate Companion task console duplicates Workspace, Session, model, permission, and conversation behavior already provided by DeepSeek Harness. The duplicate interface also turns one editable request into a fixed analysis and approval workflow, preventing users from applying their own Prompt and native Harness capabilities.

## Decision

The Web bundle loads `@deepseek-ai/dsh-client-api-capture-draft` as a dual-face plugin. Its Host face exposes a loopback HTTP endpoint that stores one expiring Prompt in memory and returns a native Harness URL containing an opaque draft id. Its browser face consumes that id, resolves the native Session, and calls the native conversation input service's `setDraft` method.

The bridge never invokes submit. Bringing a capture into Harness therefore creates no model request and gives the user a final opportunity to edit the Prompt, change the model, choose the native permission mode, or abandon the draft. Product and developer evidence differ only in how the Chrome extension prepares their local evidence package and compact Prompt; the draft bridge receives the resulting text without owning those semantics.

Large capture evidence uses a separate Host plugin and protocol, `@deepseek-ai/dsh-host-api-capture-evidence`. The extension declares a complete file set, uploads each file to staging, and finalizes only after every declared byte has arrived. The Host computes SHA-256 while streaming, writes the authoritative `manifest.json`, then atomically publishes an immutable directory under a deployment-owned root. The editable Prompt references only the published `index.md` and optional Network index absolute paths. The draft endpoint remains strict `{ prompt }`; evidence bytes never enter that request.

Completed packages have no automatic expiry because native Sessions can refer to their absolute paths for an indefinite period. A separate local management surface lists, opens, and explicitly deletes them. Incomplete staging transactions are disposable and age out after a configured interval. Package size, file size, file count, metadata size, and staging lifetime are deployment configuration rather than client constants.

The optional Workspace path uses the native Workspace service to open a blank Session. Without a path, the bridge waits for the current native Session. Drafts are single-read, expire after a configured interval, and disappear with the Host process. Browser requests are accepted only from loopback pages and Chrome extension origins.

The Windows release deploys the standard `dsh web` application with this plugin included. The assistant repository contributes only the launcher and release assembly, so users see the original Harness navigation, settings, Session log, composer, tools, permissions, and conversation rendering.

## Alternatives considered

**Maintain a separate Companion console.** This can impose a product-specific workflow, but duplicates native Harness interaction and requires every upstream UI capability to be reimplemented.

**Copy the generated Prompt through the clipboard.** This avoids a Fork extension but makes the handoff manual, loses an explicit connection health check, and provides no reliable way to target the native composer.

**Create and submit a Session through Host RPC.** This reduces clicks but spends tokens before the user can inspect sensitive evidence or add task-specific instructions.

## Consequences

The integration remains small and tracks the native Web application instead of cloning it. Prompt placement and evidence storage have separate versioned protocols, while normal Harness evolution remains available to users. A Host restart discards unopened drafts but retains finalized evidence packages; an invalid Workspace selection can prevent placement, and the capture remains available in the extension for another attempt. The loopback surface intentionally accepts Chrome extension origins. The draft route stores only short-lived text and never submits it, while the evidence route performs constrained filesystem writes only inside its configured root and only for predeclared safe paths.

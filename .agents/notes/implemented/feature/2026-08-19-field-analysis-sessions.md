# Agent Note: Field-analysis sessions without user Workspaces

Status: implemented

English | [中文](2026-08-19-field-analysis-sessions.zh.md)

## Problem

Product captures need native Harness conversation, evidence reading, image inspection, Web lookup, and context compaction without requiring a source-code project. Treating the managed evidence directory as a normal Workspace exposes an implementation detail in the user's project list, while reusing the current project Session mixes unrelated product evidence with code work and can grant mutation tools that the product workflow does not need.

## Decision

**A system Agent Preset defines the analysis capability set.** `api-capture-analysis` keeps natural conversation, `read`, `read_image`, Web search, questions, and compaction, and omits Shell, jobs, goals, Todo, skills, subagents, workflows, and filesystem mutation tools. `tool-fs.enabledTools` makes the read-only tool set part of plugin composition while preserving the full default tool list for existing presets.

**The managed cwd is not a user Workspace.** Analysis Sessions use `API_CAPTURE_ANALYSIS_HOME` as their technical cwd and carry `agentPreset: 'api-capture-analysis'`. The native composer recognizes that preset as sufficient ownership for a blank Session, so it does not block input or display a Workspace picker. The sidebar projects those Sessions into a fixed Field analysis group before real Workspaces.

**Product draft placement is acknowledged after the native composer adopts it.** `POST /api-capture/chat-drafts` stores one Prompt and returns a URL token. The browser creates a new analysis Session, applies `/permission read-only`, opens it, fills the existing composer without sending, and then acknowledges the draft with `DELETE`. A failed placement leaves the token readable for refresh retry. Developer drafts keep the existing current-project route.

## Alternatives considered

**Register the analysis directory as a hidden or synthetic Workspace.** Rejected because Workspace registration owns user project identity, directory operations, ordering, and deletion behavior. Hiding one registered Workspace would make those semantics conditional and leak into every Workspace consumer.

**Append product captures to the current project Session.** Rejected because the user may have no project, product captures are independent conversations, and project permissions can expose code and mutation tools unrelated to the analysis.

**Build a separate chat page or Companion task center.** Rejected because the native Session, composer, model picker, permission display, transcript, and Session Log already provide the required interaction. A second page would duplicate those capabilities and diverge from Harness behavior.

## Consequences

Product capture can open an independent native conversation without selecting or scanning a code project, and the first model request occurs only after the user reviews and sends the Prompt. Analysis Sessions retain native persistence, titles, search, rename, archive, and fork behavior while remaining read-only at the tool composition and permission layers. The fixed group is a projection rather than a Workspace entity, so it cannot participate in Workspace directory actions or drag ordering. The bridge and sidebar depend on the stable preset id and the `chatDraftProtocolVersion` compatibility field.

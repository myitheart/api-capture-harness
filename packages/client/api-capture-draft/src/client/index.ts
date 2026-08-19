/** Browser bridge that places an external prompt into the native Harness composer without sending it. */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

interface ExternalDraft {
  prompt: string
}

interface ExternalChatDraft extends ExternalDraft {
  cwd: string
  agentPreset: 'api-capture-analysis'
}

async function fetchDraft(id: string): Promise<ExternalDraft> {
  const response = await fetch(`/api-capture/drafts/${encodeURIComponent(id)}`)
  if (!response.ok) throw new Error(`API Capture draft request failed with HTTP ${String(response.status)}`)
  return response.json() as Promise<ExternalDraft>
}

async function fetchChatDraft(id: string): Promise<ExternalChatDraft> {
  const response = await fetch(`/api-capture/chat-drafts/${encodeURIComponent(id)}`)
  if (!response.ok) throw new Error(`API Capture chat draft request failed with HTTP ${String(response.status)}`)
  return response.json() as Promise<ExternalChatDraft>
}

async function acknowledgeChatDraft(id: string): Promise<void> {
  const response = await fetch(`/api-capture/chat-drafts/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!response.ok) throw new Error(`API Capture chat draft acknowledgement failed with HTTP ${String(response.status)}`)
}

function clearDraftParameter(): void {
  const url = new URL(window.location.href)
  url.searchParams.delete('apiCaptureDraft')
  url.searchParams.delete('apiCaptureChatDraft')
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
}

const ERROR_ID = 'api-capture-draft-import-error'

function clearImportError(): void {
  document.getElementById(ERROR_ID)?.remove()
}

function showImportError(message: string, retry: () => void): void {
  clearImportError()
  const container = document.createElement('div')
  container.id = ERROR_ID
  container.setAttribute('role', 'alert')
  Object.assign(container.style, {
    position: 'fixed', top: '16px', left: '50%', transform: 'translateX(-50%)', zIndex: '2147483647',
    display: 'flex', alignItems: 'center', gap: '12px', maxWidth: 'min(680px, calc(100vw - 32px))',
    padding: '10px 14px', border: '1px solid #f0b7b7', borderRadius: '10px', background: '#fff7f7',
    color: '#8a1f1f', boxShadow: '0 8px 24px rgba(0,0,0,.12)', fontSize: '13px',
  })
  const text = document.createElement('span')
  text.textContent = `现场分析草稿载入失败：${message}`
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = '重试'
  Object.assign(button.style, { border: '0', borderRadius: '6px', padding: '6px 10px', cursor: 'pointer' })
  button.addEventListener('click', () => {
    clearImportError()
    retry()
  })
  container.append(text, button)
  document.body.append(container)
}

function currentSession(ctx: Context): SessionId | undefined {
  return ctx.sessions.list.getSnapshot().current
}

async function waitForCurrentSession(ctx: Context): Promise<SessionId> {
  const current = currentSession(ctx)
  if (current !== undefined) return current
  return new Promise<SessionId>((resolve) => {
    const unsubscribe = ctx.sessions.list.subscribe(() => {
      const next = currentSession(ctx)
      if (next === undefined) return
      unsubscribe()
      resolve(next)
    })
  })
}

function placeDraft(ctx: Context, sessionId: SessionId, prompt: string): void {
  const binding = ctx.sessions.binding(sessionId)
  if (binding === undefined) throw new Error(`API Capture draft resolved unknown session ${sessionId}`)
  const input = ctx.conversation.input.for(binding.ctx)
  const existing = input.state.getSnapshot().draft
  input.setDraft(existing === '' ? prompt : `${existing}\n\n${prompt}`)
}

async function importChatDraft(ctx: Context, id: string): Promise<void> {
  const draft = await fetchChatDraft(id)
  const sessionId = await ctx.sessions.create({ cwd: draft.cwd, agentPreset: draft.agentPreset })
  const binding = ctx.sessions.binding(sessionId)
  if (binding === undefined) throw new Error(`analysis session ${sessionId} is unavailable`)
  const permission = await binding.session.command('/permission read-only')
  if (!permission.ok) throw new Error(permission.error.message)
  if (!permission.value.matched) throw new Error('read-only permission command is unavailable')
  ctx.sessions.open(sessionId)
  placeDraft(ctx, sessionId, draft.prompt)
  try {
    await acknowledgeChatDraft(id)
  } finally {
    // The prompt is already safely in the composer. Never create a duplicate
    // analysis Session merely because the acknowledgement request was lost.
    clearDraftParameter()
  }
}

/** Consume an API Capture URL draft into the native composer. */
export function apply(ctx: Context): void {
  ctx.inject(['sessions', 'conversation'], (readyCtx) => {
    const id = new URL(window.location.href).searchParams.get('apiCaptureDraft')
    const chatId = new URL(window.location.href).searchParams.get('apiCaptureChatDraft')
    if (chatId !== null && chatId !== '') {
      const retry = (): void => {
        void importChatDraft(readyCtx, chatId).then(clearImportError).catch((error: unknown) => {
          console.error('API Capture chat draft import failed:', error)
          showImportError(error instanceof Error ? error.message : String(error), retry)
        })
      }
      retry()
      return
    }
    if (id !== null && id !== '') {
      void fetchDraft(id).then(async (draft) => {
        clearDraftParameter()
        const sessionId = await waitForCurrentSession(readyCtx)
        placeDraft(readyCtx, sessionId, draft.prompt)
      }).catch((error: unknown) => {
        console.error('API Capture draft import failed:', error)
      })
    }
  })
}

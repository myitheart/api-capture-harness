/** Host-side HTTP bridge that accepts editable prompts for the native Web composer. */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-api-capture-evidence'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'

/** Draft bridge deployment options. */
export interface Config {
  /** Maximum UTF-8 request body size. */
  maxBodyBytes: number
  /** Unclaimed draft lifetime in milliseconds. */
  draftTtlMs: number
  /** Managed working directory for project-free analysis sessions. */
  analysisRoot: string
}

/** Validated draft submitted by the Chrome extension. */
export interface ExternalDraft {
  prompt: string
}

interface StoredDraft extends ExternalDraft {
  expiresAt: number
}

interface StoredChatDraft extends StoredDraft {
  cwd: string
  agentPreset: 'api-capture-analysis'
}

/** Cordis configuration schema. */
export const Config: z<Config> = z.object({
  maxBodyBytes: z.natural().min(1024).max(16 * 1024 * 1024).required(),
  draftTtlMs: z.natural().min(60_000).max(24 * 60 * 60 * 1000).required(),
  analysisRoot: z.string().required(),
})

function allowOrigin(req: IncomingMessage): string | undefined {
  const origin = req.headers.origin
  if (origin === undefined) return undefined
  if (origin.startsWith('chrome-extension://')) return origin
  if (/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return origin
  return undefined
}

function writeJson(res: ServerResponse, status: number, value: unknown, origin?: string): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...(origin === undefined ? {} : {
      'access-control-allow-origin': origin,
      vary: 'origin',
    }),
  })
  res.end(body)
}

async function readBody(req: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.byteLength
    if (size > maxBodyBytes) throw new Error('request body exceeds configured limit')
    chunks.push(bytes)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function parseDraft(value: unknown): ExternalDraft {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('body must be an object')
  const candidate = value as Record<string, unknown>
  if (typeof candidate.prompt !== 'string' || candidate.prompt.trim() === '') throw new Error('prompt must be a non-empty string')
  const unsupported = Object.keys(candidate).filter(key => key !== 'prompt')
  if (unsupported.length > 0) throw new Error(`only prompt is supported; unexpected field: ${unsupported[0]}`)
  return { prompt: candidate.prompt }
}

/** Register the loopback draft API beside the native Harness Web application. */
export function apply(ctx: Context, config: Config): void {
  const drafts = new Map<string, StoredDraft>()
  const chatDrafts = new Map<string, StoredChatDraft>()
  const prune = (): void => {
    const now = Date.now()
    for (const [id, draft] of drafts) if (draft.expiresAt <= now) drafts.delete(id)
    for (const [id, draft] of chatDrafts) if (draft.expiresAt <= now) chatDrafts.delete(id)
  }

  ctx.inject(['webServer', 'apiCaptureEvidence'], (httpCtx) => {
    const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const origin = allowOrigin(req)
      if (req.headers.origin !== undefined && origin === undefined) {
        writeJson(res, 403, { error: 'origin is not allowed' })
        return
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          ...(origin === undefined ? {} : {
            'access-control-allow-origin': origin,
            vary: 'origin',
          }),
          'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
          'access-control-allow-headers': 'content-type',
        })
        res.end()
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      prune()
      if (req.method === 'GET' && url.pathname === '/api-capture/health') {
        writeJson(res, 200, {
          ok: true,
          surface: 'native-harness',
          protocolVersion: '1.0',
          chatDraftProtocolVersion: '1.0',
          evidenceProtocolVersion: httpCtx.apiCaptureEvidence.protocolVersion,
        }, origin)
        return
      }
      if (req.method === 'POST' && url.pathname === '/api-capture/chat-drafts') {
        try {
          const draft = parseDraft(await readBody(req, config.maxBodyBytes))
          await mkdir(config.analysisRoot, { recursive: true })
          const id = randomUUID()
          chatDrafts.set(id, {
            ...draft,
            cwd: config.analysisRoot,
            agentPreset: 'api-capture-analysis',
            expiresAt: Date.now() + config.draftTtlMs,
          })
          const openUrl = `http://127.0.0.1:${String(httpCtx.webServer.port)}/?apiCaptureChatDraft=${encodeURIComponent(id)}`
          writeJson(res, 201, { draftId: id, openUrl }, origin)
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) }, origin)
        }
        return
      }
      if (req.method === 'GET' && url.pathname === '/api-capture/chat-drafts/config') {
        try {
          await mkdir(config.analysisRoot, { recursive: true })
          writeJson(res, 200, {
            cwd: config.analysisRoot,
            agentPreset: 'api-capture-analysis',
          }, origin)
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) }, origin)
        }
        return
      }
      if (req.method === 'POST' && url.pathname === '/api-capture/drafts') {
        try {
          const draft = parseDraft(await readBody(req, config.maxBodyBytes))
          const id = randomUUID()
          drafts.set(id, { ...draft, expiresAt: Date.now() + config.draftTtlMs })
          const openUrl = `http://127.0.0.1:${String(httpCtx.webServer.port)}/?apiCaptureDraft=${encodeURIComponent(id)}`
          writeJson(res, 201, { draftId: id, openUrl }, origin)
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) }, origin)
        }
        return
      }
      const match = /^\/api-capture\/drafts\/([0-9a-f-]+)$/.exec(url.pathname)
      if (req.method === 'GET' && match !== null) {
        const draftId = match[1]
        if (draftId === undefined) {
          writeJson(res, 404, { error: 'draft not found or expired' }, origin)
          return
        }
        const draft = drafts.get(draftId)
        if (draft === undefined) {
          writeJson(res, 404, { error: 'draft not found or expired' }, origin)
          return
        }
        drafts.delete(draftId)
        const { expiresAt: _expiresAt, ...value } = draft
        writeJson(res, 200, value, origin)
        return
      }
      const chatMatch = /^\/api-capture\/chat-drafts\/([0-9a-f-]+)$/.exec(url.pathname)
      if (chatMatch !== null && req.method === 'GET') {
        const draftId = chatMatch[1]
        if (draftId === undefined) {
          writeJson(res, 404, { error: 'chat draft not found or expired' }, origin)
          return
        }
        const draft = chatDrafts.get(draftId)
        if (draft === undefined) {
          writeJson(res, 404, { error: 'chat draft not found or expired' }, origin)
          return
        }
        const { expiresAt: _expiresAt, ...value } = draft
        writeJson(res, 200, value, origin)
        return
      }
      if (chatMatch !== null && req.method === 'DELETE') {
        const draftId = chatMatch[1]
        if (draftId === undefined || !chatDrafts.delete(draftId)) {
          writeJson(res, 404, { error: 'chat draft not found or expired' }, origin)
          return
        }
        writeJson(res, 200, { consumed: true }, origin)
        return
      }
      writeJson(res, 404, { error: 'not found' }, origin)
    }
    httpCtx.effect(
      () => httpCtx.webServer.register({ kind: 'prefix', path: '/api-capture', handler }),
      'api-capture-draft: HTTP bridge',
    )
  })
}

/** REAL-composition coverage for the native Web prompt bridge HTTP surface. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import EvidenceService from '../../../host/api-capture-evidence/src/index.ts'
import * as DraftBridge from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadComposition(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-api-capture-draft-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    "- name: '@deepseek-ai/dsh-host-api-capture-evidence'",
    '  config:',
    `    root: '${join(root, 'evidence').replaceAll('\\', '/')}'`,
    '    maxPackageBytes: 1048576',
    '    maxFileBytes: 524288',
    '    maxFiles: 20',
    '    maxMetadataBytes: 65536',
    '    stagingTtlMs: 60000',
    "- name: '@deepseek-ai/dsh-client-api-capture-draft'",
    '  config:',
    '    maxBodyBytes: 4096',
    '    draftTtlMs: 60000',
    `    analysisRoot: '${join(root, 'analysis').replaceAll('\\', '/')}'`,
    '',
  ].join('\n'))
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    ['@deepseek-ai/dsh-host-api-capture-evidence', EvidenceService],
    ['@deepseek-ai/dsh-client-api-capture-draft', DraftBridge],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  return context
}

describe('API Capture draft bridge', () => {
  it('accepts one editable prompt and consumes it exactly once', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const base = `http://127.0.0.1:${String(loaded.webServer.port)}`
    const headers = { 'content-type': 'application/json', origin: 'chrome-extension://capture-test' }
    const health = await fetch(`${base}/api-capture/health`, { headers })
    expect(await health.json()).toEqual({
      ok: true,
      surface: 'native-harness',
      protocolVersion: '1.0',
      chatDraftProtocolVersion: '1.0',
      evidenceProtocolVersion: '1.0',
    })

    const created = await fetch(`${base}/api-capture/drafts`, {
      method: 'POST', headers, body: JSON.stringify({ prompt: 'inspect this request' }),
    })
    expect(created.status).toBe(201)
    const result = await created.json() as { draftId: string; openUrl: string }
    expect(result.openUrl).toBe(`${base}/?apiCaptureDraft=${result.draftId}`)

    const first = await fetch(`${base}/api-capture/drafts/${result.draftId}`)
    expect(await first.json()).toEqual({ prompt: 'inspect this request' })
    expect((await fetch(`${base}/api-capture/drafts/${result.draftId}`)).status).toBe(404)
  })

  it('keeps analysis drafts until explicit acknowledgement and creates the managed directory', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const base = `http://127.0.0.1:${String(loaded.webServer.port)}`
    const headers = { 'content-type': 'application/json', origin: 'chrome-extension://capture-test' }
    const created = await fetch(`${base}/api-capture/chat-drafts`, {
      method: 'POST', headers, body: JSON.stringify({ prompt: 'analyze the captured task' }),
    })
    expect(created.status).toBe(201)
    const result = await created.json() as { draftId: string; openUrl: string }
    expect(result.openUrl).toBe(`${base}/?apiCaptureChatDraft=${result.draftId}`)

    const first = await fetch(`${base}/api-capture/chat-drafts/${result.draftId}`)
    const value = await first.json() as Record<string, unknown>
    expect(value).toMatchObject({
      prompt: 'analyze the captured task',
      agentPreset: 'api-capture-analysis',
    })
    expect(value.cwd).toBe(join(root!, 'analysis').replaceAll('\\', '/'))
    expect((await fetch(`${base}/api-capture/chat-drafts/${result.draftId}`)).status).toBe(200)
    expect((await fetch(`${base}/api-capture/chat-drafts/${result.draftId}`, { method: 'DELETE' })).status).toBe(200)
    expect((await fetch(`${base}/api-capture/chat-drafts/${result.draftId}`)).status).toBe(404)

    const config = await fetch(`${base}/api-capture/chat-drafts/config`)
    expect(await config.json()).toEqual({
      cwd: join(root!, 'analysis').replaceAll('\\', '/'),
      agentPreset: 'api-capture-analysis',
    })
  })

  it('rejects untrusted origins and malformed drafts', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const url = `http://127.0.0.1:${String(loaded.webServer.port)}/api-capture/drafts`
    expect((await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://example.com' }, body: '{"prompt":"x"}',
    })).status).toBe(403)
    expect((await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"prompt":""}',
    })).status).toBe(400)
    expect((await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"prompt":"x","workspacePath":"C:\\\\repo"}',
    })).status).toBe(400)
  })
})

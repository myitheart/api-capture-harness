/** REAL-composition coverage for immutable API Capture evidence packages. */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import EvidenceService, {
  evidenceDirectoryOpenCommand,
  evidenceDirectoryOpenSpawnOptions,
} from '../src/index.ts'

const EVIDENCE = '@deepseek-ai/dsh-host-api-capture-evidence'
const ORIGIN = 'chrome-extension://capture-test'
const REQUIRED_FILES = [
  ['index', 'index.md', 'text/markdown', '# Evidence\n'],
  ['task', 'task.json', 'application/json', '{"id":"task-1"}\n'],
  ['requirement', 'requirement.md', 'text/markdown', '# Requirement\n'],
  ['steps', 'steps.json', 'application/json', '[]\n'],
  ['network-index', 'network/index.json', 'application/json', '{"requests":[]}\n'],
] as const

let sandbox: string | undefined
let evidenceRoot: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (sandbox !== undefined) await rm(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  if (evidenceRoot !== undefined) await rm(evidenceRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  sandbox = undefined
  evidenceRoot = undefined
})

async function loadComposition(existingEvidenceRoot?: string): Promise<{ ctx: Context; base: string }> {
  sandbox = await mkdtemp(join(tmpdir(), 'dsh-api-capture-evidence-'))
  evidenceRoot = existingEvidenceRoot ?? await mkdtemp(join(tmpdir(), 'dsh-api-capture-evidence-data-'))
  const configPath = join(sandbox, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    `- name: '${EVIDENCE}'`,
    '  config:',
    `    root: '${evidenceRoot.replaceAll('\\', '/')}'`,
    '    maxPackageBytes: 1048576',
    '    maxFileBytes: 524288',
    '    maxFiles: 20',
    '    maxMetadataBytes: 65536',
    '    stagingTtlMs: 60000',
    '',
  ].join('\n'))
  context = new Context()
  context.baseUrl = pathToFileURL(sandbox).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    [EVIDENCE, EvidenceService],
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
  return { ctx: context, base: `http://127.0.0.1:${String(context.webServer.port)}` }
}

function declaration(files = REQUIRED_FILES): object {
  return {
    apiCaptureEvidenceVersion: '1.0',
    taskId: 'task-1',
    mode: 'product',
    title: 'Shipment recording',
    source: { extensionVersion: '0.8.1' },
    files: files.map(([fileId, relativePath, mediaType, body]) => ({
      fileId, relativePath, mediaType, bytes: Buffer.byteLength(body),
    })),
  }
}

async function createPackage(base: string, files = REQUIRED_FILES): Promise<string> {
  const response = await fetch(`${base}/api-capture/evidence-packages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify(declaration(files)),
  })
  expect(response.status).toBe(201)
  return ((await response.json()) as { packageId: string }).packageId
}

async function uploadFiles(base: string, packageId: string, files = REQUIRED_FILES): Promise<void> {
  for (const [fileId, _relativePath, mediaType, body] of files) {
    const response = await fetch(`${base}/api-capture/evidence-packages/${packageId}/files/${fileId}`, {
      method: 'PUT', headers: { 'content-type': mediaType, origin: ORIGIN }, body,
    })
    expect(response.status).toBe(200)
  }
}

describe('API Capture evidence Host', () => {
  it('forces a new Explorer window on Windows instead of reusing a minimized window', () => {
    const rootPath = 'C:\\Evidence Root\\task-1'
    expect(evidenceDirectoryOpenCommand(rootPath, 'win32')).toEqual({
      command: 'explorer.exe',
      args: ['/n,', rootPath],
    })
    expect(evidenceDirectoryOpenCommand('/tmp/evidence', 'darwin')).toEqual({
      command: 'open',
      args: ['/tmp/evidence'],
    })
    expect(evidenceDirectoryOpenCommand('/tmp/evidence', 'linux')).toEqual({
      command: 'xdg-open',
      args: ['/tmp/evidence'],
    })
    expect(evidenceDirectoryOpenSpawnOptions()).toEqual({ detached: true, stdio: 'ignore' })
    expect(evidenceDirectoryOpenSpawnOptions()).not.toHaveProperty('windowsHide')
  })

  it('publishes an immutable package, discovers it after restart, and deletes only on request', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const packageId = await createPackage(loaded.base)
    await uploadFiles(loaded.base, packageId)
    const reused = await fetch(`${loaded.base}/api-capture/evidence-packages/${packageId}/files/index`, {
      method: 'PUT', headers: { 'content-type': 'text/markdown', origin: ORIGIN }, body: '# Evidence\n',
    })
    expect((await reused.json()) as object).toMatchObject({ reused: true })

    const finalized = await fetch(`${loaded.base}/api-capture/evidence-packages/${packageId}/finalize`, {
      method: 'POST', headers: { origin: ORIGIN },
    })
    expect(finalized.status).toBe(200)
    const result = await finalized.json() as { rootPath: string; indexPath: string; manifestPath: string; manifestSha256: string }
    expect(result.rootPath).toContain(packageId)
    expect(await readFile(result.indexPath, 'utf8')).toBe('# Evidence\n')
    expect(JSON.parse(await readFile(result.manifestPath, 'utf8'))).toMatchObject({
      apiCaptureEvidenceVersion: '1.0', packageId, taskId: 'task-1', mode: 'product',
    })
    expect(result.manifestSha256).toMatch(/^[0-9a-f]{64}$/u)
    expect((await fetch(`${loaded.base}/api-capture/evidence-packages/${packageId}/finalize`, {
      method: 'POST', headers: { origin: ORIGIN },
    })).status).toBe(404)

    const retainedRoot = evidenceRoot!
    await context!.fiber.dispose()
    context = undefined
    await rm(sandbox!, { recursive: true, force: true })
    sandbox = undefined
    const restarted = await loadComposition(retainedRoot)
    const listed = await (await fetch(`${restarted.base}/api-capture/evidence-packages`, { headers: { origin: ORIGIN } })).json() as { packages: Array<{ packageId: string }> }
    expect(listed.packages.map(item => item.packageId)).toContain(packageId)
    expect((await fetch(`${restarted.base}/api-capture/evidence-packages/${packageId}`, {
      method: 'DELETE', headers: { origin: ORIGIN },
    })).status).toBe(200)
    expect((await fetch(`${restarted.base}/api-capture/evidence-packages/${packageId}`, { headers: { origin: ORIGIN } })).status).toBe(404)
  })

  it('rejects unsafe declarations, untrusted origins, incomplete and mismatched uploads', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const endpoint = `${loaded.base}/api-capture/evidence-packages`
    expect((await fetch(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://example.com' }, body: JSON.stringify(declaration()),
    })).status).toBe(403)

    const unsafe = structuredClone(declaration()) as { files: Array<{ relativePath: string }> }
    unsafe.files[0]!.relativePath = '../index.md'
    expect((await fetch(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(unsafe),
    })).status).toBe(400)

    const packageId = await createPackage(loaded.base)
    expect((await fetch(`${endpoint}/${packageId}/files/not-declared`, {
      method: 'PUT', headers: { 'content-type': 'text/plain', origin: ORIGIN }, body: 'x',
    })).status).toBe(404)
    expect((await fetch(`${endpoint}/${packageId}/files/index`, {
      method: 'PUT', headers: { 'content-type': 'text/markdown', origin: ORIGIN }, body: '# wrong\n',
    })).status).toBe(400)
    expect((await fetch(`${endpoint}/${packageId}/finalize`, {
      method: 'POST', headers: { origin: ORIGIN },
    })).status).toBe(409)
  })
})

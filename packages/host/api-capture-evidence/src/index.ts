/** Loopback HTTP storage for immutable API Capture evidence packages. */

import { createHash, randomUUID } from 'node:crypto'
import { spawn, type SpawnOptions } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join, posix, resolve, sep } from 'node:path'
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import {
  EvidencePackageId,
  type CreateEvidencePackageRequest,
  type EvidenceFileDeclaration,
  type EvidenceFileRecord,
  type EvidencePackageId as EvidencePackageIdType,
  type EvidencePackageManifest,
  type EvidenceSourceMode,
} from './types.ts'

export { EvidencePackageId } from './types.ts'
export type {
  CreateEvidencePackageRequest,
  EvidenceFileDeclaration,
  EvidenceFileRecord,
  EvidencePackageManifest,
  EvidenceSourceMode,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    apiCaptureEvidence: ApiCaptureEvidence
  }
}

/** Evidence package HTTP and storage protocol version. */
export const EVIDENCE_PROTOCOL_VERSION = '1.0' as const

/**
 * Resolve the platform command used to reveal a completed evidence directory.
 * @param rootPath - Absolute completed-package directory.
 * @param platform - Operating-system command family.
 * @returns Executable and argument list for the platform file manager.
 */
export function evidenceDirectoryOpenCommand(
  rootPath: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform === 'win32') {
    // /n prevents Explorer from silently reusing an existing minimized window.
    return { command: 'explorer.exe', args: ['/n,', rootPath] }
  }
  return platform === 'darwin'
    ? { command: 'open', args: [rootPath] }
    : { command: 'xdg-open', args: [rootPath] }
}

/**
 * Spawn options for a user-visible directory window.
 * @returns Detached process options that do not retain Companion stdio.
 */
export function evidenceDirectoryOpenSpawnOptions(): SpawnOptions {
  return { detached: true, stdio: 'ignore' }
}

/** Deployment-owned storage and admission limits. */
export interface Config {
  /** Absolute root for staging and completed evidence packages. */
  root: string
  /** Maximum total bytes accepted by one evidence package. */
  maxPackageBytes: number
  /** Maximum bytes accepted by one declared evidence file. */
  maxFileBytes: number
  /** Maximum number of declared files in one evidence package. */
  maxFiles: number
  /** Maximum bytes accepted by one package-creation JSON request. */
  maxMetadataBytes: number
  /** Age after which incomplete staging transactions can be removed. */
  stagingTtlMs: number
}

interface UploadFileState extends EvidenceFileDeclaration {
  sha256?: string
  uploadedBytes?: number
}

interface UploadState {
  apiCaptureEvidenceVersion: '1.0'
  packageId: EvidencePackageIdType
  taskId: string
  mode: EvidenceSourceMode
  title: string
  source: { extensionVersion: string }
  createdAt: string
  files: UploadFileState[]
}

interface CompletedPackageView {
  packageId: EvidencePackageIdType
  taskId: string
  mode: EvidenceSourceMode
  title: string
  createdAt: string
  finalizedAt: string
  totalBytes: number
  fileCount: number
  rootPath: string
  indexPath: string
  networkIndexPath: string | null
  manifestPath: string
  manifestSha256: string
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'HttpError'
  }
}

const PACKAGE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const FILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const WINDOWS_INVALID_SEGMENT = /[<>:"|?*\u0000-\u001f]/u
const WINDOWS_RESERVED_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu
const REQUIRED_PATHS = ['index.md', 'task.json', 'requirement.md', 'steps.json', 'network/index.json'] as const

function allowedOrigin(req: IncomingMessage): string | undefined {
  const origin = req.headers.origin
  if (origin === undefined) return undefined
  if (origin.startsWith('chrome-extension://')) return origin
  if (/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/u.test(origin)) return origin
  return undefined
}

function writeJson(res: ServerResponse, status: number, value: unknown, origin?: string): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...(origin === undefined ? {} : { 'access-control-allow-origin': origin, vary: 'origin' }),
  })
  res.end(body)
}

async function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += value.byteLength
    if (bytes > limit) throw new HttpError(413, `metadata exceeds ${String(limit)} bytes`)
    chunks.push(value)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new HttpError(400, 'body must be valid JSON')
  }
}

function objectValue(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, message)
  return value as Record<string, unknown>
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim() === '') throw new HttpError(400, `${field} must be a non-empty string`)
  if (value.length > maxLength) throw new HttpError(400, `${field} exceeds ${String(maxLength)} characters`)
  return value.trim()
}

function natural(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new HttpError(400, `${field} must be a non-negative safe integer`)
  return value
}

function validateRelativePath(value: unknown): string {
  const relativePath = requiredString(value, 'relativePath', 512)
  if (relativePath.includes('\\') || relativePath.startsWith('/') || posix.isAbsolute(relativePath)) {
    throw new HttpError(400, 'relativePath must use relative POSIX separators')
  }
  const segments = relativePath.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new HttpError(400, 'relativePath contains an invalid segment')
  }
  for (const segment of segments) {
    if (WINDOWS_INVALID_SEGMENT.test(segment) || WINDOWS_RESERVED_SEGMENT.test(segment) || /[. ]$/u.test(segment)) {
      throw new HttpError(400, `relativePath contains an unsupported segment: ${segment}`)
    }
  }
  if (relativePath.toLowerCase() === 'manifest.json') throw new HttpError(400, 'manifest.json is reserved by the Host')
  return relativePath
}

function parseCreateRequest(value: unknown, config: Config): CreateEvidencePackageRequest {
  const input = objectValue(value, 'body must be an object')
  if (input.apiCaptureEvidenceVersion !== EVIDENCE_PROTOCOL_VERSION) throw new HttpError(409, 'apiCaptureEvidenceVersion must be 1.0')
  const mode = input.mode
  if (mode !== 'product' && mode !== 'developer') throw new HttpError(400, 'mode must be product or developer')
  const source = objectValue(input.source, 'source must be an object')
  if (!Array.isArray(input.files)) throw new HttpError(400, 'files must be an array')
  if (input.files.length === 0 || input.files.length > config.maxFiles) {
    throw new HttpError(413, `files must contain 1-${String(config.maxFiles)} entries`)
  }
  const fileIds = new Set<string>()
  const paths = new Set<string>()
  let totalBytes = 0
  const files = input.files.map((raw, index): EvidenceFileDeclaration => {
    const file = objectValue(raw, `files[${String(index)}] must be an object`)
    const fileId = requiredString(file.fileId, `files[${String(index)}].fileId`, 128)
    if (!FILE_ID_PATTERN.test(fileId)) throw new HttpError(400, `files[${String(index)}].fileId is invalid`)
    if (fileIds.has(fileId)) throw new HttpError(400, `duplicate fileId: ${fileId}`)
    fileIds.add(fileId)
    const relativePath = validateRelativePath(file.relativePath)
    const foldedPath = relativePath.toLowerCase()
    if (paths.has(foldedPath)) throw new HttpError(400, `duplicate relativePath: ${relativePath}`)
    paths.add(foldedPath)
    const bytes = natural(file.bytes, `files[${String(index)}].bytes`)
    if (bytes > config.maxFileBytes) throw new HttpError(413, `${relativePath} exceeds the per-file byte limit`)
    totalBytes += bytes
    if (totalBytes > config.maxPackageBytes) throw new HttpError(413, 'evidence package exceeds the aggregate byte limit')
    return {
      fileId,
      relativePath,
      mediaType: requiredString(file.mediaType, `files[${String(index)}].mediaType`, 128),
      bytes,
    }
  })
  for (const requiredPath of REQUIRED_PATHS) {
    if (!paths.has(requiredPath)) throw new HttpError(400, `required evidence file is missing: ${requiredPath}`)
  }
  return {
    apiCaptureEvidenceVersion: EVIDENCE_PROTOCOL_VERSION,
    taskId: requiredString(input.taskId, 'taskId', 256),
    mode,
    title: requiredString(input.title, 'title', 512),
    source: { extensionVersion: requiredString(source.extensionVersion, 'source.extensionVersion', 64) },
    files,
  }
}

function safeTaskSegment(taskId: string): string {
  const normalized = taskId.normalize('NFKC').replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 80)
  return normalized || 'task'
}

function assertPackageId(value: string): EvidencePackageIdType {
  if (!PACKAGE_ID_PATTERN.test(value)) throw new HttpError(400, 'packageId is invalid')
  return EvidencePackageId(value)
}

function inside(root: string, target: string): boolean {
  const base = resolve(root)
  const candidate = resolve(target)
  return candidate === base || candidate.startsWith(`${base}${sep}`)
}

/** Immutable evidence package storage and loopback HTTP provider. */
export class ApiCaptureEvidence extends Service {
  static inject = ['webServer']
  static Config: z<Config> = z.object({
    root: z.string().required(),
    maxPackageBytes: z.natural().min(1).required(),
    maxFileBytes: z.natural().min(1).required(),
    maxFiles: z.natural().min(1).max(5000).required(),
    maxMetadataBytes: z.natural().min(1024).required(),
    stagingTtlMs: z.natural().min(60_000).required(),
  })

  /** Evidence-package wire protocol implemented by this service. */
  readonly protocolVersion: typeof EVIDENCE_PROTOCOL_VERSION = EVIDENCE_PROTOCOL_VERSION
  private readonly root: string
  private readonly stagingRoot: string
  private readonly locks = new Map<string, Promise<void>>()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'apiCaptureEvidence')
    this.root = resolve(config.root)
    this.stagingRoot = join(this.root, '.staging')
  }

  async [Service.init](): Promise<void> {
    await mkdir(this.stagingRoot, { recursive: true })
    await this.pruneStaging()
    this.ctx.effect(
      () => this.ctx.webServer.register({ kind: 'prefix', path: '/api-capture/evidence-packages', handler: this.handle }),
      'api-capture-evidence: HTTP routes',
    )
  }

  private readonly handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const origin = allowedOrigin(req)
    if (req.headers.origin !== undefined && origin === undefined) {
      writeJson(res, 403, { error: 'origin is not allowed' })
      return
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...(origin === undefined ? {} : { 'access-control-allow-origin': origin, vary: 'origin' }),
        'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'access-control-allow-headers': 'content-type',
      })
      res.end()
      return
    }
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const base = '/api-capture/evidence-packages'
      const suffix = url.pathname.slice(base.length)
      const segments = suffix.split('/').filter(Boolean).map(segment => decodeURIComponent(segment))
      if (suffix === '' || suffix === '/') {
        if (req.method === 'POST') {
          writeJson(res, 201, await this.create(await readJsonBody(req, this.config.maxMetadataBytes)), origin)
          return
        }
        if (req.method === 'GET') {
          writeJson(res, 200, { packages: await this.list() }, origin)
          return
        }
      }
      const packageId = segments[0] === undefined ? undefined : assertPackageId(segments[0])
      if (packageId !== undefined && segments.length === 1) {
        if (req.method === 'GET') {
          writeJson(res, 200, await this.get(packageId), origin)
          return
        }
        if (req.method === 'DELETE') {
          await this.delete(packageId)
          writeJson(res, 200, { ok: true, packageId }, origin)
          return
        }
      }
      if (packageId !== undefined && segments[1] === 'files' && segments.length === 3 && req.method === 'PUT') {
        const fileId = segments[2]
        if (fileId === undefined) throw new HttpError(400, 'fileId is required')
        writeJson(res, 200, await this.upload(packageId, fileId, req), origin)
        return
      }
      if (packageId !== undefined && segments[1] === 'finalize' && segments.length === 2 && req.method === 'POST') {
        writeJson(res, 200, await this.finalize(packageId), origin)
        return
      }
      if (packageId !== undefined && segments[1] === 'open' && segments.length === 2 && req.method === 'POST') {
        const rootPath = await this.openDirectory(packageId)
        writeJson(res, 200, { ok: true, packageId, rootPath }, origin)
        return
      }
      throw new HttpError(404, 'not found')
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500
      writeJson(res, status, { error: error instanceof Error ? error.message : String(error) }, origin)
    }
  }

  private statePath(packageId: EvidencePackageIdType): string {
    return join(this.stagingRoot, packageId, 'state.json')
  }

  private async readState(packageId: EvidencePackageIdType): Promise<UploadState> {
    try {
      return JSON.parse(await readFile(this.statePath(packageId), 'utf8')) as UploadState
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, 'evidence package upload was not found')
      throw error
    }
  }

  private async writeState(state: UploadState): Promise<void> {
    const filename = this.statePath(state.packageId)
    const temporary = `${filename}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, filename)
  }

  private async withLock<T>(packageId: EvidencePackageIdType, operation: () => Promise<T>): Promise<T> {
    const key = String(packageId)
    const previous = this.locks.get(key) ?? Promise.resolve()
    let release!: () => void
    const held = new Promise<void>((resolveHeld) => { release = resolveHeld })
    const queued = previous.then(() => held)
    this.locks.set(key, queued)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.locks.get(key) === queued) this.locks.delete(key)
    }
  }

  private async create(value: unknown): Promise<{ packageId: EvidencePackageIdType; fileCount: number; totalBytes: number }> {
    await this.pruneStaging()
    const request = parseCreateRequest(value, this.config)
    const packageId = EvidencePackageId(randomUUID())
    const state: UploadState = {
      ...request,
      packageId,
      createdAt: new Date().toISOString(),
      files: request.files.map(file => ({ ...file })),
    }
    await mkdir(join(this.stagingRoot, packageId, '.uploads'), { recursive: true })
    await mkdir(join(this.stagingRoot, packageId, 'content'), { recursive: true })
    await this.writeState(state)
    return {
      packageId,
      fileCount: state.files.length,
      totalBytes: state.files.reduce((sum, file) => sum + file.bytes, 0),
    }
  }

  private async upload(
    packageId: EvidencePackageIdType,
    fileId: string,
    req: IncomingMessage,
  ): Promise<{ fileId: string; bytes: number; sha256: string; reused: boolean }> {
    if (!FILE_ID_PATTERN.test(fileId)) throw new HttpError(400, 'fileId is invalid')
    const initial = await this.readState(packageId)
    const declared = initial.files.find(file => file.fileId === fileId)
    if (declared === undefined) throw new HttpError(404, 'fileId was not declared')
    if (declared.sha256 !== undefined && declared.uploadedBytes !== undefined) {
      return { fileId, bytes: declared.uploadedBytes, sha256: declared.sha256, reused: true }
    }
    const contentLength = req.headers['content-length']
    if (contentLength !== undefined && Number(contentLength) !== declared.bytes) throw new HttpError(400, 'Content-Length does not match declared bytes')
    const uploadDir = join(this.stagingRoot, packageId, '.uploads')
    const temporary = join(uploadDir, `${fileId}.${randomUUID()}.part`)
    if (!inside(uploadDir, temporary)) throw new HttpError(400, 'upload path escaped staging')
    const handle = await open(temporary, 'wx', 0o600)
    const hash = createHash('sha256')
    let bytes = 0
    try {
      try {
        for await (const chunk of req) {
          const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          bytes += value.byteLength
          if (bytes > declared.bytes || bytes > this.config.maxFileBytes) throw new HttpError(413, 'uploaded file exceeds declared bytes')
          hash.update(value)
          await handle.write(value)
        }
        await handle.sync()
      } finally {
        await handle.close()
      }
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
    if (bytes !== declared.bytes) {
      await rm(temporary, { force: true })
      throw new HttpError(400, 'uploaded bytes do not match the declaration')
    }
    const digest = hash.digest('hex')
    try {
      return await this.withLock(packageId, async () => {
        const current = await this.readState(packageId)
        const file = current.files.find(candidate => candidate.fileId === fileId)
        if (file === undefined) throw new HttpError(404, 'fileId was not declared')
        if (file.sha256 !== undefined && file.uploadedBytes !== undefined) {
          await rm(temporary, { force: true })
          return { fileId, bytes: file.uploadedBytes, sha256: file.sha256, reused: true }
        }
        const target = join(this.stagingRoot, packageId, 'content', ...file.relativePath.split('/'))
        if (!inside(join(this.stagingRoot, packageId, 'content'), target)) throw new HttpError(400, 'declared path escaped package content')
        await mkdir(dirname(target), { recursive: true })
        await rm(target, { force: true })
        await rename(temporary, target)
        file.sha256 = digest
        file.uploadedBytes = bytes
        await this.writeState(current)
        return { fileId, bytes, sha256: digest, reused: false }
      })
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
  }

  private async finalize(packageId: EvidencePackageIdType): Promise<CompletedPackageView> {
    return this.withLock(packageId, async () => {
      const state = await this.readState(packageId)
      const pending = state.files.filter(file => file.sha256 === undefined || file.uploadedBytes === undefined)
      if (pending.length > 0) throw new HttpError(409, `evidence package has ${String(pending.length)} pending files`)
      const finalizedAt = new Date().toISOString()
      const files = state.files.map((file): EvidenceFileRecord => {
        if (file.uploadedBytes === undefined || file.sha256 === undefined) {
          throw new HttpError(409, `evidence file ${file.fileId} is incomplete`)
        }
        return {
          fileId: file.fileId,
          relativePath: file.relativePath,
          mediaType: file.mediaType,
          bytes: file.uploadedBytes,
          sha256: file.sha256,
        }
      })
      const manifest: EvidencePackageManifest = {
        apiCaptureEvidenceVersion: EVIDENCE_PROTOCOL_VERSION,
        packageId,
        taskId: state.taskId,
        mode: state.mode,
        title: state.title,
        source: state.source,
        createdAt: state.createdAt,
        finalizedAt,
        totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
        files,
      }
      const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
      const contentRoot = join(this.stagingRoot, packageId, 'content')
      await writeFile(join(contentRoot, 'manifest.json'), manifestText, { encoding: 'utf8', mode: 0o600 })
      const day = state.createdAt.slice(0, 10)
      const finalRoot = join(this.root, day, safeTaskSegment(state.taskId), packageId)
      if (!inside(this.root, finalRoot)) throw new HttpError(500, 'final package path escaped the configured root')
      await mkdir(dirname(finalRoot), { recursive: true })
      await rename(contentRoot, finalRoot)
      await rm(join(this.stagingRoot, packageId), { recursive: true, force: true })
      return this.view(finalRoot, manifest, createHash('sha256').update(manifestText).digest('hex'))
    })
  }

  private view(rootPath: string, manifest: EvidencePackageManifest, manifestSha256: string): CompletedPackageView {
    const hasNetworkIndex = manifest.files.some(file => file.relativePath === 'network/index.json')
    return {
      packageId: manifest.packageId,
      taskId: manifest.taskId,
      mode: manifest.mode,
      title: manifest.title,
      createdAt: manifest.createdAt,
      finalizedAt: manifest.finalizedAt,
      totalBytes: manifest.totalBytes,
      fileCount: manifest.files.length,
      rootPath,
      indexPath: join(rootPath, 'index.md'),
      networkIndexPath: hasNetworkIndex ? join(rootPath, 'network', 'index.json') : null,
      manifestPath: join(rootPath, 'manifest.json'),
      manifestSha256,
    }
  }

  private async completedPackages(): Promise<Array<{ rootPath: string; manifest: EvidencePackageManifest; manifestSha256: string }>> {
    const values: Array<{ rootPath: string; manifest: EvidencePackageManifest; manifestSha256: string }> = []
    const dates = await readdir(this.root, { withFileTypes: true }).catch(() => [])
    for (const date of dates) {
      if (!date.isDirectory() || date.name.startsWith('.')) continue
      const dateRoot = join(this.root, date.name)
      for (const task of await readdir(dateRoot, { withFileTypes: true }).catch(() => [])) {
        if (!task.isDirectory()) continue
        const taskRoot = join(dateRoot, task.name)
        for (const bundle of await readdir(taskRoot, { withFileTypes: true }).catch(() => [])) {
          if (!bundle.isDirectory() || !PACKAGE_ID_PATTERN.test(bundle.name)) continue
          const rootPath = join(taskRoot, bundle.name)
          try {
            const manifestText = await readFile(join(rootPath, 'manifest.json'), 'utf8')
            const manifest = JSON.parse(manifestText) as EvidencePackageManifest
            if (manifest.packageId !== bundle.name || manifest.apiCaptureEvidenceVersion !== EVIDENCE_PROTOCOL_VERSION) continue
            values.push({ rootPath, manifest, manifestSha256: createHash('sha256').update(manifestText).digest('hex') })
          } catch {
            // A malformed directory is not published through the evidence API.
          }
        }
      }
    }
    return values
  }

  private async list(): Promise<CompletedPackageView[]> {
    const packages = await this.completedPackages()
    return packages.map(item => this.view(item.rootPath, item.manifest, item.manifestSha256))
      .sort((left, right) => right.finalizedAt.localeCompare(left.finalizedAt))
  }

  private async get(packageId: EvidencePackageIdType): Promise<CompletedPackageView> {
    const found = (await this.completedPackages()).find(item => item.manifest.packageId === packageId)
    if (found === undefined) throw new HttpError(404, 'completed evidence package was not found')
    return this.view(found.rootPath, found.manifest, found.manifestSha256)
  }

  private async delete(packageId: EvidencePackageIdType): Promise<void> {
    const found = await this.get(packageId)
    if (!inside(this.root, found.rootPath)) throw new HttpError(400, 'evidence package path escaped the configured root')
    await rm(found.rootPath, { recursive: true, force: true })
  }

  private async openDirectory(packageId: EvidencePackageIdType): Promise<string> {
    const found = await this.get(packageId)
    const { command, args } = evidenceDirectoryOpenCommand(found.rootPath)
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      // Do not set windowsHide here: Explorer is a GUI process and would be
      // successfully spawned but remain invisible to the user.
      const child = spawn(command, args, evidenceDirectoryOpenSpawnOptions())
      child.once('error', rejectSpawn)
      child.once('spawn', () => {
        child.unref()
        resolveSpawn()
      })
    })
    return found.rootPath
  }

  private async pruneStaging(): Promise<void> {
    const cutoff = Date.now() - this.config.stagingTtlMs
    const entries = await readdir(this.stagingRoot, { withFileTypes: true }).catch(() => [])
    await Promise.all(entries.filter(entry => entry.isDirectory()).map(async (entry) => {
      const target = join(this.stagingRoot, entry.name)
      try {
        if ((await stat(target)).mtimeMs < cutoff) await rm(target, { recursive: true, force: true })
      } catch {
        // Concurrent cleanup or upload owns the remaining lifecycle.
      }
    }))
  }
}

export default ApiCaptureEvidence

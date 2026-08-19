/**
 * Build the host-native Web runtime consumed by API Capture Assistant.
 * The deployed app closure stays separate from Companion source; release
 * assembly copies this directory beside Companion and its embedded Node.js.
 */

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { copyFile, lstat, mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { packedIdentity } from './release/tarball.ts'
import { resolveApiCaptureTarget } from './api-capture-target.ts'

const root = resolve(import.meta.dirname, '..')
const target = resolveApiCaptureTarget(process.platform, process.arch)
const outputRoot = resolve(root, 'dist', target.product)
const harnessRoot = join(outputRoot, 'harness')
const runtimeRoot = join(outputRoot, 'runtime')
const bridgeProtocolVersion = '1.0'
const evidenceProtocolVersion = '1.0'
const chatDraftProtocolVersion = '1.0'

function pnpmBin(): string {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
}

async function run(command: string, args: string[], cwd = root): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, CI: process.env.CI || 'true' },
      windowsHide: true,
      shell: process.platform === 'win32' && command.endsWith('.cmd'),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolvePromise(stdout.trim())
      else reject(new Error(`${command} ${args.join(' ')} failed with exit code ${String(code)}\n${stdout.trim()}\n${stderr.trim()}`))
    })
  })
}

async function clearOutput(): Promise<void> {
  const relativeOutput = relative(root, outputRoot)
  if (relativeOutput.startsWith(`..${sep}`) || relativeOutput === '..' || relativeOutput === '') {
    throw new Error(`refusing to clear output outside the repository dist directory: ${outputRoot}`)
  }
  try {
    const metadata = await lstat(outputRoot)
    if (metadata.isSymbolicLink()) await unlink(outputRoot)
    else if (metadata.isDirectory()) await rm(outputRoot, { recursive: true, force: true })
    else throw new Error(`output path is not a directory: ${outputRoot}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function digest(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function collectChecksums(directory: string): Promise<Record<string, string>> {
  const checksums: Record<string, string> = {}
  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const target = join(current, entry.name)
      if (entry.isDirectory()) await visit(target)
      else if (entry.isFile()) checksums[relative(directory, target).replaceAll('\\', '/')] = await digest(target)
    }
  }
  await visit(directory)
  return checksums
}

async function installPackedRuntime(): Promise<number> {
  const packedRoot = join(outputRoot, '.packed')
  const dshPacked = join(packedRoot, 'dsh')
  const vendorPacked = join(packedRoot, 'vendor')
  await run(pnpmBin(), ['exec', 'tsx', 'scripts/release/pack.ts', '--family', 'vendor', '--out', relative(root, vendorPacked)])
  await run(pnpmBin(), ['exec', 'tsx', 'scripts/release/pack.ts', '--family', 'dsh', '--out', relative(root, dshPacked)])
  const dependencies: Record<string, string> = {}
  for (const directory of [vendorPacked, dshPacked]) {
    for (const filename of await readdir(directory)) {
      if (!filename.endsWith('.tgz')) continue
      const tarball = join(directory, filename)
      const { name } = packedIdentity(tarball)
      dependencies[name] = pathToFileURL(tarball).href
    }
  }
  await mkdir(harnessRoot, { recursive: true })
  await writeFile(join(harnessRoot, 'package.json'), `${JSON.stringify({
    name: 'api-capture-harness-portable-runtime',
    version: '0.0.0',
    private: true,
    dependencies,
  }, null, 2)}\n`, 'utf8')
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  await run(npm, ['install', '--no-audit', '--no-fund', '--package-lock=false'], harnessRoot)
  await rm(packedRoot, { recursive: true, force: true })
  return Object.keys(dependencies).length
}

async function main(): Promise<void> {
  await clearOutput()
  await mkdir(outputRoot, { recursive: true })
  await run(pnpmBin(), ['run', 'build'])
  const packedPackageCount = await installPackedRuntime()
  await mkdir(runtimeRoot, { recursive: true })
  await copyFile(process.execPath, join(runtimeRoot, target.runtimeExecutable))
  await copyFile(join(root, 'LICENSE'), join(outputRoot, 'LICENSE'))
  await copyFile(join(root, 'THIRD_PARTY_NOTICES.md'), join(outputRoot, 'THIRD_PARTY_NOTICES.md'))

  const forkMetadata = JSON.parse(await readFile(join(root, 'api-capture-fork.json'), 'utf8')) as {
    upstreamCommit?: unknown
  }
  if (typeof forkMetadata.upstreamCommit !== 'string' || !/^[0-9a-f]{40}$/.test(forkMetadata.upstreamCommit)) {
    throw new Error('api-capture-fork.json must contain a 40-character upstreamCommit')
  }
  const [head, status] = await Promise.all([
    run('git', ['rev-parse', 'HEAD']),
    run('git', ['status', '--porcelain', '--untracked-files=all', '--', '.', ':(exclude)dist/**']),
  ])
  const upstream = forkMetadata.upstreamCommit
  const entry = join(harnessRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const checksums = await collectChecksums(outputRoot)
  const buildFingerprint = createHash('sha256').update(JSON.stringify({
    bridgeProtocolVersion,
    evidenceProtocolVersion,
    chatDraftProtocolVersion,
    upstreamCommit: upstream,
    forkCommit: head,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    checksums,
  })).digest('hex')
  const manifest = {
    product: target.product,
    surface: 'native-web',
    harnessVersion: '0.3.0',
    bridgeProtocolVersion,
    evidenceProtocolVersion,
    chatDraftProtocolVersion,
    upstreamCommit: upstream,
    forkCommit: head,
    dirty: status !== '',
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    entry: relative(outputRoot, entry).replaceAll('\\', '/'),
    builtAt: new Date().toISOString(),
    packedPackageCount,
    buildFingerprint,
    checksums,
  }
  await writeFile(join(outputRoot, 'harness-build.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  process.stdout.write(`${outputRoot}\n`)
}

await main()

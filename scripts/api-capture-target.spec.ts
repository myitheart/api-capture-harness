import { describe, expect, it } from 'vitest'
import forkMetadata from '../api-capture-fork.json'
import { resolveApiCaptureTarget } from './api-capture-target.ts'

describe('API Capture portable targets', () => {
  it('pins the exact upstream source commit without requiring an upstream remote', () => {
    expect(forkMetadata.upstreamCommit).toMatch(/^[0-9a-f]{40}$/)
  })

  it('keeps Windows x64 output compatible', () => {
    expect(resolveApiCaptureTarget('win32', 'x64')).toEqual({
      platform: 'win32',
      arch: 'x64',
      product: 'api-capture-harness-win-x64',
      runtimeExecutable: 'node.exe',
    })
  })

  it('adds the Apple Silicon target', () => {
    expect(resolveApiCaptureTarget('darwin', 'arm64')).toEqual({
      platform: 'darwin',
      arch: 'arm64',
      product: 'api-capture-harness-darwin-arm64',
      runtimeExecutable: 'node',
    })
  })

  it('fails closed for unsupported targets', () => {
    expect(() => resolveApiCaptureTarget('darwin', 'x64')).toThrow(/supports only/)
    expect(() => resolveApiCaptureTarget('linux', 'x64')).toThrow(/supports only/)
  })
})

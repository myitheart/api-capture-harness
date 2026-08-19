export interface ApiCaptureTarget {
  readonly platform: 'win32' | 'darwin'
  readonly arch: 'x64' | 'arm64'
  readonly product: string
  readonly runtimeExecutable: string
}

const TARGETS: Readonly<Record<string, ApiCaptureTarget>> = Object.freeze({
  'win32-x64': Object.freeze({
    platform: 'win32',
    arch: 'x64',
    product: 'api-capture-harness-win-x64',
    runtimeExecutable: 'node.exe',
  }),
  'darwin-arm64': Object.freeze({
    platform: 'darwin',
    arch: 'arm64',
    product: 'api-capture-harness-darwin-arm64',
    runtimeExecutable: 'node',
  }),
})

export function resolveApiCaptureTarget(platform: string, arch: string): ApiCaptureTarget {
  const target = TARGETS[`${platform}-${arch}`]
  if (target === undefined) {
    throw new Error(`API Capture Harness supports only win32-x64 and darwin-arm64; received ${platform}-${arch}`)
  }
  return target
}

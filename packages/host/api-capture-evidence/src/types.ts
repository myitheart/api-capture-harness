import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque identifier for one immutable API Capture evidence package. */
export type EvidencePackageId = Branded<'ApiCaptureEvidencePackageId'>

/**
 * Construct an evidence-package identifier after wire validation or generation.
 * @param value - Validated UUID or internally generated identifier.
 * @returns Branded evidence-package identifier.
 */
export function EvidencePackageId(value: string): EvidencePackageId {
  return value as EvidencePackageId
}

/** Product or developer capture semantics recorded in the package manifest. */
export type EvidenceSourceMode = 'product' | 'developer'

/** One file declared before upload. */
export interface EvidenceFileDeclaration {
  fileId: string
  relativePath: string
  mediaType: string
  bytes: number
}

/** Metadata required to create an upload transaction. */
export interface CreateEvidencePackageRequest {
  apiCaptureEvidenceVersion: '1.0'
  taskId: string
  mode: EvidenceSourceMode
  title: string
  source: {
    extensionVersion: string
  }
  files: EvidenceFileDeclaration[]
}

/** Completed immutable file record written to manifest.json. */
export interface EvidenceFileRecord extends EvidenceFileDeclaration {
  sha256: string
}

/** Immutable evidence manifest persisted beside the declared files. */
export interface EvidencePackageManifest {
  apiCaptureEvidenceVersion: '1.0'
  packageId: EvidencePackageId
  taskId: string
  mode: EvidenceSourceMode
  title: string
  source: {
    extensionVersion: string
  }
  createdAt: string
  finalizedAt: string
  totalBytes: number
  files: EvidenceFileRecord[]
}

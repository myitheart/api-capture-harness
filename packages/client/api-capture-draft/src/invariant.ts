/** Package-owned invariant companion for the API Capture draft bridge. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-api-capture-draft'

/** Cordis companion plugin name. */
export const name = 'client-api-capture-draft-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** HTTP validation and one-time consumption are covered by the package tests. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))

import type { FreeRouter } from './router.js'

/**
 * Plugin interface for extending FreeRouter with reusable capabilities.
 * Install via router.use(plugin).
 */
export interface FreeRouterPlugin {
  /** Unique name — duplicate installs are silently skipped */
  name: string
  install(router: FreeRouter): void
}

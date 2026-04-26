import { readFile } from 'node:fs/promises'
import type { Rule } from '../finops/rules-engine.js'

/** Source for hot-reloadable rule sets. */
export interface RulesSource {
  fetch(): Promise<Rule[]>
}

/**
 * Loads admin rules from a local JSON file.
 * Re-reads on every `fetch()` so editing the file on disk is reflected on the
 * next refresh cycle without a restart.
 *
 * File must be a JSON array of `Rule` objects.
 */
export class FileRulesSource implements RulesSource {
  constructor(private readonly filePath: string) {}

  async fetch(): Promise<Rule[]> {
    const raw = await readFile(this.filePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      throw new Error(`[FileRulesSource] expected JSON array of Rule objects in ${this.filePath}`)
    }
    return parsed as Rule[]
  }
}

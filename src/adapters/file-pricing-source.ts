import { readFile } from 'node:fs/promises'
import type { PricingManifest, PricingSource } from '../finops/pricing-source.js'

/**
 * Loads a pricing manifest from a local JSON file.
 * Re-reads the file on every `fetch()` call so hot-swapping the file on disk
 * is reflected on the next scheduled refresh cycle without a restart.
 *
 * File must be a valid `PricingManifest` JSON object.
 *
 * @example
 * // pricing.json:
 * // {
 * //   "anthropic": { "claude-3-5-sonnet-20241022": { "input": 3.0, "output": 15.0 } },
 * //   "openai":    { "gpt-4o-mini": { "input": 0.15, "output": 0.60 } }
 * // }
 *
 * new FilePricingSource('./config/pricing.json')
 */
export class FilePricingSource implements PricingSource {
  constructor(private readonly filePath: string) {}

  async fetch(): Promise<PricingManifest> {
    const raw = await readFile(this.filePath, 'utf8')
    return JSON.parse(raw) as PricingManifest
  }
}

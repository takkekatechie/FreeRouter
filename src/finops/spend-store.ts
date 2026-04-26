import type { SpendRecord } from '../types.js'

/**
 * Persistence adapter for SpendTracker records.
 * Implement this interface to plug in any storage backend
 * (file system, Redis, Postgres, S3, etc.).
 */
export interface SpendStore {
  /** Load persisted records on startup. Returns empty array if no data exists yet. */
  load(): Promise<readonly SpendRecord[]>
  /** Overwrite the stored snapshot with the current in-memory records. */
  save(records: readonly SpendRecord[]): Promise<void>
}

/** No-op store — retains records only in memory (useful in tests). */
export class MemorySpendStore implements SpendStore {
  private snapshot: readonly SpendRecord[] = []
  async load(): Promise<readonly SpendRecord[]> { return this.snapshot }
  async save(records: readonly SpendRecord[]): Promise<void> { this.snapshot = records }
}

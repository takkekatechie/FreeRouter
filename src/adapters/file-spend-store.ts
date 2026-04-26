import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SpendRecord } from '../types.js'
import type { SpendStore } from '../finops/spend-store.js'

/**
 * File-system SpendStore.
 * Writes an atomic JSON snapshot (tmp-file + rename) so a crash mid-write
 * never corrupts the last good snapshot.
 *
 * Node.js built-in only — no runtime package dependency.
 */
export class FileSpendStore implements SpendStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<readonly SpendRecord[]> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      return JSON.parse(raw) as SpendRecord[]
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
  }

  async save(records: readonly SpendRecord[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    await writeFile(tmp, JSON.stringify(records), 'utf8')
    // Atomic on POSIX; best-effort on Windows (rename over existing file is atomic in NTFS too)
    await rename(tmp, this.filePath)
  }
}

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemorySpendStore } from '../src/finops/spend-store.js'
import { FileSpendStore } from '../src/adapters/file-spend-store.js'
import type { SpendRecord } from '../src/types.js'

const makeRecord = (costUsd: number, userId = 'u1'): SpendRecord => ({
  userId,
  provider: 'google',
  model: 'gemini-2.0-flash',
  tokens: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
  costUsd,
  timestamp: Date.now(),
})

// ── MemorySpendStore ────────────────────────────────────────────────────────

describe('MemorySpendStore', () => {
  it('load() returns empty array initially', async () => {
    const store = new MemorySpendStore()
    expect(await store.load()).toEqual([])
  })

  it('save() then load() round-trips records', async () => {
    const store = new MemorySpendStore()
    const records = [makeRecord(1.23), makeRecord(4.56, 'u2')]
    await store.save(records)
    const loaded = await store.load()
    expect(loaded).toHaveLength(2)
    expect(loaded[0]?.costUsd).toBe(1.23)
    expect(loaded[1]?.userId).toBe('u2')
  })

  it('save() replaces previous snapshot', async () => {
    const store = new MemorySpendStore()
    await store.save([makeRecord(1.00)])
    await store.save([makeRecord(2.00)])
    const loaded = await store.load()
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.costUsd).toBe(2.00)
  })

  it('save() with empty array clears storage', async () => {
    const store = new MemorySpendStore()
    await store.save([makeRecord(1.00)])
    await store.save([])
    expect(await store.load()).toEqual([])
  })
})

// ── FileSpendStore ──────────────────────────────────────────────────────────

describe('FileSpendStore', () => {
  let dir: string
  let filePath: string

  beforeEach(async () => {
    dir = join(tmpdir(), `freerouter-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(dir, { recursive: true })
    filePath = join(dir, 'spend.json')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('load() returns empty array when file does not exist', async () => {
    const store = new FileSpendStore(filePath)
    expect(await store.load()).toEqual([])
  })

  it('save() creates file and load() reads it back', async () => {
    const store = new FileSpendStore(filePath)
    const records = [makeRecord(0.50), makeRecord(1.25, 'u2')]
    await store.save(records)
    const loaded = await store.load()
    expect(loaded).toHaveLength(2)
    expect(loaded[0]?.costUsd).toBe(0.50)
    expect(loaded[1]?.userId).toBe('u2')
  })

  it('save() is idempotent — overwrites with latest snapshot', async () => {
    const store = new FileSpendStore(filePath)
    await store.save([makeRecord(1.00)])
    await store.save([makeRecord(2.00), makeRecord(3.00)])
    const loaded = await store.load()
    expect(loaded).toHaveLength(2)
    expect(loaded[0]?.costUsd).toBe(2.00)
  })

  it('save() creates nested directories if needed', async () => {
    const nestedPath = join(dir, 'a', 'b', 'c', 'spend.json')
    const store = new FileSpendStore(nestedPath)
    await store.save([makeRecord(0.01)])
    const loaded = await store.load()
    expect(loaded).toHaveLength(1)
  })

  it('load() preserves all SpendRecord fields including optional ones', async () => {
    const record: SpendRecord = {
      userId: 'u1',
      orgId: 'org1',
      departmentId: 'dept1',
      teamId: 'team1',
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      tokens: { promptTokens: 200, completionTokens: 100, totalTokens: 300, cachedPromptTokens: 150 },
      costUsd: 0.0042,
      timestamp: 1_700_000_000_000,
      cachedPromptTokens: 150,
    }
    const store = new FileSpendStore(filePath)
    await store.save([record])
    const [loaded] = await store.load()
    expect(loaded).toEqual(record)
  })

  it('load() throws when file contains invalid JSON', async () => {
    await writeFile(filePath, 'NOT_JSON', 'utf8')
    const store = new FileSpendStore(filePath)
    await expect(store.load()).rejects.toThrow()
  })

  it('save() writes atomically via tmp file (no partial writes visible)', async () => {
    // Verify .tmp file is absent after a successful save
    const store = new FileSpendStore(filePath)
    await store.save([makeRecord(9.99)])
    const { existsSync } = await import('node:fs')
    expect(existsSync(`${filePath}.tmp`)).toBe(false)
    expect(existsSync(filePath)).toBe(true)
  })
})

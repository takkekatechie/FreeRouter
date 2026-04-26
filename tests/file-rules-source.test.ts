import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FileRulesSource } from '../src/adapters/file-rules-source.js'
import type { Rule } from '../src/finops/rules-engine.js'

const RULES: Rule[] = [
  { id: 'r1', match: { teamId: 'legal' }, action: { type: 'pin', model: 'anthropic/claude-3-5-sonnet' } },
  { id: 'r2', match: { orgId: 'contractors' }, action: { type: 'block', reason: 'no contractors' } },
]

describe('FileRulesSource', () => {
  let dir: string
  let filePath: string

  beforeEach(async () => {
    dir = join(tmpdir(), `fr-rules-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(dir, { recursive: true })
    filePath = join(dir, 'rules.json')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('fetch() parses a valid JSON rule array', async () => {
    await writeFile(filePath, JSON.stringify(RULES), 'utf8')
    const source = new FileRulesSource(filePath)
    const result = await source.fetch()
    expect(result).toHaveLength(2)
    expect(result[0]?.id).toBe('r1')
  })

  it('fetch() re-reads file on each call (hot-swap)', async () => {
    await writeFile(filePath, JSON.stringify(RULES), 'utf8')
    const source = new FileRulesSource(filePath)
    expect((await source.fetch()).length).toBe(2)

    await writeFile(filePath, JSON.stringify([RULES[0]]), 'utf8')
    expect((await source.fetch()).length).toBe(1)
  })

  it('fetch() throws when file does not exist', async () => {
    const source = new FileRulesSource(join(dir, 'missing.json'))
    await expect(source.fetch()).rejects.toThrow()
  })

  it('fetch() throws when file is invalid JSON', async () => {
    await writeFile(filePath, 'NOT_JSON', 'utf8')
    const source = new FileRulesSource(filePath)
    await expect(source.fetch()).rejects.toThrow()
  })

  it('fetch() throws when JSON is not an array', async () => {
    await writeFile(filePath, JSON.stringify({ rules: RULES }), 'utf8')
    const source = new FileRulesSource(filePath)
    await expect(source.fetch()).rejects.toThrow(/array/)
  })
})

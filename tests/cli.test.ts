import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const execFileAsync = promisify(execFile)
const CLI = join(process.cwd(), 'src', 'cli.ts')
// tsx may have a .cmd wrapper on Windows
const isWindows = process.platform === 'win32'
const TSX_BIN = isWindows
  ? join(process.cwd(), 'node_modules', '.bin', 'tsx.cmd')
  : join(process.cwd(), 'node_modules', '.bin', 'tsx')

async function runCli(args: string[], env?: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number }> {
  const [cmd, cmdArgs] = isWindows
    ? ['cmd', ['/c', TSX_BIN, CLI, ...args]]
    : [TSX_BIN, [CLI, ...args]]
  try {
    const { stdout, stderr } = await execFileAsync(cmd, cmdArgs, {
      env: { ...process.env, ...env },
      timeout: 15_000,
    })
    return { stdout, stderr, code: 0 }
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number }
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      code: e.code ?? 1,
    }
  }
}

describe('CLI — validate-config', () => {
  it('exits 0 for a valid config file', async () => {
    const tmp = join(tmpdir(), `fr-valid-${Date.now()}.json`)
    await writeFile(tmp, JSON.stringify({
      defaultProvider: 'google',
      defaultModel: 'gemini-2.0-flash',
    }))
    try {
      const result = await runCli(['validate-config', tmp])
      expect(result.code).toBe(0)
      expect(result.stdout).toContain('valid')
    } finally {
      await unlink(tmp).catch(() => undefined)
    }
  })

  it('exits 1 for an invalid config (bad maxInputLength)', async () => {
    const tmp = join(tmpdir(), `fr-invalid-${Date.now()}.json`)
    await writeFile(tmp, JSON.stringify({ maxInputLength: -1 }))
    try {
      const result = await runCli(['validate-config', tmp])
      expect(result.code).toBe(1)
      expect(result.stdout).toContain('INVALID')
    } finally {
      await unlink(tmp).catch(() => undefined)
    }
  })

  it('exits 1 with error message when no path given', async () => {
    const result = await runCli(['validate-config'])
    expect(result.code).toBe(1)
  })

  it('shows warnings for unknown config keys', async () => {
    const tmp = join(tmpdir(), `fr-warn-${Date.now()}.json`)
    await writeFile(tmp, JSON.stringify({ unknownKey123: true }))
    try {
      const result = await runCli(['validate-config', tmp])
      expect(result.stdout).toContain('warning')
    } finally {
      await unlink(tmp).catch(() => undefined)
    }
  })
})

describe('CLI — list-providers', () => {
  it('lists built-in providers with no config', async () => {
    const result = await runCli(['list-providers'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('google')
    expect(result.stdout).toContain('openai')
    expect(result.stdout).toContain('anthropic')
  })

  it('lists providers from config file', async () => {
    const tmp = join(tmpdir(), `fr-lp-${Date.now()}.json`)
    await writeFile(tmp, JSON.stringify({
      providers: { groq: { enabled: false } },
    }))
    try {
      const result = await runCli(['list-providers', '--config', tmp])
      expect(result.code).toBe(0)
      expect(result.stdout).toContain('google')
      expect(result.stdout).not.toContain('groq')
    } finally {
      await unlink(tmp).catch(() => undefined)
    }
  })
})

describe('CLI — rotate-key', () => {
  it('exits 1 when --user is missing', async () => {
    const result = await runCli(['rotate-key', '--provider', 'openai'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('--user')
  })

  it('exits 1 when --provider is missing', async () => {
    const result = await runCli(['rotate-key', '--user', 'alice'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('--provider')
  })

  it('exits 1 when FREEROUTER_NEW_KEY env var is not set', async () => {
    const result = await runCli(
      ['rotate-key', '--user', 'alice', '--provider', 'openai'],
      { FREEROUTER_NEW_KEY: '' },
    )
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('FREEROUTER_NEW_KEY')
  })
})

describe('CLI — help / unknown command', () => {
  it('prints usage for no command', async () => {
    const result = await runCli([])
    expect(result.stdout).toContain('validate-config')
    expect(result.stdout).toContain('list-providers')
    expect(result.stdout).toContain('rotate-key')
  })

  it('exits 1 for an unknown command', async () => {
    const result = await runCli(['unknown-command-xyz'])
    expect(result.code).toBe(1)
  })
})

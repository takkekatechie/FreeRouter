import { readFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import type { RouterConfig } from './config.js'

/**
 * Serialisable subset of RouterConfig — everything except callbacks and class instances.
 * Config files match this shape 1:1.
 */
export interface FileConfig {
  defaultProvider?: string
  defaultModel?: string
  masterKey?: string
  keyExpiryMs?: number
  maxInputLength?: number
  promptInjectionGuard?: boolean
  requestSigning?: boolean
  blockedProviders?: string[]
  allowedModels?: string[]

  rateLimit?: {
    requestsPerMinute: number
    tokensPerMinute?: number
    burstAllowance?: number
  }

  budgets?: Array<{
    id: string
    scope: { type: string; orgId?: string; departmentId?: string; teamId?: string; userId?: string }
    window: string
    maxSpendUsd: number
    maxTokens?: number
    maxRequests?: number
    modelCaps?: Record<string, { maxSpendUsd: number }>
    onLimitReached: string
    fallbackModel?: string
    alertThresholds?: number[]
    priority?: number
  }>

  providers?: Record<string, {
    enabled?: boolean
    routingPrefixes?: string[]
  }>

  audit?: { enabled: boolean }

  pricingOverrides?: Record<string, { input: number; output: number }>
}

// ─── Parsers ──────────────────────────────────────────────────

async function parseJson(raw: string): Promise<FileConfig> {
  return JSON.parse(raw) as FileConfig
}

async function parseYaml(raw: string): Promise<FileConfig> {
  try {
    // Dynamic import — only loaded if user installs `yaml` peer dep
    const { parse } = await import('yaml')
    return parse(raw) as FileConfig
  } catch {
    throw new Error(
      '[FreeRouter/ConfigLoader] YAML config requires the "yaml" package. Install it: npm i yaml',
    )
  }
}

async function parseToml(raw: string): Promise<FileConfig> {
  try {
    // @ts-ignore — optional peer dependency
    const { parse } = await import('smol-toml')
    return parse(raw) as FileConfig
  } catch {
    throw new Error(
      '[FreeRouter/ConfigLoader] TOML config requires the "smol-toml" package. Install it: npm i smol-toml',
    )
  }
}

const PARSERS: Record<string, (raw: string) => Promise<FileConfig>> = {
  '.json': parseJson,
  '.yaml': parseYaml,
  '.yml':  parseYaml,
  '.toml': parseToml,
}

// ─── Loader ───────────────────────────────────────────────────

/**
 * Load and parse a config file.
 * Detects format from file extension: .json, .yaml/.yml, .toml
 */
export async function loadConfigFile(filePath: string): Promise<FileConfig> {
  const absPath = resolve(filePath)
  const ext = extname(absPath).toLowerCase()
  const parser = PARSERS[ext]

  if (parser === undefined) {
    throw new Error(
      `[FreeRouter/ConfigLoader] Unsupported config format "${ext}". ` +
      'Supported: .json, .yaml, .yml, .toml',
    )
  }

  const raw = await readFile(absPath, 'utf8')
  return parser(raw)
}

/**
 * Load config from the path specified in FREEROUTER_CONFIG env var.
 */
export async function loadConfigFromEnv(): Promise<FileConfig> {
  const envPath = process.env['FREEROUTER_CONFIG']
  if (envPath === undefined || envPath === '') {
    throw new Error(
      '[FreeRouter/ConfigLoader] FREEROUTER_CONFIG environment variable is not set.',
    )
  }
  return loadConfigFile(envPath)
}

// ─── Merge ────────────────────────────────────────────────────

/**
 * Deep-merge file config into a RouterConfig partial.
 * `overrides` wins for every key present.
 */
export function mergeConfigs(
  fileConfig: FileConfig,
  overrides: Partial<RouterConfig> = {},
): Partial<RouterConfig> {
  // Start with file config as base (shallow copy)
  const result: Record<string, unknown> = { ...fileConfig }

  // Override: inline config wins for every key present
  for (const [key, val] of Object.entries(overrides)) {
    if (val !== undefined) {
      result[key] = val
    }
  }

  return result as Partial<RouterConfig>
}

// ─── Validation ───────────────────────────────────────────────

const KNOWN_KEYS = new Set<string>([
  'defaultProvider', 'defaultModel', 'masterKey', 'keyExpiryMs',
  'maxInputLength', 'promptInjectionGuard', 'requestSigning',
  'blockedProviders', 'allowedModels', 'rateLimit', 'budgets',
  'providers', 'audit', 'pricingOverrides',
])

/**
 * Warn on unknown top-level keys (typo detection).
 * Returns array of unknown key names.
 */
export function validateConfigKeys(config: Record<string, unknown>): string[] {
  return Object.keys(config).filter(k => !KNOWN_KEYS.has(k))
}

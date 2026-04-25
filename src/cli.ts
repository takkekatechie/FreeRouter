#!/usr/bin/env node
/**
 * freerouter CLI
 *
 * Commands:
 *   validate-config <path>
 *   list-providers [--config <path>]
 *   rotate-key --user <id> --provider <name> [--config <path>]
 */

import { validateConfig } from './config-validator.js'
import { loadConfigFile } from './config-loader.js'
import { FreeRouter } from './router.js'

function parseArgs(argv: string[]): {
  command: string
  configPath: string | undefined
  flags: Record<string, string>
  positional: string[]
} {
  const args = argv.slice(2)
  const command = args[0] ?? ''
  const flags: Record<string, string> = {}
  const positional: string[] = []
  let configPath: string | undefined

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    if (arg === undefined) continue
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const value = args[i + 1]
      if (value !== undefined && !value.startsWith('--')) {
        flags[key] = value
        i++
      } else {
        flags[key] = 'true'
      }
    } else {
      positional.push(arg)
    }
  }

  if (flags['config'] !== undefined) configPath = flags['config']

  return { command, configPath, flags, positional }
}

async function cmdValidateConfig(args: string[]): Promise<void> {
  const filePath = args[0]
  if (filePath === undefined || filePath === '') {
    process.stderr.write('Usage: freerouter validate-config <path>\n')
    process.exit(1)
  }

  let raw: unknown
  try {
    raw = await loadConfigFile(filePath)
  } catch (err) {
    process.stderr.write(`Error loading config: ${String(err)}\n`)
    process.exit(1)
  }

  const result = validateConfig(raw)

  if (result.warnings.length > 0) {
    for (const w of result.warnings) {
      process.stdout.write(`  warning: ${w}\n`)
    }
  }

  if (result.valid) {
    process.stdout.write('Config is valid.\n')
  } else {
    process.stdout.write('Config is INVALID:\n')
    for (const e of result.errors) {
      process.stdout.write(`  error: ${e}\n`)
    }
    process.exit(1)
  }
}

async function cmdListProviders(configPath: string | undefined): Promise<void> {
  let router: FreeRouter
  if (configPath !== undefined) {
    router = await FreeRouter.fromFile(configPath)
  } else {
    router = new FreeRouter()
  }
  const providers = router.listProviders()
  if (providers.length === 0) {
    process.stdout.write('No providers registered.\n')
  } else {
    for (const p of providers) {
      process.stdout.write(`  ${p}\n`)
    }
  }
}

async function cmdRotateKey(flags: Record<string, string>, configPath: string | undefined): Promise<void> {
  const userId = flags['user']
  const providerName = flags['provider']
  const newKey = process.env['FREEROUTER_NEW_KEY']

  if (userId === undefined || userId === '') {
    process.stderr.write('Error: --user <userId> is required\n')
    process.exit(1)
  }
  if (providerName === undefined || providerName === '') {
    process.stderr.write('Error: --provider <providerName> is required\n')
    process.exit(1)
  }
  if (newKey === undefined || newKey === '') {
    process.stderr.write('Error: FREEROUTER_NEW_KEY env var must be set (new API key)\n')
    process.exit(1)
  }

  let router: FreeRouter
  if (configPath !== undefined) {
    router = await FreeRouter.fromFile(configPath)
  } else {
    router = new FreeRouter()
  }

  router.rotateKey(userId, providerName, newKey)
  process.stdout.write(`Key rotated for user "${userId}" / provider "${providerName}".\n`)
}

async function main(): Promise<void> {
  const { command, configPath, flags, positional } = parseArgs(process.argv)

  switch (command) {
    case 'validate-config':
      await cmdValidateConfig(positional)
      break
    case 'list-providers':
      await cmdListProviders(configPath)
      break
    case 'rotate-key':
      await cmdRotateKey(flags, configPath)
      break
    default:
      process.stdout.write(
        'freerouter CLI\n\n' +
        'Commands:\n' +
        '  validate-config <path>                   Validate a config file\n' +
        '  list-providers [--config <path>]         List registered providers\n' +
        '  rotate-key --user <id> --provider <name> Rotate an API key (reads from FREEROUTER_NEW_KEY env)\n',
      )
      if (command !== '' && command !== 'help') process.exit(1)
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`Error: ${String(err)}\n`)
  process.exit(1)
})

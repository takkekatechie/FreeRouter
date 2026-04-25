import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/providers/index.ts',
    'src/security/index.ts',
    'src/finops/index.ts',
    'src/adapters/index.ts',
    'src/cli.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  splitting: true,
  treeshake: true,
})

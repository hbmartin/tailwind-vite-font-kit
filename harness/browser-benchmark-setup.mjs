// Prepare an isolated source checkout and frozen dependencies; never alter the sibling app.
// node harness/browser-benchmark-setup.mjs /path/to/reference-repo /tmp/font-benchmark-app
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const [source, destination] = process.argv.slice(2)
if (!source || !destination)
  throw new Error('Pass reference repository and NEW disposable directory')
const app = resolve(destination)
if (app.split(/[\\/]/).includes('node_modules') || existsSync(app))
  throw new Error('Use a new directory outside node_modules')
const kit = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const environment = JSON.parse(
  readFileSync(new URL('../docs/performance/2026-09-14/environment.json', import.meta.url)),
)
mkdirSync(app, { recursive: true })
const archive = join(app, 'reference.tar')
execFileSync('git', [
  '-C',
  resolve(source),
  'archive',
  environment.referenceAppCommit,
  '--output',
  archive,
])
execFileSync('tar', ['-xf', archive, '-C', app])
rmSync(archive)
execFileSync('pnpm', ['install', '--frozen-lockfile'], { cwd: app, stdio: 'inherit' })
writeFileSync(
  join(app, 'vite.config.ts'),
  environment.appConfig.replace('<font-kit>/src/index.mjs', `${kit}/src/index.mjs`),
)
writeFileSync(
  join(app, 'benchmark-environment.json'),
  JSON.stringify(
    {
      ...environment,
      appConfig: undefined,
      kitCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: kit, encoding: 'utf8' }).trim(),
      kitDirty: Boolean(
        execFileSync('git', ['status', '--porcelain'], { cwd: kit, encoding: 'utf8' }).trim(),
      ),
    },
    null,
    2,
  ),
)
console.log(
  `Prepared ${app}. Build with node node_modules/vite/bin/vite.js build in that directory.`,
)

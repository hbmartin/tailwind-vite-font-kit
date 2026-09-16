#!/usr/bin/env node
// Record enough floating-runner and floating-fixture context to reproduce a weekly result.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const referenceApp = resolve(process.argv[2] || 'reference-app')
const outputPath = resolve(process.argv[3] || 'cls-environment.json')
const kitRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const run = (command, args, cwd = kitRoot) => {
  // Node's test coverage is inherited by child processes. Capturing `pnpm --version`
  // under the unit test must not add pnpm's 5 MB bundled CLI to this package's coverage.
  const env = { ...process.env }
  delete env.NODE_V8_COVERAGE
  return execFileSync(command, args, { cwd, env, encoding: 'utf8' }).trim()
}
const errors = {}
const capture = (key, action) => {
  try {
    return action()
  } catch (error) {
    errors[key] = { message: error.message, code: error.code ?? null }
    return null
  }
}
const packageVersionFor = (entry, expectedName) => {
  let directory = dirname(entry)
  while (true) {
    const packagePath = join(directory, 'package.json')
    if (existsSync(packagePath)) {
      const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'))
      if (packageJson.name === expectedName) {
        if (typeof packageJson.version !== 'string' || !packageJson.version) {
          throw new Error(`${expectedName} package metadata has no valid version`)
        }
        return packageJson.version
      }
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  throw new Error(`Could not find ${expectedName} package metadata from ${entry}`)
}

const requireFromReference = createRequire(join(referenceApp, 'package.json'))
const puppeteerEntry = capture('runtime.puppeteer.entry', () =>
  requireFromReference.resolve('puppeteer'),
)
/** @type {any} */
let puppeteer = null
if (puppeteerEntry) {
  try {
    const puppeteerModule = await import(pathToFileURL(puppeteerEntry).href)
    puppeteer = puppeteerModule.default || puppeteerModule
  } catch (error) {
    errors['runtime.puppeteer.import'] = { message: error.message, code: error.code ?? null }
  }
}
const browserPath = puppeteer
  ? capture('runtime.browser.path', () => puppeteer.executablePath())
  : null
const puppeteerVersion = puppeteerEntry
  ? capture('runtime.puppeteer.version', () => packageVersionFor(puppeteerEntry, 'puppeteer'))
  : null

const environment = {
  kitSha: process.env.GITHUB_SHA || capture('kitSha', () => run('git', ['rev-parse', 'HEAD'])),
  referenceAppSha: capture('referenceAppSha', () =>
    run('git', ['rev-parse', 'HEAD'], referenceApp),
  ),
  referenceAppRemote: process.env.REFERENCE_APP || null,
  runner: {
    os: process.env.RUNNER_OS || process.platform,
    arch: process.env.RUNNER_ARCH || process.arch,
    imageOS: process.env.ImageOS || null,
    imageVersion: process.env.ImageVersion || null,
  },
  runtime: {
    node: process.version,
    pnpm: capture('runtime.pnpm', () => run('pnpm', ['--version'])),
    puppeteer: puppeteerVersion,
    browser: browserPath
      ? capture('runtime.browser.version', () => run(browserPath, ['--version']))
      : null,
  },
  metadataErrors: errors,
}

writeFileSync(outputPath, JSON.stringify(environment, null, 2))

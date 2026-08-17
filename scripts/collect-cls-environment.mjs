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
const run = (command, args, cwd = kitRoot) =>
  execFileSync(command, args, { cwd, encoding: 'utf8' }).trim()
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
const puppeteerEntry = requireFromReference.resolve('puppeteer')
const puppeteerModule = await import(pathToFileURL(puppeteerEntry).href)
const puppeteer = puppeteerModule.default || puppeteerModule
const browserPath = puppeteer.executablePath()
const puppeteerVersion = packageVersionFor(puppeteerEntry, 'puppeteer')

const environment = {
  kitSha: process.env.GITHUB_SHA || run('git', ['rev-parse', 'HEAD']),
  referenceAppSha: run('git', ['rev-parse', 'HEAD'], referenceApp),
  referenceAppRemote: process.env.REFERENCE_APP || null,
  runner: {
    os: process.env.RUNNER_OS || process.platform,
    arch: process.env.RUNNER_ARCH || process.arch,
    imageOS: process.env.ImageOS || null,
    imageVersion: process.env.ImageVersion || null,
  },
  runtime: {
    node: process.version,
    pnpm: run('pnpm', ['--version']),
    puppeteer: puppeteerVersion,
    browser: run(browserPath, ['--version']),
  },
}

writeFileSync(outputPath, JSON.stringify(environment, null, 2))

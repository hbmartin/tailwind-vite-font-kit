#!/usr/bin/env node
// Record enough floating-runner and floating-fixture context to reproduce a weekly result.

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const referenceApp = resolve(process.argv[2] || 'reference-app')
const outputPath = resolve(process.argv[3] || 'cls-environment.json')
const kitRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const run = (command, args, cwd = kitRoot) =>
  execFileSync(command, args, { cwd, encoding: 'utf8' }).trim()

const requireFromReference = createRequire(join(referenceApp, 'package.json'))
const puppeteerEntry = requireFromReference.resolve('puppeteer')
const puppeteerModule = await import(pathToFileURL(puppeteerEntry).href)
const puppeteer = puppeteerModule.default || puppeteerModule
const browserPath = puppeteer.executablePath()
const dependencyReport = JSON.parse(
  run('pnpm', ['list', 'puppeteer', '--depth', '0', '--json'], referenceApp),
)[0]
const puppeteerDependency =
  dependencyReport.devDependencies?.puppeteer || dependencyReport.dependencies?.puppeteer || null

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
    puppeteer: puppeteerDependency?.version || null,
    browser: run(browserPath, ['--version']),
  },
}

writeFileSync(outputPath, JSON.stringify(environment, null, 2))

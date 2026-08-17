#!/usr/bin/env node
// Render the body of the "Weekly CLS sweep failed" issue on stdout.
//
// Split out of the workflow's inline github-script so the table has exactly one
// implementation (scripts/lib/cls-report.mjs) and this file can be tested.
//
//   RUN_URL=... COMMIT_SHA=... node scripts/write-cls-issue-body.mjs cls-metrics.json cls-environment.json

import { readFileSync } from 'node:fs'
import { environmentSentence, format, gateErrorLines, probeTable } from './lib/cls-report.mjs'

const [metricsPath = 'cls-metrics.json', environmentPath = 'cls-environment.json'] =
  process.argv.slice(2)
const runUrl = process.env.RUN_URL || ''
const sha = (process.env.COMMIT_SHA || 'unknown').slice(0, 8)
const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

const lines = [`The weekly CLS sweep failed on \`${sha}\`.`, '', `[Run](${runUrl})`, '']
const metrics = readJson(metricsPath)
if (metrics) {
  if (metrics.worst) {
    lines.push(
      `Worst: **${metrics.worst.k} = ${format(metrics.worst.cls)}** (threshold ${metrics.threshold})`,
      '',
    )
  }
  lines.push(...probeTable(metrics.rows || []))
  lines.push(...gateErrorLines(metrics.gate?.errors || [], 'Gate errors:'))
} else {
  lines.push(
    'The job failed before producing gated measurements. Inspect the checkout, build, and sweep steps.',
  )
}

const environment = readJson(environmentPath)
if (environment) lines.push('', environmentSentence(environment))

lines.push(
  '',
  'Check the dedicated CLS trend before treating a single breach as a regression:',
  '```',
  'git fetch origin "refs/notes/*:refs/notes/*" && git log --notes=cls',
  '```',
)

console.log(lines.join('\n'))

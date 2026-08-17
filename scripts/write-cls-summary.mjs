#!/usr/bin/env node
// Render the weekly result as GitHub-flavored Markdown for GITHUB_STEP_SUMMARY.

import { existsSync, readFileSync } from 'node:fs'
import { format, gateErrorLines, probeTable, widthTable } from './lib/cls-report.mjs'

const read = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null)
const metrics = read(process.argv[2] || 'cls-metrics.json')
const environment = metrics?.context || read(process.argv[3] || 'cls-environment.json')
const widthSweep = metrics?.widthSweep || read(process.argv[4] || 'cls-widths.json')

console.log('### Weekly CLS gate\n')
if (!metrics) {
  console.log('No gated measurements were produced. See the failed build or sweep step.\n')
} else {
  console.log(
    `Gate: **${metrics.gate.passed ? 'passed' : 'failed'}** at threshold \`${metrics.threshold}\`.`,
  )
  if (metrics.worst) console.log(` Worst: **${metrics.worst.k} = ${format(metrics.worst.cls)}**.`)
  console.log('')
  for (const line of probeTable(metrics.rows)) console.log(line)
  for (const line of gateErrorLines(metrics.gate.errors, 'Validation errors:')) console.log(line)
  const families = [...new Set(metrics.loadedFallbacks.map((face) => face.family))]
  console.log(
    `\nPre-swap loaded fallbacks: ${families.length ? families.map((name) => `\`${name}\``).join(', ') : 'none'}.`,
  )
}

if (environment) {
  console.log('\n#### Environment\n')
  console.log(`- Kit: \`${environment.kitSha}\``)
  console.log(`- Reference app: \`${environment.referenceAppSha}\` (floating HEAD)`)
  console.log(
    `- Runner: \`${environment.runner.imageOS || environment.runner.os} ${environment.runner.imageVersion || ''}\``,
  )
  console.log(
    `- Runtime: Node \`${environment.runtime.node}\`, pnpm \`${environment.runtime.pnpm}\`, Puppeteer \`${environment.runtime.puppeteer}\``,
  )
  console.log(`- Browser: \`${environment.runtime.browser}\``)
}

const summaries = widthSweep?.summaries
if (Array.isArray(summaries)) {
  console.log('\n#### Width sweep (diagnostic, non-gating)\n')
  for (const line of widthTable(summaries)) console.log(line)
}

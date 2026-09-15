// Historical summaries are read-only by default. Saving always requires a new path.
import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { validate, compare } from './browser-benchmark-validation.mjs'
import { assertNewOutputs, outputPaths } from './browser-benchmark-output.mjs'
const {
  positionals: [input, manifestPath, baselinePath],
  values,
} = parseArgs({
  allowPositionals: true,
  options: { output: { type: 'string' }, diagnostic: { type: 'boolean' } },
})
if (!input)
  throw new Error(
    'Pass results.json [manifest.json] [baseline-results.json] [--output NEW.json] [--diagnostic]',
  )
if (values.output) {
  outputPaths(values.output)
  assertNewOutputs([values.output])
}
const read = (p) => JSON.parse(readFileSync(p, 'utf8'))
const options = manifestPath ? read(manifestPath) : { strict: false }
const summary = validate(read(input), options)
if (baselinePath)
  summary.comparison = compare(
    validate(read(baselinePath), { ...options, candidate: 'baseline' }),
    summary,
    { mode: values.diagnostic ? 'diagnostic' : 'acceptance' },
  )
if (values.output) writeFileSync(values.output, JSON.stringify(summary, null, 2), { flag: 'wx' })
console.log(JSON.stringify(summary, null, 2))
if (summary.comparison?.failures.length) process.exitCode = 1

// Historical files omit --manifest; only manifest-validated data can pass comparison.
import { readFileSync, writeFileSync } from 'node:fs'
import { validate, compare } from './browser-benchmark-validation.mjs'
const [input, manifestPath, baselinePath] = process.argv.slice(2)
if (!input) throw new Error('Pass results.json [manifest.json] [baseline-results.json]')
const read = (p) => JSON.parse(readFileSync(p, 'utf8'))
const options = manifestPath ? read(manifestPath) : { strict: false }
const summary = validate(read(input), options)
if (baselinePath) summary.comparison = compare(validate(read(baselinePath), options), summary)
writeFileSync(input.replace(/\.json$/, '-summary.json'), JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary, null, 2))
if (summary.comparison && !summary.comparison.accepted) process.exitCode = 1

// The one renderer for the weekly CLS numbers.
//
// The job summary and the regression issue body show the same table. It used to exist
// twice — once here and once as an inline github-script string inside cls-weekly.yml —
// so a column added to one silently did not appear in the other, and only one of the two
// copies was reachable by a test.

export const format = (value) => (Number.isFinite(value) ? value.toFixed(4) : 'invalid')

/** @param {{k: string, cls: number, clsAll?: number[]}[]} rows */
export const probeTable = (rows) => [
  '| probe | runs | median CLS |',
  '|---|---|---:|',
  ...rows.map(
    (row) => `| ${row.k} | ${(row.clsAll || []).map(format).join(', ')} | ${format(row.cls)} |`,
  ),
]

/** @param {string[]} errors */
export const gateErrorLines = (errors, heading) =>
  errors.length ? ['', heading, ...errors.map((error) => `- ${error}`)] : []

export const environmentSentence = (environment) => {
  const runner = environment.runner || {}
  const runtime = environment.runtime || {}
  return (
    `Environment: reference app \`${environment.referenceAppSha}\`, ` +
    `${runner.imageOS || runner.os} ${runner.imageVersion || ''}, ` +
    `Node ${runtime.node}, Puppeteer ${runtime.puppeteer}, ${runtime.browser}.`
  )
}

// `lineCountChanged` is out of the widths whose line count could actually be READ, not
// out of every width swept — the harness reports the two separately for that reason.
export const widthTable = (summaries) => [
  '| range | widths | median | p90 | max | reflows |',
  '|---|---:|---:|---:|---:|---:|',
  ...summaries.map(
    (s) =>
      `| ${s.name} | ${s.widths} | ${format(s.median)} | ${format(s.p90)} | ${format(s.max)} | ` +
      `${s.lineCountChanged}/${s.lineCountMeasured ?? s.widths} |`,
  ),
]

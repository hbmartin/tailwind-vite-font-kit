import assert from 'node:assert/strict'
export const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
export const cellKey = (r) =>
  `${r.group}/${typeof r.viewport === 'number' ? r.viewport : r.viewport.width}/${r.height ?? r.viewport.height ?? (r.viewport === 390 ? 844 : 900)}/${r.probe}/${r.variant}/${r.width ?? 0}`
const counts = (rows) => {
  const map = new Map()
  for (const row of rows) map.set(cellKey(row), (map.get(cellKey(row)) ?? 0) + 1)
  return [...map].sort(([a], [b]) => a.localeCompare(b))
}
const fontsOf = (r) => r.resources.filter((f) => /\.woff2?(?:\?|$)/.test(f.name))
export function movement(row) {
  return row.after.elements.map((e, i) => ({
    key: `${i}:${e.tag}:${e.probe ?? ''}`,
    y: Math.abs(e.rect.y - row.before.elements[i].rect.y),
    height: Math.abs(e.rect.height - row.before.elements[i].rect.height),
  }))
}
export function validate(
  results,
  {
    cases,
    families = { hero: ['Manrope', 'Fraunces'], tailwind: ['Manrope'], normal: ['Manrope'] },
    strict = true,
  } = {},
) {
  assert(results.length > 0, 'No observations')
  assert.equal(new Set(results.map((r) => r.id)).size, results.length, 'Duplicate run IDs')
  if (strict) assert(cases?.length, 'A case manifest is required')
  if (cases)
    assert.deepEqual(counts(results), counts(cases), 'Incomplete, unexpected, or duplicate cells')
  for (const r of results) {
    assert(Number.isFinite(r.cls) && r.cls >= 0, `${r.id}: invalid CLS`)
    assert(r.before?.elements.length && r.after?.elements.length, `${r.id}: missing geometry`)
    assert.equal(r.before.elements.length, r.after.elements.length, `${r.id}: changed probes`)
    for (const [i, e] of r.after.elements.entries()) {
      assert.equal(
        `${e.tag}/${e.probe}`,
        `${r.before.elements[i].tag}/${r.before.elements[i].probe}`,
        `${r.id}: changed probe identity`,
      )
      for (const rect of [e.rect, r.before.elements[i].rect])
        assert(
          ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(rect[k])),
          `${r.id}: invalid geometry`,
        )
    }
    if (strict) {
      assert.deepEqual(r.viewport, r.requestedViewport, `${r.id}: viewport mismatch`)
      assert.deepEqual(r.errors, [], `${r.id}: browser errors`)
      assert.equal(r.hidden, false, `${r.id}: hidden page`)
      assert(
        r.resources.every((f) => f.status >= 200 && f.status < 400),
        `${r.id}: failed request`,
      )
    }
    assert(families[r.probe], `${r.id}: missing expected families for ${r.probe}`)
    const expectedFamilies = r.variant === 'system' ? [] : families[r.probe]
    const fonts = fontsOf(r)
    assert.equal(fonts.length, expectedFamilies.length, `${r.id}: missing or duplicate fonts`)
    assert.equal(
      new Set(fonts.map((f) => f.name)).size,
      fonts.length,
      `${r.id}: duplicate font URL`,
    )
    assert(
      fonts.every((f) => f.encoded > 0 && f.transfer > 0),
      `${r.id}: cached/empty font response`,
    )
    if (r.delay >= 1500 && expectedFamilies.length) {
      assert(r.before.at < Math.min(...fonts.map((f) => f.end)), `${r.id}: late before-snapshot`)
      assert(
        r.before.faces.some((f) => f.status === 'loading'),
        `${r.id}: no font loading`,
      )
    }
    if (!['system', 'optional'].includes(r.variant))
      for (const family of expectedFamilies) {
        assert(
          r.after.faces.some((f) => f.family === family && f.status === 'loaded'),
          `${r.id}: ${family} never loaded`,
        )
        if (!['swap', 'swap-preload'].includes(r.variant) && r.delay >= 1500) {
          const prefix = r.variant === 'fontaine' ? `${family} fallback` : `${family} Fallback:`
          assert(
            r.before.faces.some((f) => f.family.startsWith(prefix) && f.status === 'loaded'),
            `${r.id}: ${family} fallback never loaded`,
          )
        }
      }
  }
  const groups = Map.groupBy(results, cellKey)
  return {
    loads: results.length,
    userAgents: [...new Set(results.map((r) => r.userAgent))].sort(),
    validated: true,
    completenessChecked: Boolean(cases),
    summary: [...groups].map(([key, rows]) => ({
      key,
      runs: rows.length,
      cls: median(rows.map((r) => r.cls)),
      min: Math.min(...rows.map((r) => r.cls)),
      max: Math.max(...rows.map((r) => r.cls)),
      fcp: median(rows.map((r) => r.fcp)),
      fontBytes: median(rows.map((r) => fontsOf(r).reduce((n, f) => n + f.encoded, 0))),
      movement: movement(rows[0]).map((m, i) => ({
        key: m.key,
        y: median(rows.map((r) => movement(r)[i].y)),
        height: median(rows.map((r) => movement(r)[i].height)),
      })),
    })),
  }
}
export function compare(baseline, candidate) {
  assert(
    baseline.validated &&
      candidate.validated &&
      baseline.completenessChecked &&
      candidate.completenessChecked,
    'Only complete validated runs can be accepted',
  )
  assert.deepEqual(baseline.userAgents, candidate.userAgents, 'Browser/platform mismatch')
  const base = new Map(baseline.summary.map((c) => [c.key, c]))
  assert.deepEqual(
    [...base.keys()].sort(),
    candidate.summary.map((c) => c.key).sort(),
    'Unpaired comparison',
  )
  const failures = []
  for (const c of candidate.summary) {
    const b = base.get(c.key)
    assert(c.runs >= 3 && b.runs >= 3, 'At least three repetitions required')
    if (+c.cls.toFixed(6) > +b.cls.toFixed(6))
      failures.push({ key: c.key, reason: 'CLS regression', baseline: b.cls, candidate: c.cls })
    assert.deepEqual(
      c.movement.map((m) => m.key),
      b.movement.map((m) => m.key),
      'Unpaired geometry',
    )
    if (c.movement.some((m, i) => m.y > b.movement[i].y || m.height > b.movement[i].height))
      failures.push({ key: c.key, reason: 'Geometry regression' })
    if (
      c.key.includes('/380/900/hero/') &&
      (c.cls > 0.02 || c.movement.some((m) => m.y > 0 || m.height > 0))
    )
      failures.push({ key: c.key, reason: '380px acceptance gate', cls: c.cls })
  }
  assert(
    candidate.summary.some((c) => c.key.includes('/380/900/hero/')),
    'Missing 380px acceptance cell',
  )
  return { dataValid: true, accepted: failures.length === 0, failures }
}

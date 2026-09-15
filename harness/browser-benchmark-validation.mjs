import assert from 'node:assert/strict'
import { fontAssetPattern } from './browser-benchmark-assets.mjs'
export const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
export const cellKey = (r) => {
  const width = typeof r.viewport === 'number' ? r.viewport : r.viewport.width
  return `${r.group ?? 'matrix'}/${width}/${r.height ?? r.viewport.height ?? (width === 390 ? 844 : 900)}/${r.probe}/${r.variant}/${r.width ?? 0}/${r.delay ?? 2000}`
}
const identities = (snapshot) =>
  snapshot.elements.map((e, i) => JSON.stringify([i, e.tag, e.probe, e.text]))
const fontPath = (name) => {
  const url = new URL(name)
  return url.pathname.replace(/^\/__bench\/[^/]+/, '') + url.search
}
const sourceAssets = (experiment) =>
  experiment.assets
    .map(({ path, type, sourceHash }) => ({ path, type, sourceHash }))
    .sort((a, b) => a.path.localeCompare(b.path))
const servedAssets = (experiment) =>
  experiment.assets
    .map(({ path, type, servedHash }) => ({ path, type, servedHash }))
    .sort((a, b) => a.path.localeCompare(b.path))
const counts = (rows) => {
  const map = new Map()
  for (const row of rows) map.set(cellKey(row), (map.get(cellKey(row)) ?? 0) + 1)
  return [...map].sort(([a], [b]) => a.localeCompare(b))
}
const fontsOf = (r) => r.resources.filter((f) => fontAssetPattern.test(f.name))
export function movement(row) {
  const keys = identities(row.after)
  return row.after.elements.map((e, i) => ({
    key: keys[i],
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
    candidate = 'baseline',
  } = {},
) {
  assert(typeof strict === 'boolean', 'strict must be boolean')
  assert(results.length > 0, 'No observations')
  if (strict)
    assert.equal(new Set(results.map((r) => r.userAgent)).size, 1, 'Mixed browser identities')
  assert.equal(new Set(results.map((r) => r.id)).size, results.length, 'Duplicate run IDs')
  if (strict) assert(cases?.length, 'A case manifest is required')
  if (cases)
    assert.deepEqual(counts(results), counts(cases), 'Incomplete, unexpected, or duplicate cells')
  for (const r of results) {
    assert(Number.isFinite(r.delay) && r.delay >= 0, `${r.id}: invalid delay`)
    assert(Number.isFinite(r.cls) && r.cls >= 0, `${r.id}: invalid CLS`)
    assert(r.before?.elements.length && r.after?.elements.length, `${r.id}: missing geometry`)
    assert.equal(r.before.elements.length, r.after.elements.length, `${r.id}: changed probes`)
    const beforeKeys = identities(r.before)
    const afterKeys = identities(r.after)
    for (const [i, e] of r.after.elements.entries()) {
      assert.equal(afterKeys[i], beforeKeys[i], `${r.id}: changed probe identity`)
      for (const rect of [e.rect, r.before.elements[i].rect])
        assert(
          ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(rect[k])),
          `${r.id}: invalid geometry`,
        )
    }
    if (strict) {
      assert(
        Number.isFinite(r.viewport?.width) &&
          Number.isFinite(r.viewport?.height) &&
          r.viewport.width > 0 &&
          r.viewport.height > 0 &&
          (r.height === undefined || r.height === r.viewport.height) &&
          [r.group ?? 'matrix', r.probe, r.variant].every(
            (part) => typeof part === 'string' && part.length > 0 && !part.includes('/'),
          ),
        `${r.id}: invalid cell identity`,
      )
      assert(
        typeof r.userAgent === 'string' && r.userAgent.length,
        `${r.id}: missing browser identity`,
      )
      for (const snapshot of [r.before, r.after]) {
        assert(
          Number.isFinite(snapshot.layoutWidth) && snapshot.layoutWidth > 0,
          `${r.id}: missing layout width`,
        )
        assert(
          snapshot.elements.every((e) => typeof e.text === 'string'),
          `${r.id}: missing element identity`,
        )
      }
      assert.equal(r.experiment?.candidate, candidate, `${r.id}: wrong candidate proxy`)
      assert(
        /^[a-f0-9]{64}$/.test(r.experiment?.transformId ?? ''),
        `${r.id}: missing transform identity`,
      )
      assert(r.experiment?.assets?.length, `${r.id}: missing asset evidence`)
      assert(
        r.experiment.assets.every(
          (a) =>
            a.path.startsWith('/') &&
            typeof a.type === 'string' &&
            /^[a-f0-9]{64}$/.test(a.sourceHash) &&
            /^[a-f0-9]{64}$/.test(a.servedHash),
        ),
        `${r.id}: invalid asset evidence`,
      )
      assert.equal(
        new Set(r.experiment.assets.map((a) => a.path)).size,
        r.experiment.assets.length,
        `${r.id}: duplicate asset evidence`,
      )
      if (r.variant === 'kit' && candidate === 'baseline')
        assert(
          r.experiment.assets
            .filter((a) => a.type.includes('text/css'))
            .every((a) => a.sourceHash === a.servedHash),
          `${r.id}: baseline kit CSS changed`,
        )
      if (r.variant === 'kit' && candidate !== 'baseline')
        assert(
          r.experiment.assets.some(
            (a) => a.type.includes('text/css') && a.sourceHash !== a.servedHash,
          ),
          `${r.id}: candidate did not change CSS`,
        )
      if (r.variant === 'fontaine') {
        const fontaine = r.experiment.fontaine
        assert(
          /^\/assets\/[^?#]+\.css$/.test(fontaine?.path ?? '') &&
            /^[a-f0-9]{64}$/.test(fontaine?.cssHash ?? '') &&
            fontaine?.applied === true &&
            r.experiment.assets.some(
              (a) => a.path.split('?')[0] === fontaine.path && a.type.includes('text/css'),
            ),
          `${r.id}: Fontaine CSS was not applied`,
        )
      }
      assert.deepEqual(r.viewport, r.requestedViewport, `${r.id}: viewport mismatch`)
      assert.deepEqual(r.errors, [], `${r.id}: browser errors`)
      assert.equal(r.hidden, false, `${r.id}: hidden page`)
      assert(
        r.resources.every((f) => f.status >= 200 && f.status < 400),
        `${r.id}: failed request`,
      )
    }
    assert(families[r.probe], `${r.id}: missing expected families for ${r.probe}`)
    const expectedFamilies = (r.variant === 'system' ? [] : families[r.probe]).map((f) =>
      typeof f === 'string' ? { name: f, files: null } : f,
    )
    assert(
      expectedFamilies.every(
        (f) =>
          typeof f.name === 'string' &&
          (f.files === null ||
            (Array.isArray(f.files) &&
              f.files.length &&
              f.files.every((p) => typeof p === 'string' && p.startsWith('/')))),
      ),
      `${r.id}: invalid family expectation`,
    )
    const fonts = fontsOf(r)
    assert.equal(
      new Set(fonts.map((f) => fontPath(f.name))).size,
      fonts.length,
      `${r.id}: duplicate font URL`,
    )
    assert.equal(
      fonts.length,
      expectedFamilies.reduce((n, f) => n + (f.files?.length ?? 1), 0),
      `${r.id}: missing or duplicate fonts`,
    )
    for (const family of expectedFamilies)
      if (family.files)
        for (const path of family.files)
          assert(
            fonts.some((f) => fontPath(f.name) === path),
            `${r.id}: missing expected font ${path}`,
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
      for (const { name: family } of expectedFamilies) {
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
  for (const rows of groups.values())
    for (const row of rows) {
      assert.deepEqual(
        identities(row.after),
        identities(rows[0].after),
        `${row.id}: element identities differ across repetitions`,
      )
      if (strict) {
        assert.deepEqual(
          row.experiment,
          rows[0].experiment,
          `${row.id}: experiment differs across repetitions`,
        )
        assert.equal(
          row.before.layoutWidth,
          rows[0].before.layoutWidth,
          `${row.id}: layout width differs across repetitions`,
        )
        assert.equal(
          row.after.layoutWidth,
          rows[0].after.layoutWidth,
          `${row.id}: layout width differs across repetitions`,
        )
      }
    }
  return {
    loads: results.length,
    userAgents: [...new Set(results.map((r) => r.userAgent))].sort(),
    validated: true,
    strictValidated: strict,
    candidate,
    completenessChecked: Boolean(cases),
    summary: [...groups].map(([key, rows]) => {
      const moves = rows.map(movement)
      return {
        key,
        runs: rows.length,
        delay: rows[0].delay,
        experiment: rows[0].experiment,
        layout: [rows[0].before.layoutWidth, rows[0].after.layoutWidth],
        cls: median(rows.map((r) => r.cls)),
        min: Math.min(...rows.map((r) => r.cls)),
        max: Math.max(...rows.map((r) => r.cls)),
        fcp: median(rows.map((r) => r.fcp)),
        fontBytes: median(rows.map((r) => fontsOf(r).reduce((n, f) => n + f.encoded, 0))),
        movement: moves[0].map((m, i) => ({
          key: m.key,
          y: median(moves.map((row) => row[i].y)),
          height: median(moves.map((row) => row[i].height)),
        })),
      }
    }),
  }
}
export function compare(baseline, candidate, { mode = 'acceptance' } = {}) {
  assert(['acceptance', 'diagnostic'].includes(mode), 'Unknown comparison mode')
  assert(
    baseline.strictValidated &&
      candidate.strictValidated &&
      baseline.validated &&
      candidate.validated &&
      baseline.completenessChecked &&
      candidate.completenessChecked,
    'Only complete validated runs can be accepted',
  )
  assert.deepEqual(baseline.userAgents, candidate.userAgents, 'Browser/platform mismatch')
  if (mode === 'acceptance')
    assert(
      baseline.candidate === 'baseline' && candidate.candidate !== 'baseline',
      'Acceptance requires a baseline and an identified candidate',
    )
  const base = new Map(baseline.summary.map((c) => [c.key, c]))
  assert.deepEqual(
    [...base.keys()].sort(),
    candidate.summary.map((c) => c.key).sort(),
    'Unpaired comparison',
  )
  const failures = []
  for (const c of candidate.summary) {
    const b = base.get(c.key)
    assert.equal(b.experiment.candidate, baseline.candidate, 'Baseline cell candidate mismatch')
    assert.equal(c.experiment.candidate, candidate.candidate, 'Candidate cell candidate mismatch')
    assert.deepEqual(c.layout, b.layout, 'Layout width mismatch')
    assert.equal(c.experiment.transformId, b.experiment.transformId, 'Harness transform mismatch')
    assert.deepEqual(
      sourceAssets(c.experiment),
      sourceAssets(b.experiment),
      'Production asset mismatch',
    )
    if (c.key.includes('/fontaine/'))
      assert.deepEqual(c.experiment.fontaine, b.experiment.fontaine, 'Fontaine CSS mismatch')
    const candidateServed = servedAssets(c.experiment)
    const baselineServed = servedAssets(b.experiment)
    if (c.key.includes('/kit/')) {
      assert.deepEqual(
        candidateServed.filter((a) => !a.type.includes('text/css')),
        baselineServed.filter((a) => !a.type.includes('text/css')),
        'Non-CSS asset mismatch',
      )
      const baseCss = new Map(
        baselineServed
          .filter((a) => a.type.includes('text/css'))
          .map((a) => [a.path, a.servedHash]),
      )
      assert(
        candidateServed.some(
          (a) => a.type.includes('text/css') && a.servedHash !== baseCss.get(a.path),
        ),
        'Candidate kit CSS matches baseline',
      )
    } else assert.deepEqual(candidateServed, baselineServed, 'Non-kit served asset mismatch')
    if (mode === 'acceptance')
      assert(c.delay >= 1500 && b.delay >= 1500, 'Acceptance requires delayed font swaps')
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
      mode === 'acceptance' &&
      c.key.includes('/380/900/hero/kit/') &&
      (c.cls > 0.02 || c.movement.some((m) => m.y > 0 || m.height > 0))
    )
      failures.push({ key: c.key, reason: '380px acceptance gate', cls: c.cls })
  }
  if (mode === 'acceptance')
    assert(
      candidate.summary.some((c) => c.key.includes('/380/900/hero/kit/')),
      'Missing 380px kit hero acceptance cell',
    )
  return {
    dataValid: true,
    mode,
    accepted: mode === 'acceptance' ? failures.length === 0 : null,
    failures,
  }
}

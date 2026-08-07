// Project + font detection. Everything here is read-only.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.output',
  '.nitro',
  '.vinxi',
  '.tanstack',
  'coverage',
  '.next',
  '.vercel',
])

export function walk(dir, exts, out = [], depth = 0) {
  if (depth > 6) return out
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      walk(join(dir, e.name), exts, out, depth + 1)
    } else if (exts.some((x) => e.name.endsWith(x))) {
      out.push(join(dir, e.name))
    }
  }
  return out
}

export function detectPackageManager(root) {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock'))) return 'bun'
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(root, 'package-lock.json'))) return 'npm'
  return 'npm'
}

export const TAILWIND_ENTRY_RE = /@import\s+["'](?:tailwindcss)["']/

export function detectTailwindEntry(root) {
  const css = walk(root, ['.css'])
  const hits = css.filter((f) => TAILWIND_ENTRY_RE.test(readFileSync(f, 'utf8')))
  if (!hits.length) return null
  // Prefer the shallowest path, then the shortest name — the app entry, not a nested partial.
  hits.sort((a, b) => {
    const da = relative(root, a).split(sep).length
    const db = relative(root, b).split(sep).length
    return da - db || a.length - b.length
  })
  return { path: hits[0], all: hits }
}

export function detectRootRoute(root) {
  for (const p of [
    'src/routes/__root.tsx',
    'src/routes/__root.jsx',
    'src/routes/__root.ts',
    'src/routes/__root.js',
    'app/routes/__root.tsx',
    'routes/__root.tsx',
  ]) {
    if (existsSync(join(root, p))) return join(root, p)
  }
  const found = walk(root, ['__root.tsx', '__root.jsx', '__root.ts'])
  return found[0] ?? null
}

export function detectViteConfig(root) {
  for (const p of ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs']) {
    if (existsSync(join(root, p))) return join(root, p)
  }
  return null
}

// ---------------------------------------------------------------------------
// Fonts already in the project
// ---------------------------------------------------------------------------

const GOOGLE_IMPORT_RE =
  /@import\s+(?:url\(\s*)?["']?(https:\/\/fonts\.googleapis\.com\/css2?\?[^"')]+)["']?\s*\)?\s*;?/g

/** Expand a css2 axis spec into declared weights. */
export function weightsFromSpec(spec) {
  // 'wght@400;500;700'  |  'opsz,wght@9..144,500;9..144,700'  |  'ital,wght@0,400;1,700'
  const at = spec.indexOf('@')
  if (at === -1) return { weights: [400], axes: null, hasOpsz: false }
  const axisNames = spec.slice(0, at).split(',')
  const tuples = spec.slice(at + 1).split(';')
  const wi = axisNames.indexOf('wght')
  const out = new Set()
  // No wght axis (e.g. 'ital@0;1'): the other axes' values are NOT weights. Return
  // none and let familiesFromGoogleUrl apply its [400] default.
  if (wi !== -1) {
    for (const t of tuples) {
      const raw = t.split(',')[wi]
      if (!raw) continue
      if (raw.includes('..')) {
        const [lo, hi] = raw.split('..').map(Number)
        for (const w of [400, 500, 600, 700]) if (w >= lo && w <= hi) out.add(w)
        if (!out.size) {
          out.add(lo)
          out.add(hi)
        }
      } else if (/^\d+$/.test(raw)) {
        out.add(Number(raw))
      }
    }
  }
  return {
    weights: [...out].sort((a, b) => a - b),
    axes: axisNames.length > 1 || axisNames[0] !== 'wght' ? spec : null,
    hasOpsz: axisNames.includes('opsz'),
  }
}

/** Families referenced by a Google Fonts css2 URL. */
export function familiesFromGoogleUrl(url) {
  const out = []
  const qs = url.slice(url.indexOf('?') + 1)
  for (const part of qs.split('&')) {
    if (!part.startsWith('family=')) continue
    const val = decodeURIComponent(part.slice('family='.length))
    const [rawName, spec = 'wght@400'] = val.split(':')
    const name = rawName.replace(/\+/g, ' ').trim()
    const { weights, axes, hasOpsz } = weightsFromSpec(spec)
    out.push({ name, weights: weights.length ? weights : [400], axes, hasOpsz })
  }
  return out
}

const norm = (s) => s.replace(/^['"]|['"]$/g, '').trim()

/** Split a font-family value on top-level commas. */
function splitStack(value) {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Find `--font-*: <stack>` declarations and `font-family: <stack>` usages. */
export function scanCssFonts(css) {
  const themeVars = []
  for (const m of css.matchAll(/(--font-[a-z0-9-]+)\s*:\s*([^;}]+)[;}]/gi)) {
    const stack = splitStack(m[2])
    themeVars.push({ varName: m[1], stack, first: norm(stack[0] ?? ''), index: m.index })
  }
  const usages = []
  for (const m of css.matchAll(/font-family\s*:\s*([^;}]+)[;}]/gi)) {
    const stack = splitStack(m[1])
    usages.push({ stack, first: norm(stack[0] ?? ''), index: m.index })
  }
  const googleUrls = [...css.matchAll(GOOGLE_IMPORT_RE)].map((m) => m[1])
  return { themeVars, usages, googleUrls }
}

/** Byte ranges of every `@theme` / `@theme inline` block. */
export function themeBlocks(css) {
  const out = []
  for (const m of css.matchAll(/@theme\b([^{]*)\{/g)) {
    const open = m.index + m[0].length - 1
    let depth = 1
    let i = open + 1
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++
      else if (css[i] === '}') depth--
      i++
    }
    out.push({ start: m.index, bodyStart: open + 1, end: i, inline: /\binline\b/.test(m[1]) })
  }
  return out
}

const SERIFY = /serif|slab|display|playfair|fraunces|lora|merriweather|georgia/i
const MONOISH = /mono|code|courier/i

/** Stack entries that are generic keywords or system stacks, not downloadable families. */
export const GENERIC_STACK_RE = /^(ui-|system-ui|sans-serif|serif|monospace|var\(|inherit)/i

/**
 * Merge everything into a font plan.
 * Priority: explicit flags > fonts already in the project.
 */
export function buildFontPlan({ cssText, flags }) {
  const { themeVars, usages, googleUrls } = scanCssFonts(cssText)
  const detected = []
  for (const url of googleUrls) {
    for (const f of familiesFromGoogleUrl(url)) {
      if (!detected.some((d) => d.name.toLowerCase() === f.name.toLowerCase())) detected.push(f)
    }
  }

  // Any --font-* whose first entry is a real family name (not a generic keyword) also counts.
  for (const tv of themeVars) {
    const n = tv.first
    if (!n || GENERIC_STACK_RE.test(n)) continue
    if (!detected.some((d) => d.name.toLowerCase() === n.toLowerCase())) {
      detected.push({ name: n, weights: [400, 500, 600, 700], axes: null, hasOpsz: false })
    }
  }

  const assigned = []
  const takenVars = new Set()

  const attach = (fam, forcedVar) => {
    // theme var: an existing --font-* that already points at this family, else forced/heuristic.
    const tv = themeVars.find((t) => t.first.toLowerCase() === fam.name.toLowerCase())
    let themeVar = forcedVar ?? tv?.varName
    if (!themeVar) {
      const cand = MONOISH.test(fam.name)
        ? '--font-mono'
        : SERIFY.test(fam.name)
          ? '--font-display'
          : '--font-sans'
      themeVar = takenVars.has(cand)
        ? `--font-${fam.name.toLowerCase().replace(/\W+/g, '-')}`
        : cand
    }
    while (takenVars.has(themeVar)) themeVar += '-2'
    takenVars.add(themeVar)

    // stack tail: whatever followed the family in the existing declaration.
    const usage = tv ?? usages.find((u) => u.first.toLowerCase() === fam.name.toLowerCase())
    let stack = usage ? usage.stack.slice(1).map(norm) : null
    if (!stack || !stack.length) {
      stack =
        themeVar === '--font-mono'
          ? ['ui-monospace', 'monospace']
          : themeVar === '--font-display'
            ? ['Georgia', 'serif']
            : ['ui-sans-serif', 'system-ui', 'sans-serif']
    }
    assigned.push({
      name: fam.name,
      themeVar,
      weights: fam.weights,
      axes: fam.axes ?? undefined,
      opszPin: fam.hasOpsz ? (themeVar === '--font-display' ? 48 : 16) : undefined,
      stack,
      preloadWeights: [],
      sourceUsages: usages.filter((u) => u.first.toLowerCase() === fam.name.toLowerCase()).length,
    })
  }

  if (flags.sans || flags.display || flags.mono) {
    // Explicit flags win. A flagged family reuses detected weights/axes when the name matches.
    const pick = (name) =>
      detected.find((d) => d.name.toLowerCase() === name.toLowerCase()) ?? {
        name,
        weights: [400, 500, 600, 700],
        axes: null,
        hasOpsz: false,
      }
    if (flags.sans) attach(pick(flags.sans), '--font-sans')
    if (flags.display) attach(pick(flags.display), '--font-display')
    if (flags.mono) attach(pick(flags.mono), '--font-mono')
  } else {
    // Adopt what the project already uses. Sans-ish first so it gets --font-sans.
    detected.sort((a, b) => Number(SERIFY.test(a.name)) - Number(SERIFY.test(b.name)))
    for (const f of detected) attach(f)
  }

  // Preload budget: body face of the primary family only. Measured: adding a 66 kB
  // display face costs ~156 ms of FCP.
  const primary = assigned.find((a) => a.themeVar === '--font-sans') ?? assigned[0]
  if (primary) primary.preloadWeights = [primary.weights.includes(400) ? 400 : primary.weights[0]]
  if (flags.preload === 'none') for (const a of assigned) a.preloadWeights = []
  if (flags.preload === 'all')
    for (const a of assigned) a.preloadWeights = [a.weights.includes(400) ? 400 : a.weights[0]]

  return { detected, assigned, googleUrls, themeVars }
}

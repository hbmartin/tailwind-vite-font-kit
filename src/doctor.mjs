import { existsSync, readFileSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { init, parse } from 'es-module-lexer'
import { mask } from './codemod-vite.mjs'
import { assertFontHost } from './font-host.mjs'
import { detectTailwindEntry, themeBlocks } from './detect.mjs'
import { runInDoctorContext } from './doctor-context.mjs'
import { resolvePreloadDelivery } from './preload-delivery.mjs'
import { requestHasRangedOpsz } from './opsz.mjs'

const FONT_PLUGIN = 'tailwind-vite-font-kit'
const TAILWIND_PLUGIN = '@tailwindcss/vite'
const SERVER_ENTRY_SPECIFIER = 'tailwind-vite-font-kit/start-server'

await init

const check = (status, message) => ({ status, message })

const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function serverEntryBindings(statement) {
  const match = /^\s*import\s+([\s\S]*?)\s+from\s*['"]/m.exec(statement)
  if (!match || /^type\b/.test(match[1].trim())) return []
  const clause = match[1].trim()
  const bindings = []
  const defaultBinding = /^([\w$]+)(?:\s*,|$)/.exec(clause)?.[1]
  if (defaultBinding) bindings.push(defaultBinding)
  const named = /\{([\s\S]*?)\}/.exec(clause)?.[1]
  if (named) {
    for (const raw of named.split(',')) {
      const imported = /^createFontsServerEntry(?:\s+as\s+([\w$]+))?$/.exec(raw.trim())
      if (imported) bindings.push(imported[1] ?? 'createFontsServerEntry')
      const importedDefault = /^default\s+as\s+([\w$]+)$/.exec(raw.trim())
      if (importedDefault) bindings.push(importedDefault[1])
    }
  }
  const namespace = /\*\s+as\s+([\w$]+)/.exec(clause)?.[1]
  if (namespace) bindings.push(`${namespace}.createFontsServerEntry`, `${namespace}.default`)
  return bindings
}

function closingParen(masked, open) {
  let depth = 1
  for (let index = open + 1; index < masked.length; index++) {
    if (masked[index] === '(') depth++
    if (masked[index] === ')' && --depth === 0) return index
  }
  return -1
}

function classifyServerOptions(source) {
  if (!source.trim()) return 'early-hints'
  const masked = mask(source)
  const first = masked.search(/\S/)
  if (first === -1) return 'early-hints'
  const last = masked.search(/\s*$/)
  const active = masked.slice(first, last)
  const originalSource = source.slice(first, last)
  if (!active.startsWith('{') || !active.endsWith('}')) return 'unknown'

  const ranges = []
  let start = 1
  let depth = 0
  for (let index = 1; index < active.length - 1; index++) {
    if ('{[('.includes(active[index])) depth++
    else if ('}])'.includes(active[index])) depth--
    else if (active[index] === ',' && depth === 0) {
      ranges.push([start, index])
      start = index + 1
    }
  }
  ranges.push([start, active.length - 1])

  let linkHeader
  let earlyHints
  for (const [from, to] of ranges) {
    const property = active.slice(from, to)
    const original = originalSource.slice(from, to)
    if (/^\s*(?:\.\.\.|\[)/.test(property)) return 'unknown'
    for (const name of ['linkHeader', 'earlyHints']) {
      const found = new RegExp(`^\\s*${name}\\s*:\\s*(true|false)\\b`).exec(property)
      const quoted = new RegExp(`^\\s*(["'])${name}\\1\\s*:\\s*(true|false)\\b`).exec(original)
      if (found || quoted) {
        const value = (found?.[1] ?? quoted?.[2]) === 'true'
        if (name === 'linkHeader') linkHeader = value
        else earlyHints = value
      } else if (
        new RegExp(`^\\s*${name}\\b`).test(property) ||
        new RegExp(`^\\s*(["'])${name}\\1\\s*:`).test(original)
      ) {
        return 'unknown'
      }
    }
  }
  if (linkHeader === true) return 'link-header'
  if (earlyHints === false) return 'disabled'
  return 'early-hints'
}

function detectServerEntryDelivery(root) {
  const file = join(root, 'src', 'server.ts')
  if (!existsSync(file)) return 'none'
  const source = readFileSync(file, 'utf8')
  let imports
  try {
    ;[imports] = parse(source)
  } catch {
    return source.includes(SERVER_ENTRY_SPECIFIER) ? 'unknown' : 'none'
  }
  const bindings = imports.flatMap((entry) => {
    if (entry.n !== SERVER_ENTRY_SPECIFIER || entry.d !== -1) return []
    return serverEntryBindings(source.slice(entry.ss, entry.se))
  })
  if (!bindings.length) return 'none'

  const active = mask(source)
  for (const binding of bindings) {
    const expression = binding.split('.').map(escapeRe).join('\\s*\\.\\s*')
    const call = new RegExp(`\\bexport\\s+default\\s+${expression}\\s*\\(`).exec(active)
    if (!call) continue
    const open = call.index + call[0].lastIndexOf('(')
    const close = closingParen(active, open)
    if (close === -1) return 'unknown'
    return classifyServerOptions(source.slice(open + 1, close))
  }
  return 'none'
}

async function preloadBytes(preloads, generation, fetchImpl, timeoutMs) {
  const unique = [...new Set(preloads.map((preload) => preload.href))]
  let bytes = 0
  for (const href of unique) {
    const url = new URL(href, 'http://tss-fonts.local')
    const name = basename(url.pathname)
    const local = generation.digests?.[name]
    if (local) {
      bytes += local.bytes
      continue
    }
    // A self-hosted preload without digest metadata means the generated asset cannot be
    // proved present. CDN preloads are measured from the exact URL the browser will use.
    if (url.origin === 'http://tss-fonts.local') {
      throw new Error(`generated preload asset ${name} has no recorded byte digest`)
    }
    assertFontHost(href, 'preload')
    const response = await fetchImpl(href, {
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`${href} returned HTTP ${response.status}`)
    const body = Buffer.from(await response.arrayBuffer())
    if (body.length < 4 || body.subarray(0, 4).toString('ascii') !== 'wOF2') {
      throw new Error(`${href} did not return WOFF2 bytes`)
    }
    bytes += body.length
  }
  return { bytes, count: unique.length }
}

/**
 * Diagnose an already-resolved Vite config. Exported so the rules can be tested without
 * loading a fixture or touching the network.
 */
export async function diagnoseResolvedConfig(
  root,
  resolved,
  { fetchImpl = fetch, preloadTimeoutMs = 60_000 } = {},
) {
  const checks = []
  const plugins = resolved.plugins ?? []
  const fontPlugins = plugins.filter((plugin) => plugin.name === FONT_PLUGIN)
  if (fontPlugins.length !== 1) {
    checks.push(
      check(
        'failure',
        fontPlugins.length
          ? `Vite resolved ${fontPlugins.length} ${FONT_PLUGIN} plugins; expected exactly one`
          : `${FONT_PLUGIN} is missing from the resolved Vite plugins`,
      ),
    )
    return checks
  }

  const plugin = fontPlugins[0]
  const fontIndex = plugins.indexOf(plugin)
  const tailwindIndexes = plugins
    .map((candidate, index) => ({ candidate, index }))
    .filter(
      ({ candidate }) =>
        candidate.name === TAILWIND_PLUGIN || candidate.name?.startsWith(`${TAILWIND_PLUGIN}:`),
    )
    .map(({ index }) => index)
  if (!tailwindIndexes.length) {
    checks.push(check('failure', `${TAILWIND_PLUGIN} is missing from the resolved Vite plugins`))
  } else if (tailwindIndexes.some((index) => fontIndex > index)) {
    checks.push(check('failure', `${FONT_PLUGIN} must be listed before ${TAILWIND_PLUGIN}`))
  } else {
    checks.push(check('pass', `${FONT_PLUGIN} resolves before ${TAILWIND_PLUGIN}`))
  }

  const diagnostics = plugin.api?.getDiagnostics?.()
  if (!diagnostics?.generation || !diagnostics?.options) {
    checks.push(check('failure', `${FONT_PLUGIN} did not expose generation diagnostics`))
    return checks
  }
  const { options, generation } = diagnostics

  const entry = detectTailwindEntry(root)
  if (!entry) {
    checks.push(check('failure', `no stylesheet importing tailwindcss was found`))
  } else {
    checks.push(check('pass', `Tailwind entry: ${relative(root, entry.path)}`))
    const css = readFileSync(entry.path, 'utf8')
    const inlineBodies = themeBlocks(css)
      .filter((block) => block.inline)
      .map((block) => css.slice(block.bodyStart, block.end - 1))
    const conflicts = options.families
      .map((family) => family.themeVar)
      .filter((variable) =>
        inlineBodies.some((body) => new RegExp(`^\\s*${variable}\\s*:`, 'm').test(body)),
      )
    checks.push(
      conflicts.length
        ? check('failure', `owned variables conflict inside @theme inline: ${conflicts.join(', ')}`)
        : check('pass', `no owned font variables conflict inside @theme inline`),
    )
  }

  const preloads = generation.preloads ?? []
  const isSsrBuild = diagnostics.isSsrBuild ?? Boolean(resolved.build?.ssr)
  const isLibraryBuild = diagnostics.isLibraryBuild ?? Boolean(resolved.build?.lib)
  const serverDelivery = preloads.length ? detectServerEntryDelivery(root) : 'none'
  const delivery =
    diagnostics.delivery ??
    resolvePreloadDelivery(options, {
      preloadCount: preloads.length,
      hasNitro: diagnostics.hasNitro,
      htmlEntryDetected: false,
    })
  if (!preloads.length) {
    checks.push(check('pass', `no font preloads are configured`))
  } else if (isLibraryBuild) {
    checks.push(check('pass', `library builds do not produce a document preload response`))
  } else if (delivery.headerActive) {
    checks.push(
      check(
        'pass',
        delivery.htmlInjectionEnabled
          ? `Nitro Link headers and explicit HTML preload injection are enabled`
          : `Nitro will deliver the font preload Link header`,
      ),
    )
  } else if (isSsrBuild) {
    checks.push(
      check('pass', `SSR build defers document preload delivery to its client or server output`),
    )
  } else if (serverDelivery === 'link-header') {
    checks.push(check('pass', `the Start server entry will deliver font preload Link headers`))
  } else if (serverDelivery === 'early-hints') {
    checks.push(
      check(
        'warning',
        `the Start server entry enables Early Hints without a Link-header fallback; delivery depends on the runtime and protocol`,
      ),
    )
  } else if (serverDelivery === 'unknown') {
    checks.push(
      check(
        'warning',
        `the Start server entry's font preload delivery options could not be verified`,
      ),
    )
  } else if (delivery.htmlInjectionEnabled && diagnostics.hasNitro) {
    checks.push(
      check(
        'warning',
        `explicit HTML preload injection is enabled with Nitro, but Nitro production HTML does not use Vite's HTML transform`,
      ),
    )
  } else if (delivery.htmlInjectionEnabled && delivery.htmlEntryDetected) {
    checks.push(check('warning', `Nitro is absent; Vite HTML preload injection is configured`))
  } else if (delivery.htmlInjectionEnabled) {
    checks.push(
      check(
        'warning',
        `explicit HTML preload injection is enabled, but no conventional Vite HTML entry was detected`,
      ),
    )
  } else if (delivery.manualOptOut) {
    checks.push(check('warning', `manual font preload delivery is configured`))
  } else {
    checks.push(check('failure', `font preloads have no automatic Nitro or HTML delivery path`))
  }

  const fontRulesAreScoped = diagnostics.paths?.assetPath !== '/'
  if (diagnostics.selfHosts && (!diagnostics.hasNitro || !fontRulesAreScoped)) {
    checks.push(
      check(
        'warning',
        !fontRulesAreScoped
          ? `fonts share the document namespace, so production caching and CORS remain the deployment host's responsibility`
          : `production immutable caching and CORS are controlled by the deployment host; Vite preview covers local verification only`,
      ),
    )
  } else if (diagnostics.selfHosts) {
    checks.push(check('pass', `Nitro route rules provide immutable font caching and CORS`))
  }

  const requests = generation.sourceRequests ?? []
  for (const request of requests.filter((item) => item.hasOpsz)) {
    if (requestHasRangedOpsz(request.url)) {
      checks.push(check('failure', `${request.family} still requests a variable opsz range`))
    } else if (request.implicitOpszPin) {
      checks.push(check('warning', `${request.family} uses the implicit opsz pin of 16`))
    } else {
      checks.push(check('pass', `${request.family} has a resolved opsz request`))
    }
  }

  const missing = generation.files.filter(
    (file) => !generation.digests?.[file] || !existsSync(join(generation.filesDir, file)),
  )
  checks.push(
    missing.length
      ? check(
          'failure',
          `generated font assets are missing or lack byte metadata: ${missing.join(', ')}`,
        )
      : check('pass', `${generation.files.length} generated font asset(s) have byte metadata`),
  )

  if (preloads.length) {
    try {
      const measured = await preloadBytes(preloads, generation, fetchImpl, preloadTimeoutMs)
      const kib = measured.bytes / 1024
      if (
        options.preloadBudgetKb !== undefined &&
        measured.bytes > options.preloadBudgetKb * 1024
      ) {
        checks.push(
          check(
            'failure',
            `${measured.count} unique preload(s) total ${measured.bytes} bytes (${kib.toFixed(1)} kB), exceeding the ${options.preloadBudgetKb} kB budget`,
          ),
        )
      } else {
        checks.push(
          check(
            'pass',
            `${measured.count} unique preload(s) total ${measured.bytes} bytes (${kib.toFixed(1)} kB)` +
              (options.preloadBudgetKb === undefined
                ? `; no preloadBudgetKb is configured`
                : ` within the ${options.preloadBudgetKb} kB budget`),
          ),
        )
      }
    } catch (error) {
      checks.push(check('failure', `could not measure preload bytes: ${error.message}`))
    }
  }

  const coveredWarningCodes = new Set([
    'NO_NITRO_HTML_FALLBACK',
    'MANUAL_PRELOAD_DELIVERY',
    'NO_AUTOMATIC_PRELOAD_PATH',
    'EXTERNAL_FONT_HEADERS',
  ])
  if (Array.isArray(diagnostics.warningEvents)) {
    for (const event of diagnostics.warningEvents) {
      if (coveredWarningCodes.has(event.code)) continue
      checks.push(check('warning', event.message.replace(/\n\s*/g, ' ')))
    }
  } else {
    for (const warning of diagnostics.warnings ?? []) {
      checks.push(check('warning', warning.replace(/\n\s*/g, ' ')))
    }
  }
  return checks
}

export function renderDoctor(checks, write = (line) => console.log(line)) {
  const glyph = { pass: '✓', warning: '!', failure: '✗' }
  for (const item of checks) write(`${glyph[item.status]} ${item.message}`)
  const failures = checks.filter((item) => item.status === 'failure').length
  const warnings = checks.filter((item) => item.status === 'warning').length
  write(
    failures
      ? `doctor failed: ${failures} failure(s), ${warnings} warning(s)`
      : `doctor passed: ${warnings} warning(s)`,
  )
  return failures ? 1 : 0
}

export async function loadProjectVite(projectRoot) {
  const projectRequire = createRequire(join(projectRoot, 'package.json'))
  const entry = projectRequire.resolve('vite')
  return import(pathToFileURL(entry).href)
}

/** @param {{root?: string, resolveConfigFn?: Function, fetchImpl?: typeof fetch,
 * preloadTimeoutMs?: number}} [options] */
export async function runDoctor({
  root = process.cwd(),
  resolveConfigFn,
  fetchImpl = fetch,
  preloadTimeoutMs = 60_000,
} = {}) {
  const projectRoot = resolve(root)
  let checks
  try {
    checks = await runInDoctorContext(async () => {
      const resolveVite = resolveConfigFn ?? (await loadProjectVite(projectRoot)).resolveConfig
      const resolved = await resolveVite({ root: projectRoot }, 'build', 'production')
      return diagnoseResolvedConfig(projectRoot, resolved, { fetchImpl, preloadTimeoutMs })
    })
  } catch (error) {
    checks = [check('failure', `could not resolve and generate the Vite project: ${error.message}`)]
  }
  return { checks, exitCode: renderDoctor(checks) }
}

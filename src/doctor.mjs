import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { init, parse } from 'es-module-lexer'
import { mask, staticImportBindings } from './codemod-vite.mjs'
import { assertFontHost } from './font-host.mjs'
import { DEFAULT_SKIP_DIRS, detectTailwindEntry, themeBlocks, walk } from './detect.mjs'
import { runInDoctorContext } from './doctor-context.mjs'
import { environmentInput, inputValues, resolvePreloadDelivery } from './preload-delivery.mjs'
import { requestHasRangedOpsz } from './opsz.mjs'
import { escapeRegExp } from './string.mjs'

const FONT_PLUGIN = 'tailwind-vite-font-kit'
const TAILWIND_PLUGIN = '@tailwindcss/vite'
const SERVER_ENTRY_SPECIFIER = 'tailwind-vite-font-kit/start-server'
const START_SERVER_ENTRY_ALIAS = 'virtual:tanstack-start-server-entry'
const SERVER_EXTENSIONS = ['.ts', '.js', '.mts', '.mjs', '.cts', '.cjs', '.tsx', '.jsx']

/** @typedef {(source: string, file: string) =>
 * Promise<string | {code?: string} | null> | string | {code?: string} | null} ServerSourceTransform */

await init

const check = (status, message) => ({ status, message })

const bindingExpressionPattern = (binding) =>
  binding.split('.').map(escapeRegExp).join('\\s*\\.\\s*')

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

function analyzeServerModule(source) {
  try {
    const [imports, exports] = parse(source)
    return { active: mask(source), imports, exports }
  } catch {
    return null
  }
}

function classifyServerEntrySource(source, analysis) {
  // Most application files never mention the server helper. Avoid invoking the lexer for
  // those files; custom-entry discovery may inspect a large source tree.
  if (!source.includes(SERVER_ENTRY_SPECIFIER)) return null

  analysis ??= analyzeServerModule(source)
  if (!analysis) return 'unknown'
  const { active, imports } = analysis
  const serverImports = imports.filter(
    (entry) => entry.n === SERVER_ENTRY_SPECIFIER && entry.d === -1,
  )
  if (!serverImports.length) return null
  const bindings = serverImports.flatMap((entry) =>
    staticImportBindings(source.slice(entry.ss, entry.se), {
      namedExports: ['createFontsServerEntry', 'default'],
      namespaceExports: ['createFontsServerEntry', 'default'],
    }),
  )
  // Type-only imports, re-exports and side-effect imports do not introduce a callable
  // factory binding and therefore cannot make this file a server-entry candidate.
  if (!bindings.length) return null

  for (const binding of bindings) {
    const expression = bindingExpressionPattern(binding)
    const call = new RegExp(`\\bexport\\s+default\\s+${expression}(?![\\w$])\\s*\\(`).exec(active)
    if (!call) continue
    const open = call.index + call[0].lastIndexOf('(')
    const close = closingParen(active, open)
    if (close === -1) return 'unknown'
    return classifyServerOptions(source.slice(open + 1, close))
  }
  // The package is imported, but the value may flow through a local variable or helper.
  // That is not proof that delivery is absent.
  return 'unknown'
}

const isFile = (file) => {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

function configuredAliases(resolved) {
  const aliases = resolved.resolve?.alias
  if (Array.isArray(aliases)) return aliases
  if (!aliases || typeof aliases !== 'object') return []
  return Object.entries(aliases).map(([find, replacement]) => ({ find, replacement }))
}

function aliasMatches(find, specifier) {
  if (typeof find === 'string') return specifier === find || specifier.startsWith(`${find}/`)
  if (!(find instanceof RegExp)) return false
  find.lastIndex = 0
  const matches = find.test(specifier)
  find.lastIndex = 0
  return matches
}

const isDependencyFile = (file) => file.split(sep).includes('node_modules')

async function resolvedModuleTarget(resolveId, specifier, importer) {
  if (typeof resolveId !== 'function') return { kind: 'unavailable' }
  let id
  try {
    id = await resolveId(specifier, importer)
  } catch {
    return { kind: 'unavailable' }
  }
  if (!id) return { kind: 'missing' }
  const clean = id.split(/[?#]/, 1)[0]
  if (/^(?:\0|virtual:)/.test(clean)) return { kind: 'opaque' }
  if (clean.startsWith('node:') || !isAbsolute(clean)) return { kind: 'package' }
  if (!isFile(clean)) return { kind: 'unresolved' }
  return isDependencyFile(clean) ? { kind: 'package' } : { kind: 'file', file: clean }
}

async function resolvedInputTarget(root, resolveId, input) {
  const target = await resolvedModuleTarget(resolveId, input)
  if (target.kind !== 'missing' && target.kind !== 'unavailable') return target

  const clean = input.split(/[?#]/, 1)[0]
  if (/^(?:\0|virtual:|node:)/.test(clean)) return target
  const rooted =
    isAbsolute(clean) && isFile(clean)
      ? clean
      : resolve(root, isAbsolute(clean) ? `.${clean}` : clean)
  const rootedTarget = await resolvedModuleTarget(resolveId, rooted)
  if (rootedTarget.kind !== 'missing' && rootedTarget.kind !== 'unavailable') {
    return rootedTarget
  }
  if (isFile(rooted)) return { kind: 'file', file: rooted }
  return target.kind === 'unavailable' ? target : rootedTarget
}

const hasTanStackStartPlugin = (resolved) =>
  (resolved.plugins ?? []).some(
    (plugin) =>
      typeof plugin.name === 'string' &&
      (plugin.name.includes('tanstack-start') || plugin.name.includes('tanstack-react-start')),
  )

async function resolvedServerEntry(root, resolved, resolveId) {
  const aliasConfigured = configuredAliases(resolved).some((candidate) =>
    aliasMatches(candidate.find, START_SERVER_ENTRY_ALIAS),
  )
  const aliasTarget = await resolvedModuleTarget(resolveId, START_SERVER_ENTRY_ALIAS)
  if (
    aliasTarget.kind === 'file' ||
    aliasTarget.kind === 'package' ||
    aliasTarget.kind === 'opaque'
  ) {
    return { available: true, target: aliasTarget }
  }

  if (hasTanStackStartPlugin(resolved)) {
    const rawInputs = inputValues(environmentInput(resolved, 'ssr'))
    if (rawInputs.length) {
      if (rawInputs.length !== 1) {
        return { available: true, target: { kind: 'unknown' } }
      }
      const target =
        typeof rawInputs[0] === 'string'
          ? await resolvedInputTarget(root, resolveId, rawInputs[0])
          : { kind: 'unknown' }
      if (target.kind === 'file') {
        return { available: true, target }
      }
      if (target.kind === 'package') {
        return { available: true, target: { kind: 'package' } }
      }
      return { available: true, target: { kind: 'unknown' } }
    }
  }

  return aliasConfigured || aliasTarget.kind === 'unresolved'
    ? { available: true, target: { kind: 'unknown' } }
    : { available: false, target: { kind: 'missing' } }
}

function directDefaultExportSupport(active, binding) {
  const expression = bindingExpressionPattern(binding)
  const match = new RegExp(`\\bexport\\s+default\\s+${expression}(?![\\w$])`).exec(active)
  if (!match) return null

  let index = match.index + match[0].length
  let lineBreak = false
  while (/\s/.test(active[index] ?? '')) {
    lineBreak ||= active[index] === '\n' || active[index] === '\r'
    index++
  }
  if (active[index] === ';' || !active[index]) return true
  if (!lineBreak) return false
  return !['.', '?', '[', '(', '`'].includes(active[index])
}

function exportsBindingAsDefault({ active, exports }, binding) {
  const direct = directDefaultExportSupport(active, binding)
  if (direct !== null) return direct
  if (binding.includes('.')) return null
  return exports.some((entry) => entry.n === 'default' && entry.ln === binding) ? true : null
}

function defaultExportTarget(source, { active, imports, exports }) {
  const targets = []
  for (const entry of imports) {
    if (entry.d !== -1 || !entry.n) continue
    const statement = source.slice(entry.ss, entry.se)
    const activeStatement = active.slice(entry.ss, entry.se)
    const reexport = /^\s*export\s*\{([\s\S]*?)\}\s*from\b/.exec(activeStatement)
    if (reexport) {
      for (const raw of reexport[1].split(',')) {
        const part = raw.trim()
        if (part === 'default' || /^default\s+as\s+default$/.test(part)) {
          targets.push({ specifier: entry.n, supported: true })
        } else if (/^[\w$]+\s+as\s+default$/.test(part)) {
          targets.push({ specifier: entry.n, supported: false })
        }
      }
      continue
    }

    const bindings = staticImportBindings(statement, {
      namedExports: ['default'],
      namespaceExports: ['default'],
    })
    for (const binding of bindings) {
      const supported = exportsBindingAsDefault({ active, exports }, binding)
      if (supported !== null) {
        targets.push({ specifier: entry.n, supported })
      }
    }
  }
  return targets
}

async function transformServerSource(source, file, transformSourceFn) {
  if (typeof transformSourceFn !== 'function') return source
  try {
    const transformed = await transformSourceFn(source, file)
    if (typeof transformed === 'string') return transformed
    return typeof transformed?.code === 'string' ? transformed.code : null
  } catch {
    return null
  }
}

async function classifyServerEntryFile(
  file,
  resolveId,
  transformSourceFn,
  seen = new Set(),
  depth = 0,
) {
  if (depth > 12 || seen.has(file)) return 'unknown'
  seen.add(file)
  // Package defaults are authoritative, but their implementation graph is not application
  // wiring and should not be searched for this package's helper.
  if (isDependencyFile(file)) return 'none'
  let source
  try {
    source = readFileSync(file, 'utf8')
  } catch {
    return 'unknown'
  }

  source = await transformServerSource(source, file, transformSourceFn)
  if (source === null) return 'unknown'
  const analysis = analyzeServerModule(source)
  if (!analysis) return 'unknown'
  const direct = classifyServerEntrySource(source, analysis)
  if (direct) return direct
  const targets = defaultExportTarget(source, analysis)
  if (!targets.length) {
    const hasDynamicImport = analysis.imports.some((entry) => entry.d >= 0)
    const hasDefaultExport = /\bexport\s+default\b/.test(analysis.active)
    return hasDynamicImport && hasDefaultExport ? 'unknown' : 'none'
  }
  if (targets.length !== 1) return 'unknown'
  const target = await resolvedModuleTarget(resolveId, targets[0].specifier, file)
  if (target.kind === 'package') return 'none'
  if (!targets[0].supported) return 'unknown'
  if (target.kind !== 'file') return 'unknown'
  return classifyServerEntryFile(target.file, resolveId, transformSourceFn, seen, depth + 1)
}

async function detectServerEntryDelivery(root, resolved, transformSourceFn) {
  const resolveId =
    typeof resolved.createResolver === 'function' ? resolved.createResolver() : undefined
  const authoritative = await resolvedServerEntry(root, resolved, resolveId)
  if (authoritative.available) {
    if (authoritative.target.kind === 'package') return 'none'
    return authoritative.target.kind === 'file'
      ? classifyServerEntryFile(authoritative.target.file, resolveId, transformSourceFn)
      : 'unknown'
  }

  const conventional = SERVER_EXTENSIONS.map((extension) =>
    join(root, 'src', `server${extension}`),
  ).filter(isFile)
  const ignoredDirectories = new Set([
    ...DEFAULT_SKIP_DIRS,
    'test',
    'tests',
    '__tests__',
    'fixtures',
    'examples',
    'docs',
    'public',
    '.cache',
    'scripts',
    'e2e',
    'cypress',
    'playwright',
  ])
  if (conventional.length > 1) return 'unknown'
  if (conventional.length === 1) {
    return classifyServerEntryFile(conventional[0], resolveId, transformSourceFn)
  }

  const files = walk(root, SERVER_EXTENSIONS, { skipDirs: ignoredDirectories })
  const namedServerEntries = files.filter((file) =>
    /^server\.(?:[cm]?[jt]sx?)$/.test(basename(file)),
  )
  const namedDeliveries = await Promise.all(
    namedServerEntries.map((file) => classifyServerEntryFile(file, resolveId, transformSourceFn)),
  )
  const positiveNamedDeliveries = namedDeliveries.filter((delivery) => delivery !== 'none')
  if (
    positiveNamedDeliveries.includes('unknown') ||
    positiveNamedDeliveries.length > 1 ||
    (positiveNamedDeliveries.length === 1 && namedDeliveries.includes('none'))
  ) {
    return 'unknown'
  }
  if (positiveNamedDeliveries.length === 1) return positiveNamedDeliveries[0]
  const candidates = []
  const namedServerEntrySet = new Set(namedServerEntries)

  for (const file of files) {
    if (namedServerEntrySet.has(file)) continue
    if (!isFile(file)) continue
    let source
    try {
      source = readFileSync(file, 'utf8')
    } catch {
      // A conventional or discovered source file that cannot be inspected is uncertainty,
      // not grounds to abort every unrelated doctor check.
      if (namedServerEntries.length) return 'unknown'
      candidates.push({ file, delivery: 'unknown' })
      continue
    }
    if (!source.includes(SERVER_ENTRY_SPECIFIER)) continue
    source = await transformServerSource(source, file, transformSourceFn)
    const delivery = source === null ? 'unknown' : classifyServerEntrySource(source)
    if (delivery) {
      if (namedServerEntries.length) return 'unknown'
      candidates.push({ file, delivery })
    }
  }

  if (!candidates.length) return 'none'
  return candidates.length === 1 ? candidates[0].delivery : 'unknown'
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
    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(new Error(`preload measurement timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )
    try {
      const response = await fetchImpl(href, {
        redirect: 'error',
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`${href} returned HTTP ${response.status}`)
      const body = Buffer.from(await response.arrayBuffer())
      if (body.length < 4 || body.subarray(0, 4).toString('ascii') !== 'wOF2') {
        throw new Error(`${href} did not return WOFF2 bytes`)
      }
      bytes += body.length
    } finally {
      clearTimeout(timeout)
    }
  }
  return { bytes, count: unique.length }
}

/**
 * Diagnose an already-resolved Vite config. Exported so the rules can be tested without
 * loading a fixture or touching the network.
 * @param {string} root
 * @param {any} resolved
 * @param {{fetchImpl?: typeof fetch, preloadTimeoutMs?: number,
 * transformSourceFn?: ServerSourceTransform}} [options]
 */
export async function diagnoseResolvedConfig(
  root,
  resolved,
  { fetchImpl = fetch, preloadTimeoutMs = 60_000, transformSourceFn } = {},
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
  const delivery =
    diagnostics.delivery ??
    resolvePreloadDelivery(options, {
      preloadCount: preloads.length,
      hasNitro: diagnostics.hasNitro,
      htmlEntryDetected: false,
    })
  const serverDelivery =
    preloads.length && !isLibraryBuild && !delivery.headerActive && !isSsrBuild
      ? await detectServerEntryDelivery(root, resolved, transformSourceFn)
      : 'none'
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

/** @param {{root?: string, resolveConfigFn?: Function, transformSourceFn?: ServerSourceTransform,
 * fetchImpl?: typeof fetch, preloadTimeoutMs?: number}} [options] */
export async function runDoctor({
  root = process.cwd(),
  resolveConfigFn,
  transformSourceFn,
  fetchImpl = fetch,
  preloadTimeoutMs = 60_000,
} = {}) {
  const projectRoot = resolve(root)
  let checks
  try {
    checks = await runInDoctorContext(async () => {
      const vite = resolveConfigFn ? undefined : await loadProjectVite(projectRoot)
      const resolveVite = resolveConfigFn ?? vite.resolveConfig
      const transformServerModule =
        transformSourceFn ?? vite?.transformWithOxc ?? vite?.transformWithEsbuild
      const resolved = await resolveVite({ root: projectRoot }, 'build', 'production')
      return diagnoseResolvedConfig(projectRoot, resolved, {
        fetchImpl,
        preloadTimeoutMs,
        transformSourceFn: transformServerModule,
      })
    })
  } catch (error) {
    checks = [check('failure', `could not resolve and generate the Vite project: ${error.message}`)]
  }
  return { checks, exitCode: renderDoctor(checks) }
}

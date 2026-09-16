import { existsSync, readFileSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { assertFontHost } from './font-host.mjs'
import { detectTailwindEntry, themeBlocks } from './detect.mjs'
import { runInDoctorContext } from './doctor-context.mjs'
import { resolvePreloadDelivery } from './preload-delivery.mjs'
import { requestHasRangedOpsz } from './opsz.mjs'

const FONT_PLUGIN = 'tailwind-vite-font-kit'
const TAILWIND_PLUGIN = '@tailwindcss/vite'

const check = (status, message) => ({ status, message })

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
  const delivery =
    diagnostics.delivery ??
    resolvePreloadDelivery(options, {
      preloadCount: preloads.length,
      hasNitro: diagnostics.hasNitro,
      htmlEntryDetected: false,
    })
  if (!preloads.length) {
    checks.push(check('pass', `no font preloads are configured`))
  } else if (delivery.headerActive) {
    checks.push(
      check(
        'pass',
        delivery.htmlInjectionEnabled
          ? `Nitro Link headers and explicit HTML preload injection are enabled`
          : `Nitro will deliver the font preload Link header`,
      ),
    )
  } else if (delivery.htmlInjectionEnabled && diagnostics.hasNitro) {
    checks.push(check('pass', `explicit HTML preload injection is enabled with Nitro`))
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

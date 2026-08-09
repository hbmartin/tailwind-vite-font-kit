// Loading and validating `fonts.config.mjs`.
//
// Both entry points read this file — the Vite plugin (when `fonts()` is called with no
// families, which is the shadcn path) and the CLI. The CLI is the reason validation lives
// here rather than being left to the generator: `adopt` DELETES the CSS that describes
// the project's fonts, so a config it cannot understand has to stop it before the write,
// not throw a TypeError halfway through.
//
// Every message names the file and the offending family, because the usual way to get
// here is hand-editing a config the tool generated.

import { pathToFileURL } from 'node:url'
import { weightsFromSpec } from './detect.mjs'

const STRATEGIES = ['self-host', 'cdn']

// Tailwind's theme namespace for font families. A var outside it (`--fonts-sans`, or
// `font-sans` with the dashes forgotten) produces a `@theme` block that Tailwind accepts
// and silently ignores — no utility, no `--default-font-family`, no error. That is the
// exact class of silent failure this package exists to prevent, so it is rejected here.
const THEME_VAR_RE = /^--font-[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Import a config file, bypassing the module cache so an edit is picked up by a
 * long-lived process (the dev server, or a CLI run following a write).
 * @param {string} path
 * @returns {Promise<Record<string, unknown>>} the module's default export, or the module
 */
export async function loadFontsConfig(path) {
  const mod = await import(pathToFileURL(path).href + `?t=${Date.now()}`)
  return /** @type {Record<string, unknown>} */ (mod.default ?? mod)
}

/**
 * Throw unless `families` is a usable list. Returns it narrowed on success.
 * @param {unknown} families
 * @param {string} source  where these came from, for the error message
 * @returns {import('../index.d.ts').FontFamily[]}
 */
export function validateFamilies(families, source) {
  // Annotated on the binding, not the arrow: TS only narrows control flow past a
  // never-returning call when the *variable* carries the type. Without this the
  // `Array.isArray` guard below does not narrow `families`.
  /** @type {(msg: string) => never} */
  const fail = (msg) => {
    throw new Error(`[tss-fonts] ${source}: ${msg}`)
  }

  if (!Array.isArray(families)) {
    fail(
      `expected a \`families\` array, got ${families === undefined ? 'nothing' : typeof families}.\n` +
        `  The file should export a default object shaped like:\n` +
        `    export default { families: [{ name: 'Manrope', themeVar: '--font-sans', weights: [400, 700] }] }`,
    )
  }
  if (!families.length) fail('`families` is empty — declare at least one family.')

  families.forEach((fam, i) => {
    // Identify by name where possible; an entry too broken to name is identified by index.
    const at = fam && typeof fam.name === 'string' && fam.name ? `"${fam.name}"` : `families[${i}]`
    if (!fam || typeof fam !== 'object') fail(`families[${i}] is not an object.`)
    if (typeof fam.name !== 'string' || !fam.name.trim()) {
      fail(`families[${i}] has no \`name\`. Use the Google Fonts family name, e.g. 'Manrope'.`)
    }
    if (typeof fam.themeVar !== 'string' || !THEME_VAR_RE.test(fam.themeVar)) {
      fail(
        `${at} has themeVar ${JSON.stringify(fam.themeVar)}, which is not a Tailwind font ` +
          `theme variable. It must look like '--font-sans' or '--font-display' — Tailwind ` +
          `silently ignores anything outside the --font-* namespace.`,
      )
    }
    if (fam.weights !== undefined) {
      if (!Array.isArray(fam.weights) || fam.weights.some((w) => !Number.isFinite(w))) {
        fail(`${at} has a \`weights\` that is not an array of numbers, e.g. [400, 700].`)
      }
    }
    if (fam.axes !== undefined && typeof fam.axes !== 'string') {
      fail(`${at} has an \`axes\` that is not a string, e.g. 'opsz,wght@9..144,400;9..144,700'.`)
    }
    // Weights may be carried by the axes spec instead; the generator derives them — so an
    // axes spec with no wght axis leaves it nothing to derive, and generate() would throw
    // after `adopt` has already deleted the CSS. Catch it here, before anything destructive.
    if (!fam.weights?.length) {
      if (!fam.axes) {
        fail(`${at} declares neither \`weights\` nor \`axes\`, so no faces can be requested.`)
      }
      if (!weightsFromSpec(fam.axes).weights.length) {
        fail(
          `${at} has no \`weights\`, and its \`axes\` spec declares no wght axis to derive ` +
            `them from — add weights, or a wght axis like 'opsz,wght@9..144,400'.`,
        )
      }
    }
    if (fam.strategy !== undefined && !STRATEGIES.includes(fam.strategy)) {
      fail(`${at} has strategy ${JSON.stringify(fam.strategy)}; expected 'self-host' or 'cdn'.`)
    }
    if (
      fam.opszPin !== undefined &&
      fam.opszPin !== 'auto' &&
      !(Number.isFinite(fam.opszPin) && fam.opszPin > 0)
    ) {
      fail(
        `${at} has an \`opszPin\` that is not a positive number (a px size, e.g. 16 or 48) ` +
          `or 'auto'.`,
      )
    }
    if (fam.preloadWeights !== undefined && !Array.isArray(fam.preloadWeights)) {
      fail(`${at} has a \`preloadWeights\` that is not an array. Use [] to disable preloading.`)
    }
    if (fam.stack !== undefined && !Array.isArray(fam.stack)) {
      fail(`${at} has a \`stack\` that is not an array of family names.`)
    }
  })

  return /** @type {import('../index.d.ts').FontFamily[]} */ (families)
}

/**
 * Load a config file and validate the families it declares.
 * @param {string} path
 * @param {string} [label] how to refer to the file in errors; defaults to the path
 */
export async function loadAndValidate(path, label = path) {
  const cfg = await loadFontsConfig(path)
  // A config that default-exports the families array directly (or a string, or a
  // function) has no `.families` to read — name the mistake instead of reporting the
  // misleading "expected a `families` array, got nothing".
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new Error(
      `[tss-fonts] ${label}: the default export must be an object shaped like ` +
        `{ families: [...] }, got ${Array.isArray(cfg) ? 'an array' : typeof cfg}.`,
    )
  }
  validateFamilies(cfg.families, label)
  return cfg
}

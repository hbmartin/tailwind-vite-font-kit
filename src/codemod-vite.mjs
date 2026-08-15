// The one-time vite.config edit `tss-fonts init` performs: add the fonts import and
// insert fonts() immediately before tailwindcss() in the plugins array.
//
// Every anchor is located on a MASKED copy of the source (comment bodies and string
// contents blanked, same length so indices still line up with the original). Masking
// can only hide an anchor, never move one, so every failure mode ends at `null` and
// the CLI prints the manual snippet instead of writing a broken config.

import { init, parse } from 'es-module-lexer'

// One initialization for the process. Unlike the hand-written masking below, this lexer
// understands the complete import grammar and never mistakes import-shaped string or regex
// contents for module wiring.
await init

const PACKAGE_SPECIFIER = 'tailwind-vite-font-kit'

/**
 * Blank comment bodies, string contents and regex-literal bodies in place, preserving
 * length and newlines. `keepStrings` blanks only comments and regex bodies — for callers
 * that need to read string content (an import specifier) while still ignoring
 * commented-out code.
 *
 * A lexer, not a parser — but it tracks the two constructs that can swallow real code
 * when mis-lexed. A template `${…}` re-enters code, so a quote inside an interpolation
 * cannot desync the scan. A `/` counts as a regex literal only where an expression can
 * start (after `(`, `,`, `=`, a keyword like `return`, …), never after a value — so a
 * quote inside `/['"]/g` no longer flips the scanner into string mode, and division
 * stays division.
 */
function maskViews(src) {
  const active = src.split('')
  const withStrings = src.split('')
  const blank = (out, from, to) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '
  }
  const blankBoth = (from, to) => {
    blank(active, from, to)
    blank(withStrings, from, to)
  }

  // Whether a `/` at `i` can start a regex literal. The masked prefix is final by the
  // time this runs — the scan is strictly left-to-right — so already-blanked comment
  // and string bodies never fake an expression position.
  const regexCanStart = (i) => {
    let k = i - 1
    while (k >= 0 && /\s/.test(active[k])) k--
    if (k < 0) return true
    if ('(,=:[!&|?{};+-*%<>~^'.includes(active[k])) return true
    let w = k
    while (w >= 0 && /[\w$]/.test(active[w])) w--
    return /^(?:return|typeof|instanceof|case|delete|void|throw|new|in|of|do|else|yield|await)$/.test(
      src.slice(w + 1, k + 1),
    )
  }

  /** `"` or `'` at i: scan to the closing quote. */
  const scanString = (i) => {
    const q = src[i]
    let j = i + 1
    while (j < src.length && src[j] !== q) j += src[j] === '\\' ? 2 : 1
    blank(active, i + 1, j) // keep the quotes: they delimit the import specifier
    return j + 1
  }

  /** '`' at i: template literal, with `${…}` scanned as code. */
  const scanTemplate = (i) => {
    let j = i + 1
    let seg = j
    while (j < src.length) {
      if (src[j] === '\\') {
        j += 2
        continue
      }
      if (src[j] === '`') {
        blank(active, seg, j)
        return j + 1
      }
      if (src[j] === '$' && src[j + 1] === '{') {
        blank(active, seg, j)
        j = scanCode(j + 2, true)
        if (j < src.length) j++ // step over the closing '}'
        seg = j
        continue
      }
      j++
    }
    blank(active, seg, j)
    return j
  }

  /** `/` at i known to be in expression position: scan to the closing `/`, honouring
   *  character classes. Returns -1 when no closer exists on the line — division after
   *  all, so the caller advances one char and the body stays live. */
  const scanRegex = (i) => {
    let j = i + 1
    let inClass = false
    while (j < src.length && src[j] !== '\n') {
      if (src[j] === '\\') {
        j += 2
        continue
      }
      if (inClass) {
        if (src[j] === ']') inClass = false
      } else if (src[j] === '[') {
        inClass = true
      } else if (src[j] === '/') {
        blankBoth(i + 1, j) // a package name inside a regex is never wiring
        j++
        while (j < src.length && /[a-z]/i.test(src[j])) j++ // flags
        return j
      }
      j++
    }
    return -1
  }

  /** Scan code from `i`; with `stopAtBrace`, return at the matching unnested `}`. */
  function scanCode(i, stopAtBrace = false) {
    let depth = 0
    while (i < src.length) {
      const two = src.slice(i, i + 2)
      if (two === '//') {
        const end = src.indexOf('\n', i)
        const stop = end === -1 ? src.length : end
        blankBoth(i, stop)
        i = stop
      } else if (two === '/*') {
        const end = src.indexOf('*/', i + 2)
        const stop = end === -1 ? src.length : end + 2
        blankBoth(i, stop)
        i = stop
      } else if (src[i] === '"' || src[i] === "'") {
        i = scanString(i)
      } else if (src[i] === '`') {
        i = scanTemplate(i)
      } else if (src[i] === '/' && regexCanStart(i)) {
        const j = scanRegex(i)
        i = j === -1 ? i + 1 : j
      } else if (stopAtBrace && src[i] === '{') {
        depth++
        i++
      } else if (stopAtBrace && src[i] === '}') {
        if (depth === 0) return i
        depth--
        i++
      } else {
        i++
      }
    }
    return i
  }

  scanCode(0)
  return { active: active.join(''), withStrings: withStrings.join('') }
}

export function mask(src, { keepStrings = false } = {}) {
  const views = maskViews(src)
  return keepStrings ? views.withStrings : views.active
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Callable local expressions introduced by one visible static root-package import. */
function callableBindings(statement) {
  const match = /^\s*import\s+([\s\S]*?)\s+from\s*['"]/m.exec(statement)
  if (!match || /^type\b/.test(match[1].trim())) return []

  const clause = match[1].trim()
  const bindings = []

  // The package's default export is fonts(), so any default binding is callable.
  const defaultBinding = /^([\w$]+)(?:\s*,|$)/.exec(clause)?.[1]
  if (defaultBinding) bindings.push(defaultBinding)

  const named = /\{([\s\S]*?)\}/.exec(clause)?.[1]
  if (named) {
    for (const raw of named.split(',')) {
      const part = raw.trim()
      if (!part || /^type\b/.test(part)) continue
      const imported = /^fonts(?:\s+as\s+([\w$]+))?$/.exec(part)
      if (imported) bindings.push(imported[1] ?? 'fonts')
    }
  }

  // A namespace import is not itself callable, but its `.fonts` export is.
  const namespace = /\*\s+as\s+([\w$]+)/.exec(clause)?.[1]
  if (namespace) bindings.push(`${namespace}.fonts`)

  return bindings
}

/**
 * Find static CommonJS requires on the already-masked code view. String bodies are blank,
 * so a require-shaped ordinary string cannot become wiring; matching quote offsets still
 * point into `source`, where the actual package specifier can be read.
 */
function commonJsWiring(source, active) {
  const bindings = []
  const directCalls = []
  let packageRequires = 0
  const requireCall = /\brequire\s*\(\s*(['"])[ \t]*\1\s*\)/g

  for (const match of active.matchAll(requireCall)) {
    const quoteOffset = match[0].search(/['"]/)
    const openQuote = match.index + quoteOffset
    const closeQuote = active.indexOf(match[1], openQuote + 1)
    const specifier = source.slice(openQuote + 1, closeQuote)
    if (specifier !== PACKAGE_SPECIFIER && !specifier.startsWith(`${PACKAGE_SPECIFIER}/`)) {
      continue
    }
    packageRequires++
    if (specifier !== PACKAGE_SPECIFIER) continue

    const before = active.slice(0, match.index)
    const declaration = /\b(?:const|let|var)\s+(\{([^{}]*)\}|[\w$]+)\s*=\s*$/.exec(before)
    const after = active.slice(match.index + match[0].length)
    const member = /^\s*\.\s*(fonts|default)\b/.exec(after)
    const calledDirectly = member && /^\s*\(/.test(after.slice(member[0].length))

    if (declaration?.[2] !== undefined) {
      for (const raw of declaration[2].split(',')) {
        const part = raw.trim()
        const property = /^(fonts|default)(?:\s*:\s*([\w$]+))?(?:\s*=.*)?$/.exec(part)
        if (property) bindings.push(property[2] ?? property[1])
      }
    } else if (declaration) {
      const local = declaration[1]
      if (member) bindings.push(local)
      else bindings.push(`${local}.fonts`, `${local}.default`)
    }

    if (calledDirectly) directCalls.push(`require(${JSON.stringify(specifier)}).${member[1]}`)
  }

  return { packageRequires, bindings, directCalls }
}

/**
 * Inspect active imports with es-module-lexer and static CommonJS require calls, then use
 * the masked source only to see whether a callable binding is invoked. Package references
 * from subpaths and dynamic or side-effect imports count as mentions, but not as wiring.
 *
 * @param {string} source
 * @returns {{parseError: unknown, packageImports: number, bindings: string[],
 *            calledBindings: string[], wired: boolean, commentOnlyMention: boolean}}
 */
export function analyzeFontsPluginWiring(source) {
  const { active, withStrings } = maskViews(source)
  const commentOnlyMention =
    source.includes(PACKAGE_SPECIFIER) && !withStrings.includes(PACKAGE_SPECIFIER)
  let imports
  try {
    ;[imports] = parse(source)
  } catch (parseError) {
    return {
      parseError,
      packageImports: 0,
      bindings: [],
      calledBindings: [],
      wired: false,
      commentOnlyMention,
    }
  }

  const packageImports = imports.filter(
    (entry) =>
      typeof entry.n === 'string' &&
      (entry.n === PACKAGE_SPECIFIER || entry.n.startsWith(`${PACKAGE_SPECIFIER}/`)),
  )
  const bindings = [
    ...new Set(
      packageImports.flatMap((entry) => {
        if (entry.n !== PACKAGE_SPECIFIER || entry.d !== -1) return []
        const statement = withStrings.slice(entry.ss, entry.se)
        if (!/^\s*import\b/.test(statement)) return []
        return callableBindings(statement)
      }),
    ),
  ]
  const commonJs = commonJsWiring(source, active)
  bindings.push(...commonJs.bindings.filter((binding) => !bindings.includes(binding)))
  const calledBindings = bindings.filter((binding) => {
    const expression = binding.split('.').map(escapeRe).join('\\s*\\.\\s*')
    return new RegExp(`(?<![\\w$])${expression}\\s*\\(`).test(active)
  })
  calledBindings.push(...commonJs.directCalls)

  return {
    parseError: null,
    packageImports: packageImports.length + commonJs.packageRequires,
    bindings,
    calledBindings,
    wired: calledBindings.length > 0,
    commentOnlyMention,
  }
}

/**
 * End index (exclusive) of the last top-level import declaration, or -1.
 * The specifier is the first string literal in the declaration, so its closing quote
 * ends the statement — which is what keeps a multiline `import {\n…\n} from 'x'` intact.
 */
function lastImportEnd(masked) {
  let start = -1
  for (const m of masked.matchAll(/^import[\s{]/gm)) start = m.index
  if (start === -1) return -1
  const rel = masked.slice(start).search(/['"]/)
  if (rel === -1) return -1
  const open = start + rel
  const close = masked.indexOf(masked[open], open + 1)
  if (close === -1) return -1
  return masked[close + 1] === ';' ? close + 2 : close + 1
}

/** Indices of the brackets still open at `at`, outermost first. */
function bracketStack(masked, at) {
  const stack = []
  for (let i = 0; i < at; i++) {
    const c = masked[i]
    if (c === '(' || c === '[' || c === '{') stack.push(i)
    else if (c === ')' || c === ']' || c === '}') stack.pop()
  }
  return stack
}

// The array has to be Vite's plugins array. Three shapes count, and the identifier
// `plugins` sits immediately before the bracket in every one of them:
//
//   plugins: [...]                    the config key
//   const plugins = [...]             a helper array (`: PluginOption[]` optional)
//   plugins: (env) => [...]           a factory returning one
//
// Any other array — an argument list, `const shared = [...]`, an unrelated config key —
// is not a place fonts() belongs, so an anchor found there is rejected rather than
// written.
const PLUGINS_ANCHOR_RE = /(?:\bplugins\s*:|\bplugins\s*(?::[^=\n]*)?=>?)\s*$/

// `css: { postcss: { plugins: [...] } }` and `build: { rollupOptions: { plugins: [...] } }`
// spell the key exactly like the Vite one, and fonts() is a Vite plugin — writing it into
// either produces a config that loads and then fails. What separates them is depth, not
// spelling: Vite's `plugins` lives directly in the config object, which is the argument to
// defineConfig, the `export default`, or a const that reaches one of those.
//
// "No keyed ancestor" is the wrong way to measure that depth, because anything standing
// between a key and its object launders the object into an anonymous one — a wrapping call
// (`css: createPostcss({ plugins: […] })`) or a binding that never had a key at all
// (`const postcssConfig = { plugins: […] }`). So rather than blacklist the shapes that
// shadow the Vite key, every bracket enclosing the anchor has to be a recognised link in
// the chain down from the root. A property value, an unknown call, an object literal in any
// other position — none of them are links, so the anchor is rejected and the CLI prints the
// manual snippet. An unrecognised-but-legitimate wrapper falls out here too; that costs a
// config the automatic edit, which is the direction this file is allowed to fail in.
const CHAIN_RE = {
  // The call parens of defineConfig/mergeConfig, or the parens around an arrow's object return.
  '(': /(?:\b(?:defineConfig|mergeConfig)|=>)\s*$/,
  // An object literal in argument position, an arrow or `return` body, or either module
  // system's default export.
  '{': /(?:[(,]|=>|\breturn\b|\bexport\s+default\b|\bmodule\s*\.\s*exports\s*=)\s*$/,
}

// `const config = {…}` is a link only when that binding is the one handed to the root. The
// identical shape holding a postcss config is not, and nothing but the name tells them apart.
const CONST_BINDING_RE = /\b(?:const|let|var)\s+([\w$]+)\s*(?::[^=\n]*)?=\s*$/

/**
 * Whether `name` is what the config root is built from, rather than some other object.
 * The binding has to BE the export or a whole argument — `defineConfig({ css: { postcss:
 * postcssConfig } })` mentions the name but hands the root something else entirely.
 */
function reachesRoot(masked, name) {
  const id = `(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`
  const other = '[\\w$]+\\s*'
  return new RegExp(
    `export\\s+default\\s+${id}\\s*;?\\s*$` +
      `|\\b(?:defineConfig|mergeConfig)\\s*\\(\\s*(?:${other},\\s*)*${id}\\s*(?:,\\s*${other})*\\)`,
    'm',
  ).test(masked)
}

/** Whether every bracket enclosing the plugins array is a link down from the config root. */
function rootedInConfig(masked, ancestors) {
  return ancestors.every((i) => {
    const prefix = masked.slice(0, i)
    if (CHAIN_RE[masked[i]]?.test(prefix)) return true
    if (masked[i] !== '{') return false
    const bound = CONST_BINDING_RE.exec(prefix)
    return bound !== null && reachesRoot(masked, bound[1])
  })
}

/**
 * @param {string} source  vite.config.* text
 * @param {{addImport?: boolean, callee?: string}} [options]
 * @returns {string|null}  the edited text, or null when the edit cannot be made safely
 */
export function insertFontsPlugin(source, { addImport = true, callee = 'fonts' } = {}) {
  const masked = mask(source)

  // Exactly one call, or there is no telling which one is the plugins entry.
  const calls = [...masked.matchAll(/\btailwindcss\s*\(\s*\)/g)]
  if (calls.length !== 1) return null
  const at = calls[0].index

  // A `,` or the closing `]` after it is what makes it an array ENTRY rather than, say,
  // the callee of a member expression or an argument.
  if (!/^\s*[,\]]/.test(masked.slice(at + calls[0][0].length))) return null

  const stack = bracketStack(masked, at)
  const open = stack[stack.length - 1]
  if (open == null || masked[open] !== '[') return null
  if (!PLUGINS_ANCHOR_RE.test(masked.slice(0, open))) return null
  if (!rootedInConfig(masked, stack.slice(0, -1))) return null

  // fonts() without its import is a ReferenceError, so a config whose imports cannot be
  // located falls back to the manual instructions instead of getting a half-edit.
  const impEnd = addImport ? lastImportEnd(masked) : -1
  if (addImport && impEnd === -1) return null

  const indent = source.slice(source.lastIndexOf('\n', at - 1) + 1, at)
  const entry = /^[ \t]*$/.test(indent) ? `${callee}(),\n${indent}` : `${callee}(), `

  // Descending, so the earlier splice does not shift the later one's index.
  const edits = [
    [at, entry],
    ...(addImport ? [[impEnd, `\nimport { fonts } from 'tailwind-vite-font-kit'`]] : []),
  ].sort((a, b) => b[0] - a[0])
  let out = source
  for (const [i, text] of edits) out = out.slice(0, i) + text + out.slice(i)
  return out
}

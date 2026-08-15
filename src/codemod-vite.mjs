// The one-time vite.config edit `tss-fonts init` performs: add the fonts import and
// insert fonts() immediately before tailwindcss() in the plugins array.
//
// Every anchor is located on a MASKED copy of the source (comment bodies and string
// contents blanked, same length so indices still line up with the original). Masking
// can only hide an anchor, never move one, so every failure mode ends at `null` and
// the CLI prints the manual snippet instead of writing a broken config.

/**
 * Blank comment bodies and string contents in place, preserving length and newlines.
 * `keepStrings` blanks only the comments — for callers that need to read string content
 * (an import specifier) while still ignoring commented-out code.
 */
export function mask(src, { keepStrings = false } = {}) {
  const out = src.split('')
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '
  }
  let i = 0
  while (i < src.length) {
    const two = src.slice(i, i + 2)
    if (two === '//') {
      const end = src.indexOf('\n', i)
      const stop = end === -1 ? src.length : end
      blank(i, stop)
      i = stop
    } else if (two === '/*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end === -1 ? src.length : end + 2
      blank(i, stop)
      i = stop
    } else if (src[i] === '"' || src[i] === "'" || src[i] === '`') {
      const q = src[i]
      let j = i + 1
      while (j < src.length && src[j] !== q) j += src[j] === '\\' ? 2 : 1
      if (!keepStrings) blank(i + 1, j) // keep the quotes: they delimit the import specifier
      i = j + 1
    } else {
      i++
    }
  }
  return out.join('')
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
  // An object literal in argument position, an arrow or `return` body, or the default export.
  '{': /(?:[(,]|=>|\breturn\b|\bexport\s+default\b)\s*$/,
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
 * @returns {string|null}  the edited text, or null when the edit cannot be made safely
 */
export function insertFontsPlugin(source) {
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
  const impEnd = lastImportEnd(masked)
  if (impEnd === -1) return null

  const indent = source.slice(source.lastIndexOf('\n', at - 1) + 1, at)
  const entry = /^[ \t]*$/.test(indent) ? `fonts(),\n${indent}` : 'fonts(), '

  // Descending, so the earlier splice does not shift the later one's index.
  const edits = [
    [at, entry],
    [impEnd, `\nimport { fonts } from 'tailwind-vite-font-kit'`],
  ].sort((a, b) => b[0] - a[0])
  let out = source
  for (const [i, text] of edits) out = out.slice(0, i) + text + out.slice(i)
  return out
}

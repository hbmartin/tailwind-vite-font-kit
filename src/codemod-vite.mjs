// The one-time vite.config edit `tss-fonts init` performs: add the fonts import and
// insert fonts() immediately before tailwindcss() in the plugins array.
//
// Every anchor is located on a MASKED copy of the source (comment bodies and string
// contents blanked, same length so indices still line up with the original). Masking
// can only hide an anchor, never move one, so every failure mode ends at `null` and
// the CLI prints the manual snippet instead of writing a broken config.

/** Blank comment bodies and string contents in place, preserving length and newlines. */
function mask(src) {
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
      blank(i + 1, j) // keep the quotes: they delimit the import specifier
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

/** Index of the innermost unclosed `[` before `at`, or -1 if that bracket is `(`/`{`. */
function enclosingArray(masked, at) {
  const stack = []
  for (let i = 0; i < at; i++) {
    const c = masked[i]
    if (c === '(' || c === '[' || c === '{') stack.push(i)
    else if (c === ')' || c === ']' || c === '}') stack.pop()
  }
  const open = stack[stack.length - 1]
  return open != null && masked[open] === '[' ? open : -1
}

// `plugins: [...]`, a helper array (`const plugins = [...]`), or `plugins: () => [...]`.
// Any other array — postcss, an argument list, an unrelated config key — is not a place
// fonts() belongs, so an anchor found there is rejected rather than written.
const PLUGINS_ANCHOR_RE = /(?:\bplugins\s*:|=>?)\s*$/

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

  const open = enclosingArray(masked, at)
  if (open === -1 || !PLUGINS_ANCHOR_RE.test(masked.slice(0, open))) return null

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

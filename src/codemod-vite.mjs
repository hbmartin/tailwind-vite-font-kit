// The one-time vite.config edit `tss-fonts init` performs: add the fonts import and
// insert fonts() immediately before tailwindcss() in the plugins array.

// tailwindcss() counts as a plugins-array entry when a `,` or the closing `]` follows,
// so the final entry (with or without a trailing comma) and single-line arrays all match.
const TW_ENTRY_RE = /(\n([ \t]*))?(tailwindcss\(\s*\)\s*[,\]])/

/**
 * @param {string} source  vite.config.* text
 * @returns {string|null}  the edited text, or null when no tailwindcss() entry was found
 */
export function insertFontsPlugin(source) {
  if (!TW_ENTRY_RE.test(source)) return null
  const withImport = source.replace(
    /(^import .*\n)(?![\s\S]*^import )/m,
    `$1import { fonts } from 'tailwind-vite-font-kit'\n`,
  )
  return withImport.replace(TW_ENTRY_RE, (_, nl, indent, entry) =>
    nl ? `${nl}fonts(),\n${indent}${entry}` : `fonts(), ${entry}`,
  )
}

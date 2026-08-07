// Codemod for the Tailwind entry CSS. String surgery, but every edit is guarded by a
// structural check and every edit is idempotent.
import { themeBlocks } from './detect.mjs'

const GOOGLE_IMPORT_LINE =
  /^[ \t]*@import\s+(?:url\(\s*)?["']?https:\/\/fonts\.googleapis\.com\/[^"')\n]+["']?\s*\)?\s*;?[ \t]*\r?\n?/gm

/**
 * @typedef {object} CodemodCssOptions
 * @property {string[]} ownedVars     --font-* vars the generated theme block now owns
 * @property {{family:string,themeVar:string}[]} rewriteUsages
 * @property {string} [genCssBasename] only used when addImport is true
 * @property {boolean} [addImport]     default false — the Vite plugin injects the CSS
 *                                     import in-memory, so a physical one would point
 *                                     at node_modules/.cache and is not wanted.
 *                                     (Do not write a bare at-import here: TypeScript
 *                                     parses it as the JSDoc `@import` tag.)
 */

/**
 * @param {string} css
 * @param {CodemodCssOptions} o
 * @returns {{ok: true, css: string, changes: string[]}
 *   | {ok: false, reason: string, css: string, changes: string[]}}
 */
export function codemodCss(css, { genCssBasename, ownedVars, rewriteUsages, addImport = false }) {
  const changes = []
  let out = css

  // 1. Drop the render-blocking Google @import. Left in place it is a second CSS
  //    request that ALSO declares @font-face for the same families with no metric
  //    fallbacks — measured surviving into the built CSS when only the plugin runs.
  const removed = out.match(GOOGLE_IMPORT_LINE)
  if (removed) {
    out = out.replace(GOOGLE_IMPORT_LINE, '')
    changes.push(
      `removed ${removed.length} Google Fonts @import (render-blocking, now self-hosted)`,
    )
  }

  // 2. Optional physical @import. Off by default — see the param doc above.
  if (addImport && genCssBasename) {
    if (!new RegExp(`@import\\s+["'][^"']*${escapeRe(genCssBasename)}["']`).test(out)) {
      const tw = /@import\s+["']tailwindcss["'][^;\n]*;?/.exec(out)
      if (!tw) return { ok: false, reason: "no `@import 'tailwindcss'` in the entry", css, changes }
      const at = tw.index + tw[0].length
      out = `${out.slice(0, at)}\n@import './${genCssBasename}';${out.slice(at)}`
      changes.push(`added @import './${genCssBasename}' after @import 'tailwindcss'`)
    }
  }

  // 3. Delete conflicting --font-* declarations from the project's own @theme blocks.
  //    fonts.gen.css owns them now; a later `@theme inline` would otherwise win and
  //    bake a literal into --default-font-family.
  for (const blk of themeBlocks(out).reverse()) {
    const body = out.slice(blk.bodyStart, blk.end - 1)
    let newBody = body
    for (const v of ownedVars) {
      const re = new RegExp(`^[ \\t]*${escapeRe(v)}\\s*:[^;]*;[ \\t]*\\r?\\n?`, 'gm')
      if (re.test(newBody)) {
        newBody = newBody.replace(re, '')
        changes.push(
          `removed ${v} from @theme${blk.inline ? ' inline' : ''} (fonts.gen.css owns it)`,
        )
      }
    }
    if (newBody !== body) out = out.slice(0, blk.bodyStart) + newBody + out.slice(blk.end - 1)
  }

  // 4. Point hand-written `font-family: 'X', ...` rules at the theme var, so those rules
  //    also get the metric-matched fallbacks. Only fires on an exact first-family match.
  if (rewriteUsages.length) {
    const blocks = themeBlocks(out)
    const inTheme = (i) => blocks.some((b) => i >= b.start && i < b.end)
    for (const { family, themeVar } of rewriteUsages) {
      const re = new RegExp(
        `(font-family\\s*:\\s*)(['"]?)${escapeRe(family)}\\2\\s*(,[^;}]*)?(?=[;}])`,
        'gi',
      )
      let m
      const edits = []
      while ((m = re.exec(out))) {
        if (inTheme(m.index)) continue
        if (isInsideFontFace(out, m.index)) continue
        edits.push([m.index, m.index + m[0].length, `${m[1]}var(${themeVar})`])
      }
      for (const [s, e, text] of edits.reverse()) out = out.slice(0, s) + text + out.slice(e)
      if (edits.length)
        changes.push(
          `rewrote ${edits.length} \`font-family: ${family}, …\` rule(s) to var(${themeVar})`,
        )
    }
  }

  return { ok: true, css: out, changes }
}

function isInsideFontFace(css, index) {
  const before = css.lastIndexOf('@font-face', index)
  if (before === -1) return false
  const close = css.indexOf('}', before)
  return close > index
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

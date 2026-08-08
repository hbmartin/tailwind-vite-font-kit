// The module the Vite plugin provides at build time.
//
// A global script — no top-level import or export — on purpose. Inside a .d.ts that is
// itself a module (index.d.ts is, it exports FontsOptions and friends), `declare module`
// under `moduleResolution: nodenext` does not create an ambient module that .mjs sources
// can import; it is only reachable as an augmentation. Splitting it out is what makes
// `import { fontPreloads } from 'virtual:fonts'` typecheck, both here and for consumers.
//
// Referenced from index.d.ts, so nobody has to add it to their tsconfig by hand.

declare module 'virtual:fonts' {
  /** Every face matched by a family's `preloadWeights`, ready for a `Link:` header or a
   *  JSX `<link>`. */
  export const fontPreloads: {
    rel: 'preload'
    as: 'font'
    type: 'font/woff2'
    href: string
    crossOrigin: 'anonymous'
  }[]
  /** Theme variable to family name, e.g. `{ '--font-sans': 'Manrope' }`. */
  export const fontFamilies: Record<string, string>
}

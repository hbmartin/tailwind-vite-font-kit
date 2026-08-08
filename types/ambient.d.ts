// Ambient declarations for THIS repo's typecheck only.
//
// Deliberately NOT in package.json `files`: shipping a `declare module
// '@tanstack/react-start/server'` would override the real types in every consumer that
// installs Start.
//
// `virtual:fonts` is not here — index.d.ts already declares it, and that one IS shipped,
// because consumers importing it need the types too.
//
// A global script, not a module — no top-level import or export — so `declare module`
// here creates ambient modules rather than augmenting ones that would have to exist.

// Optional peer dependencies, imported dynamically and only on opt-in paths. Typed as
// `any` on purpose: this package deliberately does not depend on their types, and a
// hand-written approximation would rot silently against the real ones.
declare module '@tanstack/react-start/server' {
  export const createStartHandler: any
  export const defaultStreamHandler: any
}

declare module 'fontkit' {
  export function create(buffer: Buffer): any
}

declare module 'wawoff2' {
  const wawoff2: { decompress: (buf: Buffer) => Promise<Uint8Array> }
  export default wawoff2
  export const decompress: (buf: Buffer) => Promise<Uint8Array>
}

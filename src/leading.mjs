// Opt-in `@utility` escape hatches for optical leading, appended to the generated
// stylesheet when `leadingUtilities: true`.
//
// Emitted from here rather than shipped as a CSS file you import, because the import is
// the part that goes wrong. Tailwind resolves its own at-imports with enhanced-resolve and
// fs.readFile, bypassing Vite entirely, and a `@utility` Tailwind never sees is dropped
// from the output with no warning. Appending to fonts.gen.css puts these inside Tailwind's
// import graph by construction — the same reason the generated theme block lives there.
//
// WHY THESE ARE OPT-IN, and why there is no global un-pin:
//
// Tailwind v4 pins line-height in two independent places:
//   1. preflight:  html, :host { line-height: 1.5 }   <- inherited by everything
//   2. type utils: .text-* { line-height: var(--tw-leading, var(--text-*--line-height)) }
// Both values are UNITLESS, so they are font-metric independent. That is why
// ascent-override / descent-override / line-gap-override on a fallback face appear
// "disabled" — they are inert wherever a unitless leading is in effect. Measured net CLS
// benefit of un-pinning globally: zero if you ship metric fallbacks, and +0.02–0.06 if you
// do not. So the pin stays, and these are named, scoped ways out of it.

/**
 * @returns {string} CSS appended to the generated stylesheet
 */
export function leadingUtilities() {
  return `
/* Opt a subtree into font-metric leading. Equivalent to the built-in \`leading-[normal]\`;
   this is just a readable alias. Everything inside inherits \`normal\` EXCEPT descendants
   that carry their own \`text-*\` or \`leading-*\`. */
@utility leading-auto {
  line-height: normal;
}

/* @tailwindcss/typography pins \`.prose { line-height: 1.75 }\` and pins every
   heading/pre/table child too. \`@layer components { .prose { ... } }\` does NOT win —
   typography registers \`.prose\` in the \`utilities\` layer, which comes later. A
   \`@utility\` (also in the utilities layer, emitted after the plugin) does win, and can
   reach the children. */
@utility prose-auto {
  line-height: normal;
  & :where(p, li, blockquote, h1, h2, h3, h4, figcaption) {
    line-height: normal;
  }
}
`
}

// NOT INCLUDED ON PURPOSE — each of these is measured-worse or a no-op:
//
//   html { line-height: normal }                 global un-pin: 0 CLS benefit if you ship
//                                                metric fallbacks, and +0.02–0.06 CLS if
//                                                you don't.
//   @layer base { html { line-height: normal } } same, and silently loses if you put it
//                                                BEFORE the tailwindcss import.
//   html { --tw-leading: normal }                no-op: @property --tw-leading declares
//                                                inherits:false.
//   .leading-normal / .text-base/normal          these mean 1.5, NOT CSS `normal`. Only
//                                                the bracket forms `leading-[normal]` /
//                                                `text-base/[normal]` emit `normal`.
//   font-size-adjust: <n>                        applies to every font in the stack incl.
//                                                the web font, is inert under unitless
//                                                leading, and is less accurate than the
//                                                @font-face size-adjust descriptor.

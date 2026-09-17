/** Escape a literal string for interpolation into a regular expression. */
export const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

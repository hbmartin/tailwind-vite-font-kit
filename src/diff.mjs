// Minimal unified diff (LCS). Files here are a few hundred lines; O(n*m) is fine.
const C = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
}
export const color = process.env.NO_COLOR ? new Proxy({}, { get: () => (s) => s }) : C

export function unifiedDiff(before, after, label, context = 2) {
  if (before === after) return ''
  const a = before.split('\n')
  const b = after.split('\n')
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push([' ', a[i], i + 1, j + 1]); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(['-', a[i], i + 1, null]); i++ }
    else { ops.push(['+', b[j], null, j + 1]); j++ }
  }
  while (i < n) { ops.push(['-', a[i], i + 1, null]); i++ }
  while (j < m) { ops.push(['+', b[j], null, j + 1]); j++ }

  const keep = new Set()
  ops.forEach((op, k) => {
    if (op[0] !== ' ') for (let x = k - context; x <= k + context; x++) if (x >= 0 && x < ops.length) keep.add(x)
  })
  const lines = [color.bold(color.cyan(`--- ${label}`))]
  let last = -2
  for (let k = 0; k < ops.length; k++) {
    if (!keep.has(k)) continue
    if (k !== last + 1) lines.push(color.dim('  @@'))
    const [kind, text, an, bn] = ops[k]
    const num = String(kind === '+' ? bn : an).padStart(4)
    lines.push(
      kind === '+' ? color.green(`${num} + ${text}`)
      : kind === '-' ? color.red(`${num} - ${text}`)
      : color.dim(`${num}   ${text}`),
    )
    last = k
  }
  return lines.join('\n')
}

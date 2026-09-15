// Kept pure so the exact function injected into the browser can be tested in Node.
export function clsSession(shifts) {
  let max = 0,
    value = 0,
    first,
    last
  for (const shift of shifts) {
    if (shift.hadRecentInput) continue
    if (first === undefined || shift.at - last >= 1000 || shift.at - first >= 5000) {
      value = 0
      first = shift.at
    }
    value += shift.value
    max = Math.max(max, value)
    last = shift.at
  }
  return max
}

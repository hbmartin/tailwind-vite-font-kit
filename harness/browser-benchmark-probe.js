// Injected by browser-benchmark-server.mjs before app scripts. Measurement only;
// this file never enters the application's production bundle.
;(() => {
  const computeCls = __BENCH_CLS__
  const config = JSON.parse(document.currentScript.dataset.config)
  const errors = []
  let hidden = document.hidden
  addEventListener(
    'error',
    (event) =>
      errors.push(event.message || `Resource error: ${event.target?.src || event.target?.href}`),
    true,
  )
  addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)))
  document.addEventListener('visibilitychange', () => {
    hidden ||= document.hidden
  })
  const shifts = []
  let lcp = null
  let before = null
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (!entry.hadRecentInput)
        shifts.push({
          value: entry.value,
          at: entry.startTime,
          sources: entry.sources.map((source) => ({
            node: source.node?.tagName,
            text: source.node?.textContent?.slice(0, 90),
            before: source.previousRect.toJSON(),
            after: source.currentRect.toJSON(),
          })),
        })
    }
  }).observe({ type: 'layout-shift', buffered: true })
  new PerformanceObserver((list) => {
    lcp = list.getEntries().at(-1)?.startTime
  }).observe({ type: 'largest-contentful-paint', buffered: true })
  function snapshot() {
    return {
      at: performance.now(),
      height: document.documentElement.scrollHeight,
      layoutWidth: document.documentElement.clientWidth,
      elements: [...document.querySelectorAll('main h1, main p, [data-probe]')].map((el) => ({
        tag: el.tagName,
        probe: el.getAttribute('data-probe'),
        text: el.textContent,
        rect: el.getBoundingClientRect().toJSON(),
        font: getComputedStyle(el).fontFamily,
      })),
      faces: [...document.fonts].map((f) => ({
        family: f.family,
        weight: f.weight,
        status: f.status,
      })),
    }
  }
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
      before = snapshot()
    }, 200)
    setTimeout(async () => {
      await document.fonts.ready
      await new Promise((resolve) => setTimeout(resolve, 250))
      const after = snapshot()
      const cls = computeCls(shifts)
      let experiment = null
      try {
        const evidence = await fetch(`/__bench/${config.id}/evidence`)
        if (!evidence.ok) errors.push(`Missing benchmark evidence (HTTP ${evidence.status})`)
        try {
          experiment = await evidence.json()
        } catch {
          errors.push('Invalid benchmark evidence JSON')
        }
      } catch (error) {
        errors.push(`Missing benchmark evidence: ${String(error)}`)
      }
      const result = {
        ...config,
        experiment,
        userAgent: navigator.userAgent,
        viewport: { width: innerWidth, height: innerHeight },
        layoutWidth: document.documentElement.clientWidth,
        cls,
        shifts,
        errors,
        hidden,
        before,
        after,
        lcp,
        fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime,
        resources: performance.getEntriesByType('resource').map((r) => ({
          name: r.name,
          status: r.responseStatus,
          type: r.initiatorType,
          transfer: r.transferSize,
          encoded: r.encodedBodySize,
          decoded: r.decodedBodySize,
          start: r.startTime,
          end: r.responseEnd,
        })),
      }
      const output = document.createElement('pre')
      output.id = 'font-benchmark-result'
      output.hidden = true
      output.textContent = JSON.stringify(result)
      document.body.append(output)
    }, config.delay + 550)
  })
})()

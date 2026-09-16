import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { preview } from 'vite'

const html = readFileSync(new URL('./dist/index.html', import.meta.url), 'utf8')
const preload = /<link\b[^>]*\brel="preload"[^>]*\bas="font"[^>]*\bhref="([^"]+)"[^>]*>/i.exec(html)
assert.ok(preload, 'built HTML must contain an injected font preload')
assert.match(preload[0], /crossorigin(?:="anonymous")?/i)

const server = await preview({
  root: new URL('.', import.meta.url).pathname,
  logLevel: 'silent',
  preview: { host: '127.0.0.1', port: 0, strictPort: false },
})
try {
  const address = server.httpServer.address()
  assert.equal(typeof address, 'object')
  const response = await fetch(`http://127.0.0.1:${address.port}${preload[1]}`)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('cache-control') ?? '', /immutable/)
  assert.equal(response.headers.get('access-control-allow-origin'), '*')
  console.log('plain Vite HTML preload and preview font headers ok')
} finally {
  await server.close()
}

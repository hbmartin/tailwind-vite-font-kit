import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const port = 32_000 + (process.pid % 1000)
const origin = `http://127.0.0.1:${port}`
const child = spawn(process.execPath, ['.output/server/index.mjs'], {
  cwd: new URL('.', import.meta.url),
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
child.stdout.on('data', (chunk) => (output += chunk))
child.stderr.on('data', (chunk) => (output += chunk))

try {
  let documentResponse
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      documentResponse = await fetch(origin)
      break
    } catch {
      if (child.exitCode != null) throw new Error(`server exited early\n${output}`)
      await delay(100)
    }
  }
  assert.ok(documentResponse, `server did not become ready\n${output}`)
  assert.equal(documentResponse.status, 200)
  const html = await documentResponse.text()
  const link = documentResponse.headers.get('link') ?? ''
  const href = /<([^>]+)>;\s*rel=preload;\s*as=font;\s*type=font\/woff2;\s*crossorigin/i.exec(
    link,
  )?.[1]
  assert.ok(href, `document is missing its font preload Link header: ${link}`)
  const htmlFontPreloads = [...html.matchAll(/<link\b[^>]*>/gi)].filter(
    ([tag]) => /\brel=["']preload["']/i.test(tag) && /\bas=["']font["']/i.test(tag),
  )
  assert.equal(htmlFontPreloads.length, 0, 'Nitro auto mode must not duplicate preloads in HTML')

  const fontResponse = await fetch(new URL(href, origin))
  assert.equal(fontResponse.status, 200)
  assert.match(fontResponse.headers.get('cache-control') ?? '', /immutable/)
  assert.equal(
    fontResponse.headers.get('access-control-allow-origin'),
    'https://fixture.invalid',
    'the more specific user route-rule header must win',
  )
  assert.equal(fontResponse.headers.get('link') || '', '')
  console.log('TanStack Start Nitro preload/header merge assertions ok')
} finally {
  child.kill('SIGTERM')
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(2000).then(() => child.kill('SIGKILL')),
  ])
}

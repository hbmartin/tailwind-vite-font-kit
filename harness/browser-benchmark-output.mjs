import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
export function outputPaths(output) {
  assert(output.endsWith('.json'), 'Output must end in .json')
  return {
    raw: resolve(output),
    manifest: resolve(output.replace(/\.json$/, '-manifest.json')),
    summary: resolve(output.replace(/\.json$/, '-summary.json')),
  }
}
export function assertNewOutputs(paths) {
  assert.equal(new Set(paths.map((p) => resolve(p))).size, paths.length, 'Output paths collide')
  for (const path of paths)
    assert(!existsSync(path), `Refusing to overwrite ${path}; choose a new output path`)
}

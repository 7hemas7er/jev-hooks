// Every external action in this repo's workflows and in the examples people copy is
// pinned by commit SHA. A branch or a tag can move under a step that holds a key: the
// review phase of examples/workflows/ receives the backend's key and a token.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

test('every uses: is a local path or an owner/repo@<40-character SHA>', () => {
  let seen = 0
  for (const dir of ['.github/workflows', 'examples/workflows']) {
    for (const f of readdirSync(join(ROOT, dir)).filter((x) => /\.ya?ml$/.test(x))) {
      const lines = readFileSync(join(ROOT, dir, f), 'utf8').split('\n')
      lines.forEach((line, i) => {
        const m = /^\s*(?:-\s+)?uses:\s*([^\s#]+)/.exec(line)
        if (!m) return
        seen++
        assert.match(m[1], /^(\.\/.*|[\w.-]+\/[\w./-]+@[0-9a-f]{40})$/, `${dir}/${f}:${i + 1}: ${m[1]}`)
      })
    }
  }
  assert.ok(seen >= 8, `only ${seen} uses: found`)
})

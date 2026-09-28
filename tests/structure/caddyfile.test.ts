// examples/spark/Caddyfile is copied onto a machine that faces the network: a syntax
// error there would leave rizzo's unauthenticated routes exposed or the proxy down. When
// caddy is installed (JEV_HOOKS_CADDY names another binary), the file must pass
// `caddy validate`; otherwise the test is skipped and says why.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CADDY = process.env.JEV_HOOKS_CADDY || 'caddy'
const found = spawnSync(CADDY, ['version'], { stdio: 'ignore' }).status === 0

test('examples/spark/Caddyfile passes caddy validate', { skip: found ? false : 'caddy not installed' }, () => {
  const r = spawnSync(CADDY, ['validate', '--config', join(ROOT, 'examples', 'spark', 'Caddyfile'), '--adapter', 'caddyfile'], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, RIZZO_TOKEN: 'test-token' }, encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout + r.stderr, /Valid configuration/)
})

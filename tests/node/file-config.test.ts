// Configuration layers from disk: plugin, user (or --config-dir), a project
// that can only tighten, .jev-hooks/ rules that differ from HEAD (hook and skill use
// HEAD, the CLI the working tree), project files as links refused, guardrail's mask map
// and the key file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadConfig, loadMaskMap, userConfigDir, xdgStateDir, describeModifiedRules, readKeyFile, displayPath,
} from '../../src/node/file-config.ts'
import type { LoadedConfig } from '../../src/node/file-config.ts'
import type { Origin, Policy } from '../../src/core/types.ts'
import { createRepo } from '../helpers/git-repo.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

function tempDir(): { dir: string; home: string; env: NodeJS.ProcessEnv; close(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'jev-hooks-config-'))
  const home = join(dir, 'home')
  mkdirSync(home)
  return { dir, home, env: { PATH: process.env.PATH, HOME: home }, close: () => rmSync(dir, { recursive: true, force: true }) }
}

function load(o: { cwd: string; env: NodeJS.ProcessEnv; origin?: Origin; userDir?: string }): LoadedConfig {
  const c = loadConfig({ cwd: o.cwd, pluginRoot: ROOT, origin: o.origin ?? 'cli', env: o.env, ...(o.userDir ? { userDir: o.userDir } : {}) })
  if (!c.ok) assert.fail(c.error.message)
  return c.value
}

function threshold(p: Policy, check: string): number[] {
  return p.lanes.flatMap((l) => l.rules.filter((r) => r.check === check).map((r) => r.value))
}

// The plugin's hardcoded_secret threshold, and three values relative to it: the tests
// stay true when the calibration fit moves the numbers.
const BASE: number = JSON.parse(readFileSync(join(ROOT, 'config', 'policy.json'), 'utf8'))
  .lanes.flatMap((c: { rules: { check: string; value: number }[] }) => c.rules).find((r: { check: string }) => r.check === 'hardcoded_secret').value
const LOOSE = Math.min(0.99, BASE + 0.2)
const STRICT = BASE * 0.8
const STRICTER = BASE * 0.6

// A project overlay with a single rule, in the same lane as the plugin's (NITS, with
// the escalation it inherits).
function project(value: number): string {
  return JSON.stringify({ lanes: [{ name: 'NITS', rules: [{ check: 'hardcoded_secret', op: 'gte', value: value }] }] })
}

test('plugin only: plugin sources, no warning, no map', () => {
  const t = tempDir()
  try {
    const c = load({ cwd: t.dir, env: t.env })
    assert.equal(c.sources.policy, join(ROOT, 'config', 'policy.json'))
    assert.deepEqual(c.warnings, [])
    assert.deepEqual(c.userProblems, [])
    assert.equal(c.maskMap, null)
    assert.deepEqual(threshold(c.policy, 'hardcoded_secret'), [BASE])
  } finally {
    t.close()
  }
})

test('user file: it applies in full, and the source is written with ~', () => {
  const t = tempDir()
  try {
    mkdirSync(join(t.home, '.config', 'jev-hooks'), { recursive: true })
    copyFileSync(join(ROOT, 'examples', 'user', 'policy.json'), join(t.home, '.config', 'jev-hooks', 'policy.json'))
    const c = load({ cwd: t.dir, env: t.env })
    assert.equal(c.sources.policy, '~/.config/jev-hooks/policy.json')
    assert.deepEqual(threshold(c.policy, 'hardcoded_secret'), [0.95])

    // --config-dir takes the place of the user layer
    const other = join(t.dir, 'other')
    mkdirSync(other)
    const p = JSON.parse(readFileSync(join(ROOT, 'config', 'policy.json'), 'utf8'))
    for (const c of p.lanes) for (const r of c.rules) if (r.check === 'hardcoded_secret') r.value = 0.9
    writeFileSync(join(other, 'policy.json'), JSON.stringify(p))
    const d = load({ cwd: t.dir, env: t.env, userDir: other })
    assert.deepEqual(threshold(d.policy, 'hardcoded_secret'), [0.9])
  } finally {
    t.close()
  }
})

test('XDG_CONFIG_HOME and XDG_STATE_HOME: absolute ones apply, relative ones do not', () => {
  assert.equal(userConfigDir({ HOME: '/h', XDG_CONFIG_HOME: '/cfg' }), '/cfg/jev-hooks')
  assert.equal(userConfigDir({ HOME: '/h', XDG_CONFIG_HOME: 'relative' }), '/h/.config/jev-hooks')
  assert.equal(xdgStateDir({ HOME: '/h' }), '/h/.local/state/jev-hooks')
  assert.equal(xdgStateDir({ HOME: '/h', XDG_STATE_HOME: '/st' }), '/st/jev-hooks')
  assert.equal(displayPath('/h/.config/x', { HOME: '/h' }), '~/.config/x')
  assert.equal(displayPath('/hh/x', { HOME: '/h' }), '/hh/x')
})

test('invalid user file: a problem for the CLI, the plugin defaults', () => {
  const t = tempDir()
  try {
    mkdirSync(join(t.home, '.config', 'jev-hooks'), { recursive: true })
    writeFileSync(join(t.home, '.config', 'jev-hooks', 'policy.json'), '{ "lanes": ')
    const c = load({ cwd: t.dir, env: t.env })
    assert.ok(c.userProblems.length > 0)
    assert.ok(c.warnings.some((a) => a.includes('~/.config/jev-hooks/policy.json')))
    assert.deepEqual(threshold(c.policy, 'hardcoded_secret'), [BASE])
  } finally {
    t.close()
  }
})

test('project: it tightens; a looser threshold is ignored with a note', () => {
  const t = tempDir()
  try {
    mkdirSync(join(t.dir, '.jev-hooks'))
    writeFileSync(join(t.dir, '.jev-hooks', 'policy.json'), project(LOOSE))
    const loose = load({ cwd: t.dir, env: t.env })
    assert.deepEqual(threshold(loose.policy, 'hardcoded_secret'), [BASE])
    assert.ok(loose.warnings.some((a) => a.includes('looser threshold from the project')), loose.warnings.join('\n'))
    writeFileSync(join(t.dir, '.jev-hooks', 'policy.json'), project(STRICT))
    const strict = load({ cwd: t.dir, env: t.env })
    assert.deepEqual(threshold(strict.policy, 'hardcoded_secret'), [STRICT])
    assert.equal(strict.sources.policy, `${join(ROOT, 'config', 'policy.json')} + .jev-hooks/policy.json (restrictions only)`)
    // a broken project JSON turns nothing off: the base with a warning, the floors in place
    writeFileSync(join(t.dir, '.jev-hooks', 'policy.json'), '{ broken')
    const broken = load({ cwd: t.dir, env: t.env })
    assert.deepEqual(threshold(broken.policy, 'hardcoded_secret'), [BASE])
    assert.ok(broken.policy.detectors.some((d) => d.name === 'stripe_live' && d.floor === 'BLOCK'))
    assert.ok(broken.warnings.some((a) => a.includes('.jev-hooks/policy.json')))
  } finally {
    t.close()
  }
})

test('project: a symbolic link is not read (it would end up in an error message)', () => {
  const t = tempDir()
  try {
    const secret = join(t.dir, 'outside.txt')
    writeFileSync(secret, 'reserved-content-that-must-not-go-out')
    mkdirSync(join(t.dir, '.jev-hooks'))
    symlinkSync(secret, join(t.dir, '.jev-hooks', 'policy.json'))
    const c = load({ cwd: t.dir, env: t.env })
    assert.ok(c.warnings.some((a) => a.includes('symbolic link')))
    assert.ok(!JSON.stringify(c.warnings).includes('reserved-content'))
  } finally {
    t.close()
  }
})

test('project: a .jev-hooks/ directory that is a link is not followed; the hook keeps the HEAD rules', () => {
  const r = createRepo()
  try {
    r.write('.jev-hooks/policy.json', project(STRICT))
    r.commit('rules')
    const outside = join(r.base, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'policy.json'), project(STRICTER))
    rmSync(join(r.dir, '.jev-hooks'), { recursive: true })
    symlinkSync(outside, join(r.dir, '.jev-hooks'))
    const cli = load({ cwd: r.dir, env: r.env, origin: 'cli' })
    assert.ok(cli.warnings.some((a) => a.includes('symbolic link')))
    assert.deepEqual(threshold(cli.policy, 'hardcoded_secret'), [BASE])
    const hook = load({ cwd: r.dir, env: r.env, origin: 'hook' })
    assert.deepEqual(threshold(hook.policy, 'hardcoded_secret'), [STRICT])
  } finally {
    r.close()
  }
})

test('.jev-hooks/ rules that differ from HEAD: hook and skill use HEAD, the CLI the working tree', () => {
  const r = createRepo()
  try {
    r.write('.jev-hooks/policy.json', project(STRICT))
    r.commit('project rules')
    const clean = load({ cwd: r.dir, env: r.env, origin: 'hook' })
    assert.deepEqual(clean.modifiedRules, [])
    assert.deepEqual(threshold(clean.policy, 'hardcoded_secret'), [STRICT])

    r.write('.jev-hooks/policy.json', project(STRICTER))
    r.write('.jev-hooks/checks.json', '{}')          // untracked: it counts too
    const hook = load({ cwd: r.dir, env: r.env, origin: 'hook' })
    assert.deepEqual(hook.modifiedRules, ['checks.json', 'policy.json'])
    assert.deepEqual(threshold(hook.policy, 'hardcoded_secret'), [STRICT], 'with the HEAD rules')
    assert.equal(hook.sources.policy.endsWith('.jev-hooks/policy.json (HEAD) (restrictions only)'), true, hook.sources.policy)
    assert.ok(hook.warnings.some((a) => a.startsWith('reviewer rules modified and not committed: checks.json, policy.json')))

    const cli = load({ cwd: join(r.dir), env: r.env, origin: 'cli' })
    assert.deepEqual(threshold(cli.policy, 'hardcoded_secret'), [STRICTER])
    assert.ok(cli.warnings.some((a) => a.includes('the CLI uses the working tree ones')))
  } finally {
    r.close()
  }
})

test('local git drivers: no comparison with the working tree, the hook with the HEAD rules', () => {
  const r = createRepo()
  try {
    r.write('.jev-hooks/policy.json', project(STRICT))
    r.commit('rules')
    r.git('config', 'filter.x.clean', 'cat')
    r.write('.jev-hooks/policy.json', project(STRICTER))
    const hook = load({ cwd: r.dir, env: r.env, origin: 'skill' })
    assert.deepEqual(threshold(hook.policy, 'hardcoded_secret'), [STRICT])
    assert.ok(hook.warnings.some((a) => a.includes('local git drivers')))
    // the comparison was not made: HEAD to be safe, but no change declared
    assert.deepEqual(hook.modifiedRules, [])
  } finally {
    r.close()
  }
})

test('guardrail mask map: missing, valid, invalid', () => {
  const t = tempDir()
  try {
    assert.deepEqual(loadMaskMap(t.env), { maskMap: null })
    const f = join(t.dir, 'mask.tsv')
    writeFileSync(f, '# test\nqzrealproject placeholderqz\n')
    const ok = loadMaskMap({ ...t.env, GUARDRAIL_MASK_MAP: f })
    assert.deepEqual(ok.maskMap, [{ real: 'qzrealproject', placeholder: 'placeholderqz' }])
    writeFileSync(f, 'only-one-field\n')
    const ko = loadMaskMap({ ...t.env, GUARDRAIL_MASK_MAP: f })
    assert.equal(ko.maskMap, null)
    assert.equal(ko.error?.kind, 'mask_map')
    // the default path is guardrail's
    mkdirSync(join(t.home, '.config', 'guardrail'), { recursive: true })
    writeFileSync(join(t.home, '.config', 'guardrail', 'mask.tsv'), 'qzother placeholderother\n')
    assert.equal(loadMaskMap(t.env).maskMap?.length, 1)
    // and loadConfig brings it into the configuration, with the error if it is broken
    writeFileSync(join(t.home, '.config', 'guardrail', 'mask.tsv'), 'broken\n')
    const c = load({ cwd: t.dir, env: t.env })
    assert.equal(c.maskMapError?.kind, 'mask_map')
    assert.ok(c.warnings.some((a) => a.includes('nothing is sent to non-local backends')))
  } finally {
    t.close()
  }
})

test('key file: first line, a warning if others can read it', () => {
  const t = tempDir()
  try {
    assert.deepEqual(readKeyFile(t.env), {})
    const dir = join(t.home, '.config', 'jev-hooks')
    mkdirSync(dir, { recursive: true })
    const f = join(dir, 'key')
    writeFileSync(f, '\n  fake-test-key-value  \nother\n', { mode: 0o600 })
    chmodSync(f, 0o600)
    assert.deepEqual(readKeyFile(t.env), { key: 'fake-test-key-value' })
    chmodSync(f, 0o644)
    const loose = readKeyFile(t.env)
    assert.equal(loose.key, 'fake-test-key-value')
    assert.match(loose.warning ?? '', /chmod 600/)
    assert.ok(!(loose.warning ?? '').includes('fake-test-key'))
  } finally {
    t.close()
  }
})

// Whoever writes to the repo chooses the names of the files in .jev-hooks/, and the
// message ends up in the reason of a deny that Claude reads: only the known
// names, the others counted.
test('modified rules: only the configuration files are named, the others are counted', () => {
  assert.equal(describeModifiedRules(['checks.json', 'policy.json']), 'checks.json, policy.json')
  assert.equal(describeModifiedRules(['A name\nwith a line break\u202e.txt']), '1 file')
  assert.equal(describeModifiedRules(['policy.json', 'x y.json']), 'policy.json and one more file')
  assert.equal(describeModifiedRules(['a', 'router.json', 'b/c.json', 'calibration.json']), 'calibration.json, router.json and 2 more files')
  const r = createRepo()
  try {
    r.write('.jev-hooks/policy.json', '{}')
    r.commit('project rules')
    r.write('.jev-hooks/A name\nwith a line break.txt', 'x')
    for (const origin of ['hook', 'cli'] as const) {
      const c = load({ cwd: r.dir, env: r.env, origin })
      assert.deepEqual(c.modifiedRules, ['A name\nwith a line break.txt'])
      assert.ok(c.warnings.some((a) => a.includes('(1 file)') || a.includes(': 1 file;')), c.warnings.join('\n'))
      assert.ok(!c.warnings.some((a) => a.includes('A name')), c.warnings.join('\n'))
    }
  } finally {
    r.close()
  }
})

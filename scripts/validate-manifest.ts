// Checks the plugin manifests before Claude Code does: plugin.json, marketplace.json,
// hooks/hooks.json, and the four JSON files of config/. `claude plugin validate` does
// not run in CI without installing Claude Code, and it does not see the things that
// break the plugin only at runtime: versions out of step between the two manifests
// (the update never arrives), hooks pointing to scripts that do not exist (every event
// ends in an error), an invalid JSON in config/ (the reviewer does not start).
//
// Usage: node scripts/validate-manifest.ts [root]   (exit 1 if there is a problem)
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeConfig, HOOK_TIMEOUT_S, validateRouter } from '../src/core/config.ts'
import { formatProblem, parseJson } from '../src/core/json.ts'

type PlainObject = Record<string, unknown>

const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'))
const problems: string[] = []
const done: string[] = []

function isObject(v: unknown): v is PlainObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function readJsonRel(rel: string): unknown {
  const path = join(root, rel)
  if (!existsSync(path)) {
    problems.push(`${rel}: file missing`)
    return undefined
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    problems.push(`${rel}: invalid JSON (${(err as Error).message})`)
    return undefined
  }
}

// userConfig fields allowed by the Claude Code 2.1.283 schema (re-checked in the binary).
const OPTION_FIELDS = new Set(['type', 'title', 'description', 'required', 'default', 'multiple', 'sensitive', 'min', 'max', 'options'])
const OPTION_TYPES = new Set(['string', 'number', 'boolean', 'directory', 'file'])

function validatePlugin(p: unknown): PlainObject | undefined {
  const f = '.claude-plugin/plugin.json'
  if (!isObject(p)) {
    if (p !== undefined) problems.push(`${f}: expected an object`)
    return undefined
  }
  if (typeof p.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(p.name)) problems.push(`${f} /name: expected a lowercase name with hyphens`)
  if (typeof p.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(p.version)) problems.push(`${f} /version: expected an X.Y.Z version`)
  const uc = p.userConfig
  if (uc !== undefined) {
    if (!isObject(uc)) problems.push(`${f} /userConfig: expected an object`)
    else {
      for (const [key, def] of Object.entries(uc)) {
        const pt = `${f} /userConfig/${key}`
        // the key becomes CLAUDE_PLUGIN_OPTION_<KEY> in the hooks: it must be an identifier
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) problems.push(`${pt}: the key must be an identifier`)
        if (!isObject(def)) {
          problems.push(`${pt}: expected an object`)
          continue
        }
        for (const field of Object.keys(def)) if (!OPTION_FIELDS.has(field)) problems.push(`${pt}/${field}: field not allowed by the schema`)
        if (typeof def.type !== 'string' || !OPTION_TYPES.has(def.type)) problems.push(`${pt}/type: expected one of ${[...OPTION_TYPES].join(', ')}`)
        if (def.options !== undefined && (def.type !== 'string' || def.sensitive === true)) problems.push(`${pt}/options: only applies to non-sensitive strings`)
        if (def.default !== undefined) {
          const expected = def.type === 'boolean' ? 'boolean' : def.type === 'number' ? 'number' : 'string'
          if (typeof def.default !== expected) problems.push(`${pt}/default: expected a value of type ${expected}`)
        }
      }
    }
  }
  return p
}

function validateMarketplace(m: unknown, plugin: PlainObject | undefined): void {
  const f = '.claude-plugin/marketplace.json'
  if (!isObject(m)) {
    if (m !== undefined) problems.push(`${f}: expected an object`)
    return
  }
  if (typeof m.name !== 'string' || m.name === '') problems.push(`${f} /name: expected a name`)
  if (!isObject(m.owner) || typeof m.owner.name !== 'string') problems.push(`${f} /owner/name: expected a name`)
  if (!Array.isArray(m.plugins) || m.plugins.length === 0) {
    problems.push(`${f} /plugins: expected a non-empty list`)
    return
  }
  if (!plugin) return
  const i = m.plugins.findIndex((v) => isObject(v) && v.name === plugin.name)
  if (i < 0) {
    problems.push(`${f} /plugins: the "${String(plugin.name)}" entry is missing`)
    return
  }
  const item = m.plugins[i] as PlainObject
  // versions out of step: /plugin update compares the marketplace one and does not see the release
  if (item.version !== plugin.version) problems.push(`${f} /plugins/${i}/version: "${String(item.version)}" differs from plugin.json ("${String(plugin.version)}")`)
  if (item.source !== './') problems.push(`${f} /plugins/${i}/source: expected "./" (the repo is both plugin and marketplace)`)
}

// Resolves ${CLAUDE_PLUGIN_ROOT}/… against the repo root and reports the missing files.
function checkReferences(text: string, pt: string): void {
  for (const m of text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^\s"'$]+)/g)) {
    if (!existsSync(join(root, m[1]))) problems.push(`${pt}: "${m[1]}" does not exist`)
  }
}

function validateHooks(h: unknown): void {
  const f = 'hooks/hooks.json'
  if (!isObject(h)) {
    if (h !== undefined) problems.push(`${f}: expected an object`)
    return
  }
  if (!isObject(h.hooks)) problems.push(`${f} /hooks: expected an object`)
  else {
    for (const [event, groups] of Object.entries(h.hooks)) {
      if (!Array.isArray(groups)) {
        problems.push(`${f} /hooks/${event}: expected a list`)
        continue
      }
      groups.forEach((g, i) => {
        const pg = `${f} /hooks/${event}/${i}`
        if (!isObject(g) || !Array.isArray(g.hooks)) {
          problems.push(`${pg}/hooks: expected a list`)
          return
        }
        g.hooks.forEach((hk, j) => {
          const ph = `${pg}/hooks/${j}`
          if (!isObject(hk)) {
            problems.push(`${ph}: expected an object`)
            return
          }
          if (hk.type !== 'command') return
          if (typeof hk.command !== 'string') problems.push(`${ph}/command: expected a string`)
          else checkReferences(hk.command, `${ph}/command`)
          const args = Array.isArray(hk.args) ? hk.args : []
          args.forEach((a, k) => {
            if (typeof a !== 'string') problems.push(`${ph}/args/${k}: expected a string`)
            else checkReferences(a, `${ph}/args/${k}`)
          })
          // run-node.sh runs src/hook/main.ts: registering a hook before it exists means an error on every event
          if (args.some((a) => typeof a === 'string' && a.endsWith('/hooks/run-node.sh')) && !existsSync(join(root, 'src/hook/main.ts'))) {
            problems.push(`${ph}/args: run-node.sh runs src/hook/main.ts, which does not exist`)
          }
          if (hk.timeout !== undefined && (typeof hk.timeout !== 'number' || !(hk.timeout > 0))) problems.push(`${ph}/timeout: expected a positive number of seconds`)
          // policy.json limits the hook's and the skill's total_ms to HOOK_TIMEOUT_S − 20 s: with a
          // shorter timeout Claude Code would cancel the review before its deadline
          const event = args.length > 1 ? args[1] : undefined
          if (typeof event === 'string' && ['commit', 'skill', 'expand'].includes(event)
            && (typeof hk.timeout !== 'number' || hk.timeout < HOOK_TIMEOUT_S)) {
            problems.push(`${ph}/timeout: the review (${event}) needs at least ${HOOK_TIMEOUT_S} s`)
          }
        })
      })
    }
  }
  if (h.modules !== undefined) {
    if (!Array.isArray(h.modules)) problems.push(`${f} /modules: expected a list`)
    else {
      // Claude Code's loader accepts only one module per plugin
      if (h.modules.length > 1) problems.push(`${f} /modules: at most one module per plugin`)
      h.modules.forEach((mod, i) => {
        const pm = `${f} /modules/${i}`
        if (typeof mod !== 'string' || mod === '') {
          problems.push(`${pm}: expected a path relative to hooks/`)
          return
        }
        // Claude Code resolves the path against hooks/ and refuses one that leaves the
        // plugin's folder; the repo's code is TypeScript run by type stripping (rule 1)
        if (isAbsolute(mod) || mod.startsWith('\\')) problems.push(`${pm}: "${mod}" must be relative to hooks/`)
        else if (!(resolve(root, 'hooks', mod) + sep).startsWith(root + sep)) problems.push(`${pm}: "${mod}" leaves the plugin's folder`)
        else if (!mod.endsWith('.ts')) problems.push(`${pm}: "${mod}" must be a .ts file`)
        else if (!existsSync(join(root, 'hooks', mod))) problems.push(`${pm}: "${mod}" does not exist in hooks/`)
      })
    }
  }
}

// The plugin defaults must be valid on their own: they are the last fallback of every
// layer, and if they are not valid the reviewer has nothing to use.
function validateConfig(): void {
  const f = (name: string) => {
    const path = join(root, 'config', name)
    if (!existsSync(path)) {
      problems.push(`config/${name}: file missing`)
      return undefined
    }
    return { path: `config/${name}`, text: readFileSync(path, 'utf8') }
  }
  const checks = f('checks.json')
  const policy = f('policy.json')
  const calibration = f('calibration.json')
  const router = f('router.json')
  if (!checks || !policy || !calibration || !router) return
  const c = composeConfig({ plugin: { checks, policy, calibration }, user: {}, project: {} })
  if (!c.ok) {
    for (const p of c.error.problems ?? []) problems.push(formatProblem(p))
    if (!c.error.problems?.length) problems.push(c.error.message)
    return
  }
  const j = parseJson(router.text, router.path)
  const r = j.ok ? validateRouter(j.value, c.value.calibration, router.path) : j
  if (!r.ok) {
    for (const p of r.error.problems ?? []) problems.push(formatProblem(p))
  }
}

// "ok" only for the files that produced no problems
function check<T>(file: string, f: () => T): T {
  const before = problems.length
  const r = f()
  if (problems.length === before) done.push(`ok ${file}`)
  return r
}

const plugin = check('.claude-plugin/plugin.json', () => validatePlugin(readJsonRel('.claude-plugin/plugin.json')))
check('.claude-plugin/marketplace.json', () => validateMarketplace(readJsonRel('.claude-plugin/marketplace.json'), plugin))
check('hooks/hooks.json', () => validateHooks(readJsonRel('hooks/hooks.json')))
check('config/*.json', () => validateConfig())

for (const line of done) console.log(line)
if (problems.length > 0) {
  for (const p of problems) console.error(`error: ${p}`)
  process.exit(1)
}

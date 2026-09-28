// Runs tests-cc/ with Claude Code's own test kit (`claude plugin test`) on a staged copy
// of the plugin. The copy is needed for three reasons:
// - `claude plugin test <dir>` takes a plugin root (a hooks/hooks.json that names the
//   module in "modules") and runs every *.test.ts under it. The repo root would collect
//   the node:test files of tests/, which cannot import node:test there, and a nested
//   hooks.json that points up to hooks/register.ts is refused as leaving its folder.
// - The kit loads the plugin with the manifest's defaults and cannot set an option: in
//   the copy, never in the repo, effort_router is on by default.
// - The command hooks run bash scripts the kit has no use for: the copy's hooks.json
//   names the module only.
// The copy holds .claude-plugin/, hooks/hooks.json, hooks/register.ts, src/core/ and
// tests-cc/, under the system's temporary directory, and is removed at the end.
// Function hooks are early access, so the child gets CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1.
// A local check, not a CI one: without the claude CLI it says so and exits 0.
//
// Usage: node scripts/test-cc.ts   (exit code of `claude plugin test`)
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

export function stage(dir: string): void {
  cpSync(join(root, '.claude-plugin'), join(dir, '.claude-plugin'), { recursive: true })
  const manifest = join(dir, '.claude-plugin', 'plugin.json')
  const plugin = JSON.parse(readFileSync(manifest, 'utf8'))
  plugin.userConfig.effort_router.default = true
  writeFileSync(manifest, `${JSON.stringify(plugin, null, 2)}\n`)
  mkdirSync(join(dir, 'hooks'))
  writeFileSync(join(dir, 'hooks', 'hooks.json'), `${JSON.stringify({ modules: ['./register.ts'] })}\n`)
  cpSync(join(root, 'hooks', 'register.ts'), join(dir, 'hooks', 'register.ts'))
  cpSync(join(root, 'src', 'core'), join(dir, 'src', 'core'), { recursive: true })
  cpSync(join(root, 'tests-cc'), join(dir, 'tests-cc'), { recursive: true })
}

function main(): number {
  const probe = spawnSync('claude', ['--version'], { stdio: 'ignore' })
  if ((probe.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    console.log('skipped: claude not found (tests-cc needs the Claude Code CLI)')
    return 0
  }
  const dir = mkdtempSync(join(tmpdir(), 'jev-hooks-cc-'))
  try {
    stage(dir)
    const r = spawnSync('claude', ['plugin', 'test', dir], {
      stdio: 'inherit',
      env: { ...process.env, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' },
    })
    if (r.error) {
      console.error(`claude plugin test did not run: ${r.error.message}`)
      return 1
    }
    return r.status ?? 1
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Run as a program, not imported.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main()
}

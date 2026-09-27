#!/usr/bin/env node
// Launcher of the jev-review CLI. It is plain JavaScript on purpose: on a Node
// without type stripping a .ts file would not even start, failing with a syntax error
// that explains nothing. Here the runtime is checked and the problem is stated, with
// exit 4 like every other CLI error.
const [major, minor] = process.versions.node.split('.').map(Number)
const versionOk = (major === 22 && minor >= 18) || major >= 23
const typeStripping = process.features && process.features.typescript
if (!versionOk || !typeStripping) {
  const reason = !versionOk ? `found Node ${process.version}` : 'it is turned off, maybe by --no-experimental-strip-types'
  process.stderr.write(`jev-review: Node >= 22.18 with type stripping enabled is needed: ${reason}\n`)
  process.exit(4)
}

const { nodeContext, main } = await import('../src/cli/main.ts')
process.exitCode = await main(process.argv.slice(2), nodeContext())

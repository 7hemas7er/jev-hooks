// Entry point of the GitHub Action. Plain JavaScript on purpose: on a runtime without
// type stripping a .ts file would not even start, and a workflow_run review would leave
// no check run at all. Here the runtime is checked first; without TypeScript support
// the review cannot run through no fault of the pull request, so the check run is
// neutral, with the reason, and the step exits 0.
const typeStripping = process.features && process.features.typescript

if (typeStripping) {
  const { main } = await import('../src/action/main.ts')
  process.exitCode = await main({ env: process.env, write: (s) => { process.stdout.write(s) } })
} else {
  process.exitCode = await withoutTypeScript(process.env)
}

async function withoutTypeScript(env) {
  const reason = `runtime without TypeScript support (Node ${process.version}): jev-review not run`
  process.stdout.write(`::warning::jev-review: ${reason}\n`)
  const input = (name) => (env[`INPUT_${name.toUpperCase()}`] || '').trim()
  if ((input('mode') || 'workflow_run') !== 'workflow_run') return 1
  let headSha
  try {
    const { readFileSync } = await import('node:fs')
    headSha = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')).workflow_run.head_sha
  } catch {
    headSha = undefined
  }
  const token = input('checks-token') || input('github-token')
  const repo = env.GITHUB_REPOSITORY || ''
  if (typeof headSha !== 'string' || !/^[0-9a-f]{40}$/.test(headSha) || token === '' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return 1
  const base = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '')
  try {
    const r = await fetch(`${base}/repos/${repo}/check-runs`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'jev-hooks', 'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'jev-review', head_sha: headSha, status: 'completed', conclusion: 'neutral',
        output: { title: 'review not run', summary: `## review not run\n\n${reason}` },
      }),
    })
    return r.status === 201 ? 0 : 1
  } catch {
    return 1
  }
}

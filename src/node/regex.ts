// The regexes that come from the project, run in a Worker with a time limit:
// the detectors added by .jev-hooks/policy.json and the path regexes of a
// .jev-hooks/checks.json (escalation_patterns, all_files_match). The static check of
// the regexes (config.ts) rejects the known shapes of catastrophic backtracking, but it
// is a list, not a proof: a regex from a cloned repo that hangs would block the hook
// until Claude Code's timeout, and the commit would go through without even the
// floors. In a Worker it can be stopped: after the time limit (2 s for each of the two
// jobs) the Worker is terminated and those regexes count as unevaluated, that is,
// partial coverage.
//
// The file is both a module and a Worker: new Worker() reopens it with a workerData
// that it recognizes, and then it runs the job and answers.
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads'
import { detect } from '../core/detectors.ts'
import type { ParsedDiff, DetectorResult, Policy, RegexSource } from '../core/types.ts'

export const REGEX_TIMEOUT_MS = 2000

const MARK = 'jev-hooks:project-detectors'
const PATHS_MARK = 'jev-hooks:path-regexes'

interface WorkerJob { mark: string; policy: Policy; diff: ParsedDiff; meta: { title: string; description: string | null } }
interface PathsJob { mark: string; regex: RegexSource[]; paths: string[] }

// A Worker on this same file: its answer, or null if the time runs out or the Worker
// fails.
function inWorker<T>(job: WorkerJob | PathsJob, timeMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    let finished = false
    let w: Worker
    const end = (v: T | null): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      w.terminate().catch(() => {})
      resolve(v)
    }
    try {
      w = new Worker(new URL(import.meta.url), { workerData: job, stdout: true, stderr: true })
    } catch {
      resolve(null)
      return
    }
    const timer = setTimeout(() => end(null), timeMs)
    w.once('message', (m: unknown) => end(m as T))
    w.once('error', () => end(null))
    w.once('exit', () => end(null))
  })
}

// The runProjectDetectors port of review(). The RegExps reach the Worker through
// structured cloning, with source and flags.
export function detectInWorker(
  p: Policy, d: ParsedDiff, meta: { title: string; description: string | null }, o: { timeMs?: number } = {},
): Promise<DetectorResult | null> {
  return inWorker<DetectorResult>({ mark: MARK, policy: p, diff: d, meta }, o.timeMs ?? REGEX_TIMEOUT_MS)
}

// The matchProjectPaths port of review(): for each regex, the indexes of the paths
// that match it.
export function matchPathsInWorker(regex: RegexSource[], paths: string[], o: { timeMs?: number } = {}): Promise<number[][] | null> {
  return inWorker<number[][]>({ mark: PATHS_MARK, regex, paths }, o.timeMs ?? REGEX_TIMEOUT_MS)
}

function matches(job: PathsJob): number[][] {
  return job.regex.map(({ source, flags }) => {
    // without g and y (config.ts rejects them): test() does not depend on lastIndex
    const re = new RegExp(source, flags.replace(/[gy]/g, ''))
    const out: number[] = []
    job.paths.forEach((x, j) => {
      if (re.test(x)) out.push(j)
    })
    return out
  })
}

if (!isMainThread) {
  const job = workerData as (WorkerJob | PathsJob) | undefined
  if (job?.mark === MARK) parentPort?.postMessage(detect((job as WorkerJob).diff, (job as WorkerJob).meta, (job as WorkerJob).policy))
  else if (job?.mark === PATHS_MARK) parentPort?.postMessage(matches(job as PathsJob))
}

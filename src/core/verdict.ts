// The verdict. The code always computes it, never the model: the model
// answers small, observable questions, and the lanes of policy.json turn the
// calibrated answers into BLOCK, SECURITY REVIEW, NITS or MERGE.
//
// Three safety rules hold everything together, and the tests check them on thousands
// of random combinations:
// - detector floors can only raise the verdict: an AKIA… key in src/ blocks even if
//   the model (or an injection in the diff) says everything is fine;
// - partial coverage can only raise it: a problem found counts even in an incomplete
//   review, the absence of problems does not;
// - a rule without a value does not fire, but that is reported ("unevaluated").
import { ruleThreshold } from './calibration.ts'
import type {
  Checks, CiConclusion, Lane, DetectorResult, Op, Policy, Rule, ReviewResult, FiredRule, ProfileSelection, CheckValue,
  EscalationItem,
} from './types.ts'

export type { FiredRule, CheckValue, ChunkValue } from './types.ts'

// What the review did not see. truncated, projectDetectorsTimedOut and
// pathRegexesTimedOut are optional: a caller that does not tell them apart can fold
// them into incomplete.
export interface CoverageGaps {
  omitted: number
  unreviewable: number
  incomplete: boolean
  truncated?: boolean
  projectDetectorsTimedOut?: number
  pathRegexesTimedOut?: boolean                  // path regexes of a project checks.json
}

export function compare(x: number, op: Op, s: number): boolean {
  switch (op) {
    case 'gte': return x >= s
    case 'gt': return x > s
    case 'lte': return x <= s
    case 'lt': return x < s
  }
}

// A usable value: present as an own property (a valid id such as "constructor" must
// not pick from the prototype) and finite.
export function numericValue(v: Readonly<Record<string, CheckValue>>, id: string): number | undefined {
  if (!Object.hasOwn(v, id)) return undefined
  const x = v[id].value
  return Number.isFinite(x) ? x : undefined
}

// Severity index of a lane: the order of the policy.json array, 0 = the most severe.
function severity(p: Policy, name: string): number {
  return p.lanes.findIndex((c) => c.name === name)
}

// The synthetic partial-coverage rule, or null if the review saw everything. The text
// ends up in the output as it is.
export function partialCoverage(z: CoverageGaps): string | null {
  const reasons: string[] = []
  const unseen = z.omitted + z.unreviewable
  if (unseen > 0) reasons.push(`${unseen} ${unseen === 1 ? 'file' : 'files'} not examined`)
  if (z.truncated) reasons.push('truncated diff')
  if (z.projectDetectorsTimedOut) reasons.push('project detectors timed out')
  if (z.pathRegexesTimedOut) reasons.push('path regexes of the project checks.json timed out')
  if (z.incomplete) reasons.push('incomplete review')
  return reasons.length ? `partial coverage: ${reasons.join(', ')}` : null
}

// A rule on the review's values, with the effective threshold (policy or profile).
// undefined if the check has no value: the rule does not fire and goes among the
// unevaluated ones. unlessWithoutValue: the unless names a check without a value, so
// it is false and the rule fires anyway. The verdict, the escalation and the
// policy simulator (scripts/simulate-policy.ts) all use it, so a rule fires the same
// way everywhere.
export interface EvaluatedRule {
  fires: boolean
  value: number
  threshold: number
  source: 'policy' | 'profile'
  unlessWithoutValue?: string
}

export function evaluateRule(
  r: Rule, v: Readonly<Record<string, CheckValue>>, s: ProfileSelection, hashOk?: Readonly<Record<string, boolean>>,
): EvaluatedRule | undefined {
  const x = numericValue(v, r.check)
  if (x === undefined) return undefined
  const thr = ruleThreshold(r.check, r.value, s, hashOk)
  const out: EvaluatedRule = { fires: compare(x, r.op, thr.value), value: x, threshold: thr.value, source: thr.source }
  if (!out.fires || !r.unless) return out
  // The profile's threshold replaces the value of the rules ON that check, not of the
  // conditions that cancel a rule: an unless that is easier to satisfy would lower the
  // verdict.
  const u = numericValue(v, r.unless.check)
  if (u === undefined) out.unlessWithoutValue = r.unless.check
  else if (compare(u, r.unless.op, r.unless.value)) out.fires = false
  return out
}

export function decide(
  v: Record<string, CheckValue>, p: Policy, s: ProfileSelection, floors: DetectorResult['floors'],
  partial: CoverageGaps, hashOk: Record<string, boolean>,
): { lane: Lane; fired: FiredRule[]; unevaluated: string[]; notes: string[] } {
  const fired: FiredRule[] = []
  const unevaluated: string[] = []
  const notes: string[] = []
  const markUnevaluated = (id: string): void => {
    if (!unevaluated.includes(id)) unevaluated.push(id)
  }

  // 1–2. The model's lane: the first one with a fired rule, otherwise the last one.
  // Every lane is evaluated anyway: the output also shows the minor rules. A rule with
  // action "escalation" brings the verdict to its lane like the others; escalation()
  // adds the item for Claude.
  let final = p.lanes.length - 1
  p.lanes.forEach((lane, i) => {
    for (const r of lane.rules) {
      const e = evaluateRule(r, v, s, hashOk)
      if (e === undefined) {
        markUnevaluated(r.check)
        continue
      }
      if (e.unlessWithoutValue !== undefined) {
        markUnevaluated(e.unlessWithoutValue)
        notes.push(`${r.check}: the unless condition on ${e.unlessWithoutValue} has no value, the rule fires anyway`)
      }
      if (!e.fires) continue
      const sc: FiredRule = { lane: lane.name, check: r.check, value: e.value, op: r.op, threshold: e.threshold, source: e.source }
      if (r.action !== undefined) sc.action = r.action
      fired.push(sc)
      final = Math.min(final, i)
    }
  })

  // 3. Detector floors: the most severe between the model's lane and the floors.
  for (const f of floors) {
    const i = severity(p, f.lane)
    if (i < 0) {
      notes.push(`floor towards an unknown lane "${f.lane}" (${f.by.join(', ')}): ignored`)
      continue
    }
    for (const by of f.by) fired.push({ lane: f.lane, check: by, value: 1, op: 'gte', threshold: 1, source: 'floor' })
    final = Math.min(final, i)
  }

  // 4. Partial coverage: at least partial_coverage.min_lane.
  const coverage = partialCoverage(partial)
  if (coverage) {
    const i = severity(p, p.partial_coverage.min_lane)
    notes.push(coverage)
    if (i >= 0) {
      fired.push({
        lane: p.partial_coverage.min_lane, check: 'coverage', value: partial.omitted + partial.unreviewable,
        op: 'gte', threshold: 0, source: 'coverage',
      })
      final = Math.min(final, i)
    }
  }

  // from the most severe to the least severe; within a lane the policy.json order stays
  fired.sort((a, b) => severity(p, a.lane) - severity(p, b.lane))
  return { lane: p.lanes[final], fired, unevaluated, notes }
}

// ─── After the verdict ────────────────────────────────────────────────────────

// merge_ready: the last lane, no escalation, full coverage.
export function mergeReady(final: Lane, p: Policy, escalation: readonly EscalationItem[], partial: CoverageGaps): boolean {
  return final.name === p.lanes[p.lanes.length - 1].name && escalation.length === 0 && partialCoverage(partial) === null
}

// The nouls computed from the verdict (compute.from_verdict): 1 if the final lane is
// the named one, with no escalation and full coverage. They never enter a rule
// (validation forbids it): asking the model for the whole verdict is exactly the
// mistake this design avoids.
export function valuesFromVerdict(checks: Checks, final: Lane, escalation: readonly EscalationItem[], partial: CoverageGaps): Record<string, CheckValue> {
  const clean = escalation.length === 0 && partialCoverage(partial) === null
  const out: Record<string, CheckValue> = {}
  for (const id of checks.order) {
    const lane = checks.defs[id].compute?.from_verdict
    if (lane === undefined) continue
    out[id] = { value: final.name === lane && clean ? 1 : 0, source: 'computed' }
  }
  return out
}

const CI_WEIGHT: Record<CiConclusion, number> = { success: 0, neutral: 1, failure: 2 }

function worse(a: CiConclusion, b: CiConclusion): CiConclusion {
  return CI_WEIGHT[b] > CI_WEIGHT[a] ? b : a
}

// The conclusion of the check run: the most severe among the lane's, the
// escalation's and the class's. The two classes stay separate because they have
// different owners: a backend that is off does not depend on the PR author (neutral by
// default), while everything the PR controls or can cause, partial coverage included,
// is untrusted input (failure).
export function ciConclusion(
  o: {
    lane: Lane
    escalation: readonly EscalationItem[]
    partial: CoverageGaps
    outcome: ReviewResult['outcome']
    backendUnavailable?: boolean
  },
  p: Policy,
): ReviewResult['ci'] {
  let conclusion = o.lane.ci
  // escalation.ci applies to escalations on the merits; the coverage one falls into the class
  if (o.escalation.some((e) => e.reason !== 'coverage')) conclusion = worse(conclusion, p.escalation.ci)

  const inputReasons: string[] = []
  const coverage = partialCoverage(o.partial)
  if (coverage) inputReasons.push(coverage)
  if (o.outcome === 'incomplete' && !o.partial.incomplete) inputReasons.push('incomplete review')
  if (inputReasons.length === 0 && o.escalation.some((e) => e.reason === 'coverage')) inputReasons.push('coverage escalation')

  const classes: { class: 'backend_unavailable' | 'untrusted_input'; ci: CiConclusion; reason: string }[] = []
  if (inputReasons.length) classes.push({ class: 'untrusted_input', ci: p.ci.untrusted_input, reason: inputReasons.join('; ') })
  if (o.backendUnavailable) classes.push({ class: 'backend_unavailable', ci: p.ci.backend_unavailable, reason: 'backend unavailable' })
  if (classes.length === 0) return { conclusion }

  // on a tie untrusted_input wins, as it comes first: it is the class the PR author controls
  let selection = classes[0]
  for (const c of classes) if (CI_WEIGHT[c.ci] > CI_WEIGHT[selection.ci]) selection = c
  for (const c of classes) conclusion = worse(conclusion, c.ci)
  return { conclusion, class: selection.class, reason: selection.reason }
}

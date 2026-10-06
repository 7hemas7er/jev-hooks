// Per-backend calibration of the probabilities and effective threshold of the
// rules.
//
// rizzo's probabilities are very peaked (71.5% of the answers sit at p ≥ 0.99, and 7
// errors out of 26 sit there): comparing them as they are with the thresholds of
// policy.json would give self-confident verdicts exactly where the model is wrong. The
// backend's profile, chosen from the identity of the first answer, says how to bring
// them onto a scale where 0.7 really means 0.7. The transformations are monotonic:
// they change the distance from the thresholds, never the order of the answers.
//
// Everything is pure and free of check ids: the parameters are in calibration.json.
import { LOGIT_MAX, clippedLogit, sigmoid } from './numbers.ts'
import { questionHash } from './systemone.ts'
import type {
  Calibration, WireQuestion, Identity, CalibrationMode, Policy, Profile, Answer, ProfileSelection, CheckValue, ChunkValue, DerivedValue,
  CalibrationEntry, Checks, ThresholdScale, Rule,
} from './types.ts'

export type { CalibrationMode, ProfileSelection } from './types.ts'

// rizzo writes it in x_rizzo.probability_status for every native type it calibrated
// with --calibration. Only if ALL the types are in this status has the server already
// calibrated everything, and the client must not touch anything (no double
// calibration).
export const SERVER_CALIBRATED_STATUS = 'temperature_scaled_requires_held_out_validation'

// The floor of log(p) in the temperature: the same ±36 clip as the logit, so an exact
// 0 probability stays finite and does not squash the others to zero.
const P_MIN = Math.exp(-LOGIT_MAX)

// Profile used when none matches (a user calibration.json without the fallback
// profile at the end): identity, policy thresholds.
const NO_PROFILE = 'none'

// ─── Choosing the profile ─────────────────────────────────────────────────────

function profileMatches(pr: Profile, id: Identity): boolean {
  const m = pr.match
  if (m.fingerprint !== undefined && m.fingerprint !== id.fingerprint) return false
  if (m.model_prefix !== undefined && !id.model.startsWith(m.model_prefix)) return false
  // host names are case-insensitive: "Spark.local" and "spark.local" are the same backend
  if (m.host !== undefined && m.host.toLowerCase() !== id.host.toLowerCase()) return false
  return true
}

// The first profile whose match fields are all satisfied wins: that is why a
// calibrated profile (match.fingerprint) is added at the top of the file. The band's
// δ: the profile's band_delta_logit always applies, because it is caution and not a
// calibration fit; then wide_delta_logit if the server calibrates; otherwise the
// policy's.
export function chooseProfile(c: Calibration, id: Identity, policyBand: Policy['band']): ProfileSelection {
  const notes: string[] = []
  const found = c.profiles.find((pr) => profileMatches(pr, id))
  let profile: Profile = found ?? { name: NO_PROFILE, match: {}, calibrated: false }
  // the model is not quoted: it is the name the backend gives itself, and the notes go
  // out to Claude (provenance.ts). The result reports it separately, as a hash if
  // needed.
  if (!found) notes.push(`no profile in ${c.file} matches the backend: raw probabilities`)

  const states = id.probabilityStatus ?? []
  const serverCalibrated = states.includes(SERVER_CALIBRATED_STATUS)
  const mode: CalibrationMode = serverCalibrated && states.every((s) => s === SERVER_CALIBRATED_STATUS) ? 'server' : 'client'
  if (mode === 'server') {
    // the thresholds of a calibrated profile apply to probabilities calibrated by the
    // client: they were never measured on the server's
    profile = { ...profile, calibrated: false }
    notes.push('server-side calibration: thresholds not calibrated')
  } else if (serverCalibrated) {
    // mixed statuses: one type is already scaled by the server and the client would
    // scale it again. The profile is applied anyway (the other types need it), but its
    // thresholds are no longer reliable.
    profile = { ...profile, calibrated: false }
    notes.push('partial server-side calibration: serve rizzo without --calibration')
  }
  if (mode === 'client' && !profile.calibrated) notes.push(`thresholds not calibrated for this backend (profile ${profile.name})`)

  const deltaLogit = profile.band_delta_logit ?? (mode === 'server' ? c.wide_delta_logit : policyBand.delta_logit)
  return { profile, mode, deltaLogit, notes }
}

// ─── Per-question entries ─────────────────────────────────────────────────────

// A calibration fit only holds for the exact text it was measured on (changing a
// comma in the instructions moves the answers): the entry is compared with
// questionHash, the sha256 of the canonical JSON of the question as it is really
// sent.
function entryOf(pr: Profile, id: string): CalibrationEntry | undefined {
  // Object.hasOwn: a valid id such as "constructor" must not pick from the prototype
  return pr.per_question && Object.hasOwn(pr.per_question, id) ? pr.per_question[id] : undefined
}

// The profile's per-question entry, if it was measured on the text that is really
// sent; otherwise no entry and the note that says so.
function consistentEntry(id: string, w: WireQuestion, s: ProfileSelection): { item?: CalibrationEntry; note?: string } {
  const item = entryOf(s.profile, id)
  if (item === undefined) return {}
  if (item.sha256 === questionHash(w)) return { item }
  return { note: `question ${id} changed after the calibration fit: thresholds not calibrated for this question` }
}

// For every question, whether the profile's calibrated threshold can be applied to
// it: yes if the profile has no entry for that question, or if the entry was measured
// on the text that is really sent. It is the `hashOk` map of decide() and
// escalation().
export function consistentHashes(questions: Readonly<Record<string, WireQuestion>>, s: ProfileSelection): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const id of Object.keys(questions)) {
    const item = entryOf(s.profile, id)
    out[id] = item === undefined || item.sha256 === questionHash(questions[id])
  }
  return out
}

// ─── Transformations ──────────────────────────────────────────────────────────

// p'_k ∝ exp(log(max(p_k, e⁻³⁶)) / t), subtracting the maximum before exp because
// with small t the divided logs leave the range of a double.
export function applyTemperature(prob: Record<string, number>, t: number): Record<string, number> {
  const keys = Object.keys(prob)
  const div = t > 0 && Number.isFinite(t) ? t : 1
  const log = keys.map((k) => {
    const p = prob[k]
    return Math.log(Number.isFinite(p) && p > P_MIN ? p : P_MIN) / div
  })
  const max = Math.max(...log)
  const exps = log.map((x) => Math.exp(x - max))
  const sum = exps.reduce((a, b) => a + b, 0)
  const out: Record<string, number> = {}
  keys.forEach((k, i) => {
    out[k] = exps[i] / sum
  })
  return out
}

// Confidence as Jev and rizzo define it: 0 with the uniform distribution, 1 with all
// the mass on one option.
function confidence(prob: Record<string, number>): number {
  const values = Object.values(prob)
  const n = values.length
  if (n < 2) return 1
  const c = (n * Math.max(...values) - 1) / (n - 1)
  return Math.min(1, Math.max(0, c))
}

// The level k of every key in the probabilities of a score: indices "0".."n-1" if the
// backend uses them, otherwise the texts of the criteria, otherwise the order of the
// keys. Neither backend documents the shape of the keys: better not to guess.
function levelsOf(keys: string[], w: WireQuestion): number[] {
  const n = keys.length
  const numeric = keys.map((k) => (/^(0|[1-9][0-9]*)$/.test(k) ? Number(k) : -1))
  if (numeric.every((x) => x >= 0 && x < n) && new Set(numeric).size === n) return numeric
  const criteria = Array.isArray(w.criteria) ? w.criteria : []
  const perText = keys.map((k) => criteria.findIndex((c) => c === k))
  if (perText.every((x) => x >= 0) && new Set(perText).size === n) return perText
  return keys.map((_, i) => i)
}

// The option with the highest probability. The router takes it from here too: a
// backend's `choice` is only a claim, and only a temperature recomputes it.
export function argmax(prob: Record<string, number>, preferred: string): string {
  let best = ''
  let max = -1
  for (const [k, p] of Object.entries(prob)) {
    if (p > max) {
      best = k
      max = p
    }
  }
  // on a tie the backend's choice stays: the temperature does not change the order
  return Object.hasOwn(prob, preferred) && prob[preferred] === max ? preferred : best
}

// Platt on the logit clipped at ±36: with rizzo it is exact for a noul, because
// P(yes) = σ(z_B − z_A). The per-question entry wins over the profile's noul block,
// and without either the identity stays. withTemperature: an entry with t and without
// a is worth σ(z/t), that is a Platt with a = 1/t (needed by the choices with a value,
// whose entry may come from a temperature fit).
function platt(p: number, item: CalibrationEntry | undefined, pr: Profile, withTemperature: boolean):
  { p: number; level: 'question' | 'type' | 'identity' } {
  if (item?.a !== undefined) return { p: sigmoid(item.a * clippedLogit(p) + (item.b ?? 0)), level: 'question' }
  if (withTemperature && item?.t !== undefined) return { p: sigmoid(clippedLogit(p) / item.t), level: 'question' }
  if (pr.noul) return { p: sigmoid(pr.noul.a * clippedLogit(p) + pr.noul.b), level: 'type' }
  return { p, level: 'identity' }
}

function copyAnswer(r: Answer): Answer {
  if (r.type === 'noul') return { type: 'noul', noul: r.noul }
  if (r.type === 'choice') return { ...r, probabilities: { ...r.probabilities } }
  return { ...r, probabilities: { ...r.probabilities }, legend: { ...r.legend } }
}

// Calibrates an answer. Calibration is always done on the SENT question: for a
// question with invert the 1 − p flip comes afterwards (restorePolarity,
// aggregateNoul). Order of the entries: per_question with a consistent sha, then the
// type's block, then the identity. The caller keeps the raw value: only the calibrated
// one is returned here, and r is not touched.
export function calibrate(id: string, w: WireQuestion, r: Answer, s: ProfileSelection):
  { response: Answer; tier: 'question' | 'type' | 'identity'; note?: string } {
  if (s.mode === 'server') return { response: copyAnswer(r), tier: 'identity' }

  const { item, note } = consistentEntry(id, w, s)
  if (r.type === 'noul') {
    const x = platt(r.noul, item, s.profile, false)
    return { response: { type: 'noul', noul: x.p }, tier: x.level, ...(note ? { note } : {}) }
  }

  const block = r.type === 'choice' ? s.profile.choice : s.profile.score
  let t: number
  let level: 'question' | 'type'
  if (item?.t !== undefined) {
    t = item.t
    level = 'question'
  } else if (block) {
    t = block.t
    level = 'type'
  } else return { response: copyAnswer(r), tier: 'identity', ...(note ? { note } : {}) }

  const prob = applyTemperature(r.probabilities, t)
  if (r.type === 'choice') {
    const response: Answer = {
      type: 'choice', choice: argmax(prob, r.choice), probabilities: prob, confidence: confidence(prob),
    }
    return { response, tier: level, ...(note ? { note } : {}) }
  }
  // score = Σ k·p'_k. The legend stays the backend's: it describes the levels and does
  // not depend on t; whoever prints picks the closest level.
  const keys = Object.keys(prob)
  const levels = levelsOf(keys, w)
  const score = keys.reduce((acc, k, i) => acc + levels[i] * prob[k], 0)
  const response: Answer = {
    type: 'score', score, legend: { ...r.legend }, probabilities: prob, confidence: confidence(prob),
  }
  return { response, tier: level, ...(note ? { note } : {}) }
}

// ─── Choice with a value ──────────────────────────────────────────────────────
//
// A choice with a value (checks.json "value": "1-p(none)") counts as a noul: the
// probability is 1 − p(option), the sum of the other options, that is "there is a
// problem, of whatever shape". Measured on the bench, the choice with none first
// separates better than the matching noul, and indecision between two shapes of the
// problem (SQL or shell) takes no signal away, because their p add up.

// 1 − p(option) from the answer's probabilities; undefined if the option is missing
// (parseResponse guarantees the keys, but the core does not take it for granted).
export function derivedProbability(v: DerivedValue, prob: Readonly<Record<string, number>>): number | undefined {
  if (!Object.hasOwn(prob, v.option) || !Number.isFinite(prob[v.option])) return undefined
  return Math.min(1, Math.max(0, 1 - prob[v.option]))
}

// The most probable option among those the value adds up: the detail to show
// ("sql_concat"). On a tie the first in option order wins; an option with zero
// probability is not a detail.
export function derivedOption(v: DerivedValue, prob: Readonly<Record<string, number>>): string | undefined {
  let best: string | undefined
  let max = 0
  for (const [k, p] of Object.entries(prob)) {
    if (k === v.option || !Number.isFinite(p) || p <= max) continue
    best = k
    max = p
  }
  return best
}

// Calibrates the derived value q of a choice like a noul: on the logit of q clipped at
// ±36, with the Platt (a, b) or the temperature (t) of the per-question entry if the
// sha matches, otherwise with the profile's noul block, otherwise the identity. The
// choice block plays no part: scaling the distribution by t and then adding up the
// options is not the same transformation, and the probability the verdict compares is
// q.
export function calibrateDerived(id: string, w: WireQuestion, q: number, s: ProfileSelection):
  { p: number; tier: 'question' | 'type' | 'identity'; note?: string } {
  if (s.mode === 'server') return { p: q, tier: 'identity' }
  const { item, note } = consistentEntry(id, w, s)
  const x = platt(q, item, s.profile, true)
  return { p: x.p, tier: x.level, ...(note ? { note } : {}) }
}

// ─── Thresholds ───────────────────────────────────────────────────────────────

// A profile's threshold replaces the rule's value only if the profile is calibrated
// (never with server-side calibration, full or partial: chooseProfile has already
// marked it as uncalibrated) and if the sent question is the one of the calibration
// fit.
export function profileThreshold(check: string, ruleValue: number, s: ProfileSelection, hashConsistent: boolean): { value: number; source: 'policy' | 'profile' } {
  const th = s.profile.thresholds
  if (s.mode === 'client' && s.profile.calibrated && hashConsistent && th && Object.hasOwn(th, check)) {
    return { value: th[check], source: 'profile' }
  }
  return { value: ruleValue, source: 'policy' }
}

// profileThreshold() with the consistency read from the consistentHashes map. A
// question missing from the map is consistent only if the profile has no entry for
// it: when in doubt the policy applies, which is the value the user wrote. A policy
// value moves onto the scale of the calibrated values (scaledThreshold).
//
// The profile comes from the user or the plugin, and it may loosen their rules. A rule
// of the project is a restriction instead, which nothing but a stricter value may
// replace: the two are compared on the calibrated scale, where the policy's value has
// just been moved. On a tie the policy's stays, decided on the raw value it was
// written for.
export function ruleThreshold(r: Pick<Rule, 'check' | 'op' | 'value' | 'fromProject'>, s: ProfileSelection, hashOk?: Readonly<Record<string, boolean>>):
  { value: number; source: 'policy' | 'profile' } {
  const consistent = hashOk && Object.hasOwn(hashOk, r.check) ? hashOk[r.check] : entryOf(s.profile, r.check) === undefined
  const t = profileThreshold(r.check, r.value, s, consistent)
  const policy = { value: scaledThreshold(r.check, r.value, s), source: 'policy' as const }
  if (t.source === 'policy') return policy
  if (!r.fromProject) return t
  const up = r.op === 'gte' || r.op === 'gt'
  return (up ? t.value < policy.value : t.value > policy.value) ? t : policy
}

// ─── Thresholds on the calibrated scale ───────────────────────────────────────
//
// A policy threshold is written on the scale of the raw probabilities it was chosen
// on (the bench's, in the _why of each rule). When the profile transforms a
// question's values (a per-question entry measured on the text that is sent, or the
// type's noul block), the decisions on that question stay on the raw scale: rules,
// unless conditions, the band and the disagreement with a detector compare the raw
// value with the policy's value (decidesOnRaw), so a fit changes no verdict and no
// escalation, for the plugin's rules and for a user's or a project's, whose
// restrictions stay restrictions. A band of δ in raw logit is δ·a in calibrated logit,
// and the fixed 0.5 of the disagreement test moves too: comparing raw values keeps
// both where they were. What is shown is calibrated: the value, and the threshold and
// band edges moved through the same function (scaledThreshold, shownBand), which now
// mean what they say. Only an explicit threshold of a calibrated profile is compared
// on the calibrated scale (profileThreshold).

// The questions whose values the profile transforms, with what the values used.
export function thresholdScales(questions: Readonly<Record<string, WireQuestion>>, checks: Pick<Checks, 'defs'>, s: ProfileSelection):
  Record<string, ThresholdScale> {
  const out: Record<string, ThresholdScale> = {}
  if (s.mode === 'server') return out
  for (const id of Object.keys(questions)) {
    if (!Object.hasOwn(checks.defs, id)) continue
    const def = checks.defs[id]
    const derived = def.type === 'choice' && def.value !== undefined
    if (def.source !== 'model' || (def.type !== 'noul' && !derived)) continue
    const { item } = consistentEntry(id, questions[id], s)
    // an entry of a = 1, b = 0 leaves the values as they are: so does the threshold,
    // exactly, without the rounding of a round trip through the logit
    if (isIdentity(item, s.profile, derived)) continue
    out[id] = { invert: def.invert, derived, ...(item ? { item } : {}) }
  }
  return out
}

// The same order of precedence as platt().
function isIdentity(item: CalibrationEntry | undefined, pr: Profile, withTemperature: boolean): boolean {
  if (item?.a !== undefined) return item.a === 1 && (item.b ?? 0) === 0
  if (withTemperature && item?.t !== undefined) return item.t === 1
  if (pr.noul) return pr.noul.a === 1 && pr.noul.b === 0
  return true
}

export function withThresholdScales(s: ProfileSelection, questions: Readonly<Record<string, WireQuestion>>, checks: Pick<Checks, 'defs'>):
  ProfileSelection {
  return { ...s, scales: thresholdScales(questions, checks, s) }
}

// A policy value on the scale of the check's calibrated values, to show next to them:
// the same function the values went through.
export function scaledThreshold(check: string, value: number, s: ProfileSelection): number {
  const sc = s.scales && Object.hasOwn(s.scales, check) ? s.scales[check] : undefined
  if (!sc || s.mode === 'server') return value
  const p = platt(sc.invert ? 1 - value : value, sc.item, s.profile, sc.derived).p
  return sc.invert ? 1 - p : p
}

// Whether a decision against this threshold is taken on the raw value: a policy value
// on a question whose values the profile transforms.
export function decidesOnRaw(check: string, source: 'policy' | 'profile', s: ProfileSelection): boolean {
  return source === 'policy' && s.mode !== 'server' && !!s.scales && Object.hasOwn(s.scales, check)
}

// The band of δ around a threshold, as shown: taken in raw logit around the policy's
// value when the decision is raw, then moved like the threshold; otherwise around the
// effective threshold.
export function shownBand(check: string, ruleValue: number, t: { value: number; source: 'policy' | 'profile' }, delta: number, s: ProfileSelection):
  [number, number] {
  if (decidesOnRaw(check, t.source, s)) {
    const z = clippedLogit(ruleValue)
    return [scaledThreshold(check, sigmoid(z - delta), s), scaledThreshold(check, sigmoid(z + delta), s)]
  }
  const z = clippedLogit(t.value)
  return [sigmoid(z - delta), sigmoid(z + delta)]
}

// ─── Polarity and aggregation of nouls ────────────────────────────────────────

// Questions with invert are sent in the "yes = problem" form (rizzo is weak on
// negations) and are reported under their id as 1 − p, so the rules the user wrote in
// their own polarity (adds_tests ≤ threshold) stay valid.
export function restorePolarity(p: number, invert: boolean): number {
  return invert ? 1 - p : p
}

// A noul answer to the SENT question, already calibrated (p), and raw. It has the
// shape of ChunkValue, but before the invert flip: aggregateNoul restores it. It also
// holds the value of a choice with a value, which carries the most probable option.
export type SentNoul = ChunkValue & { option?: string }

// The CheckValue of a model probability, a noul or a choice with a value. For
// chunk questions the p of the diff is the maximum of the calibrated p over the chunks
// (noisy-OR would inflate small p as the chunks grow), and perChunk keeps every chunk counted:
// band and disagreement are evaluated chunk by chunk. The maximum is taken on the sent
// question, where "yes" is always the problem; for a question with invert the worst
// chunk is therefore the one with the lowest reported value.
// counts (chunks_matching): only the chunks whose files it accepts make the value and
// perChunk, so an excluded chunk reaches neither the rules nor the band nor a
// detector's disagreement. If it accepts none, every chunk counts: the filter can only
// drop chunks of a diff that has some other chunk where the question can be true.
export function aggregateNoul(
  answers: readonly SentNoul[], o: { invert: boolean; perChunk: boolean; counts?: (files: readonly string[]) => boolean },
): CheckValue | undefined {
  const finite = answers.filter((r) => Number.isFinite(r.p) && Number.isFinite(r.raw))
  const counts = o.counts
  const counted = counts ? finite.filter((r) => counts(r.files)) : finite
  const valid = counted.length > 0 ? counted : finite
  if (valid.length === 0) return undefined
  let worst = valid[0]
  for (const r of valid) if (r.p > worst.p) worst = r
  const v: CheckValue = {
    value: restorePolarity(worst.p, o.invert),
    raw: restorePolarity(worst.raw, o.invert),
    source: 'model',
  }
  if (worst.option !== undefined) v.option = worst.option
  if (o.perChunk) {
    v.worst = [...worst.files]
    v.perChunk = valid.map((r): ChunkValue => ({
      chunk: r.chunk, files: [...r.files], p: restorePolarity(r.p, o.invert), raw: restorePolarity(r.raw, o.invert),
    }))
  }
  return v
}

// Types shared by the whole core and by the adapters. They live in a single file
// because the modules are written in parallel and each one uses the others' types
// (a verdict talks about detector hits, chunks and profiles): the contract is here,
// the logic is in the modules. Every module re-exports the types it works with, so
// `import type { Checks } from './config.ts'` is as good as importing from here.
//
// The file is pure like all of src/core (rule 4): it also runs in the node:vm context
// of Claude Code's module loader. Besides the types it holds only four constants and
// two Result constructors, which everyone needs.

// ─── JSON, results and failures ───────────────────────────────────────────────

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json }

export type Result<T> = { ok: true; value: T } | { ok: false; error: Failure }

export type FailureKind = 'config' | 'not_configured' | 'network' | 'timeout' | 'auth' | 'overflow'
  | 'validation' | 'overloaded' | 'server' | 'response' | 'backend_changed' | 'mask_map' | 'git' | 'internal'

export interface Failure {
  kind: FailureKind
  message: string
  problems?: Problem[]
  // question: the id the backend names, if it is one of the questions sent; '' if not
  overflow?: { question: string; tokens: number; limit: number }
}

// A validation problem: file, JSON pointer (RFC 6901) and message.
// Example: "policy.json", "/lanes/0/rules/1/value", "expected a number between 0 and 1, found \"0,7\"".
export interface Problem { file: string; pointer: string; message: string }

export function okResult<T>(value: T): Result<T> {
  return { ok: true, value }
}

export function errResult<T = never>(kind: FailureKind, message: string, extra?: Omit<Failure, 'kind' | 'message'>): Result<T> {
  return { ok: false, error: { kind, message, ...extra } }
}

// ─── /v1/systemone contract ───────────────────────────────────────────────────

export type QuestionType = 'noul' | 'choice' | 'score'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const EFFORT_SCALE = ['low', 'medium', 'high', 'xhigh', 'max'] as const

// Who submitted a prompt: the kinds of Claude Code 2.1.283's `PromptOrigin`, in the
// order the declaration lists them. There is no "human": the user's own Enter is
// composer, and bridge is the user's message from Remote Control. A closed list,
// so a router.json that names a kind the engine never sends (an earlier draft had
// "human") is an error instead of a router that silently skips every prompt.
export const PROMPT_ORIGIN_KINDS = [
  'composer', 'bridge', 'sdk', 'task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'projects-relay',
  'channel', 'coordinator', 'observer', 'observer-activity', 'auto-continuation', 'unclassified', 'slack-ping', 'plugin',
] as const

// Limits shared by Jev and rizzo-flow, that is the intersection of the two. They
// live here and not in systemone.ts because the JSON validation (config.ts) uses them
// too, and it must reject a non-portable question before it reaches a backend;
// systemone.ts re-exports them.
export const LIMITS = {
  maxQuestions: 64,
  minOptions: 2,
  maxOptions: 26,
  minLevels: 2,
  maxLevels: 10,
  maxText: 8000,
  maxStateBytes: 256_000,
} as const

// What actually goes to the backend: rizzo answers 422 to any extra field inside a
// question (extra=forbid), so no label, critical or anything else.
// instructions is required for every type and never null (rizzo always wants it).
export interface WireQuestion {
  type: QuestionType
  instructions: string | Json[] | { [k: string]: Json }
  criteria?: Json
}

export type Answer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; legend: Record<string, Json>; probabilities: Record<string, number>; confidence: number }

export interface BackendResponse {
  model: string
  answers: Record<string, Answer>
  usage?: { input_tokens: number; output_tokens: number }
  x_rizzo?: { fingerprint?: string; probability_status?: string[]; timing?: Record<string, number> }
}

// An answer discarded by parseResponse: the question ends up among the "unevaluated"
// and the review becomes incomplete, but the other answers of the request stay.
export interface DiscardedAnswer { id: string; reason: string }

export interface Backend { url: string; key: string; model: string; local: boolean; host: string }

export interface Identity {
  host: string
  model: string
  fingerprint?: string
  family: 'rizzo' | 'typesafe' | 'other'
  probabilityStatus?: string[]
}

// ─── Injected ports: time and network come from outside ───────────────────────

export interface HttpRequest { url: string; headers: Record<string, string>; body: string; timeoutMs: number }

// message of 'network': a system code (ECONNREFUSED) or a phrase of the adapter, never
// an error message as it is. The TLS one, for example, quotes the certificate's names,
// that is text chosen by the server, and it would end up in the output for Claude.
export type HttpOutcome =
  | { kind: 'response'; status: number; text: string; retryAfterMs?: number; ms: number }
  | { kind: 'timeout'; ms: number }
  | { kind: 'network'; beforeSend: boolean; message: string; ms: number }   // beforeSend: ECONNREFUSED, ENOTFOUND, EAI_AGAIN

export type Transport = (r: HttpRequest) => Promise<HttpOutcome>

export interface Clock { now(): number; sleep(ms: number): Promise<void> }

// ─── Configuration (config.ts) ────────────────────────────────────────────────

export type Op = 'gte' | 'gt' | 'lte' | 'lt'

// The value of a choice as a probability: 1 − p(option). With the option that says
// "no problem" first (none, letter A) it is the probability that there is a problem
// of any kind: indecision between two forms of the problem takes no signal away,
// because their p add up. In the JSON: "value": "1-p(none)".
export interface DerivedValue { kind: 'one_minus'; option: string }

export interface CheckDef {
  label: string
  type: QuestionType
  instructions?: Json
  criteria?: Json
  source: 'model' | 'computed'            // default 'model'
  scope: 'chunk' | 'global'               // default 'global'; 'chunk' only for model probabilities
  critical: boolean                       // only for model probabilities
  higher_is_better: boolean
  invert: boolean                         // only for model probabilities
  escalation_patterns: RegExp[]           // regexes on the path, case-insensitive
  requires: ('description')[]
  compute?: { all_files_match?: RegExp[]; any_file_matches?: RegExp[]; from_verdict?: string }
  // Only for a model choice. With value the choice is a probability, and for the rest
  // of the code it counts as a noul: rules, critical, band, calibration, maximum across
  // chunks, invert. Without it, the value of a choice is its confidence and the choice
  // itself is kept apart (primary_concern). "Model probability" = a noul, or a choice
  // with a value (isModelProbability in config.ts).
  value?: DerivedValue
  // A second reading of another question, with the same definition: the bench labels
  // it with that question's labels (bench/verify.ts, scripts/measure-questions.ts)
  // instead of asking for labels of its own. Not sent to the model.
  bench_labels?: string
}

// order = order of the keys in the file, which is also the printing order.
// fromProject: the file comes from .jev-hooks/ and applies in full. It is not
// trusted: instructions and criteria stay between the file and the backend, and only
// known names with fixed phrases go out to Claude (provenance.ts); its path regexes do
// not run in the core but outside, with a time limit (the matchProjectPaths port). A
// valid id is still text chosen by the repo (an order in snake_case fits RE_ID), so:
// - added: the project ids that no trusted layer knows. composeConfig replaces them
//   with a name written by the code, project_check_N (N = position in the file),
//   before the configuration reaches the core: the repo's id does not reach the
//   backend, the result, the cache or the output;
// - trustedOptions: for a choice, the criteria keys that a trusted layer defines for
//   the same id; the model's choice among the others goes out as "option N".
export interface Checks {
  order: string[]
  defs: Record<string, CheckDef>
  file: string
  fromProject?: boolean
  added?: string[]
  trustedOptions?: Record<string, string[]>
}

// action "escalation" (policy v2): besides taking the verdict to its lane, the rule
// sends the question to Claude, without an uncertainty band (the threshold is already
// chosen for few false alarms). Absent = the rule only decides the lane.
export type RuleAction = 'escalation'

export interface Condition { check: string; op: Op; value: number }

// unless: the rule does not fire when any of these conditions holds. policy.json may
// write one object or a list; the reader always gives a list of at least one.
// fromProject: .jev-hooks/policy.json added the rule, tightened it or restated it. It
// is a restriction, and a calibrated profile's threshold replaces its value only where
// it is stricter (calibration.ts, ruleThreshold).
export interface Rule {
  check: string
  op: Op
  value: number
  unless?: Condition[]
  action?: RuleAction
  fromProject?: boolean
}

export interface Lane {
  name: string
  exit_code: number
  color: string
  hook: 'deny' | 'ask' | 'warn' | 'none'
  ci: 'failure' | 'neutral' | 'success'
  rules: Rule[]
}

export interface Detector {
  name: string
  label: string
  check?: string
  where: ('added_lines' | 'title' | 'description' | 'paths')[]
  regex: RegExp                           // with the flags of the "flags" field (only i, m, s)
  min_entropy?: number
  ignore_values?: RegExp                  // same flags as the regex
  exclude_paths: RegExp[]                 // "test_paths" is already resolved into the regexes of policy.test_paths
  floor: string | null
  escalate: 'always' | 'if_model_disagrees' | 'never'
  // added by .jev-hooks/policy.json: its regex runs in the Worker with a time limit,
  // and its label does not go out to Claude (provenance.ts). Its name is the
  // file's only if a trusted layer knows it, otherwise project_detector_N (N = position
  // in the file's detectors list): a valid name is still text from the repo
  fromProject?: boolean
}

export type Origin = 'hook' | 'skill' | 'cli' | 'action'

// What the commit hook does with an escalation, from the most permissive to the
// strictest: context only puts it in Claude's context; deny_then_allow denies the first
// attempt with the prompt, and on the second attempt at the same diff lets the lane
// decide if the items all come from the model (threshold, band), otherwise asks the
// user; deny_then_ask always asks the user on the second attempt. The order matters to
// the project, which can only tighten.
export const HOOK_ESCALATION_MODES = ['context', 'deny_then_allow', 'deny_then_ask'] as const
export type HookEscalationMode = typeof HOOK_ESCALATION_MODES[number]
export type CiConclusion = 'failure' | 'neutral' | 'success'

export interface Policy {
  notes?: string[]                          // what the reader set aside, for the warnings (an unless on a check that is not defined)
  lanes: Lane[]
  band: { delta_logit: number }           // band around the threshold of every rule, in logit
  escalation: { hook: HookEscalationMode; ci: CiConclusion; max_files: number; ttl_min: number }
  ci: { backend_unavailable: CiConclusion; untrusted_input: CiConclusion }
  partial_coverage: { min_lane: string }
  state: {
    chars_per_token: number; tokens_per_state: number; max_line_chars: number; max_diff_bytes: number; max_description_chars: number
    ignore: RegExp[]; ignore_without_escalation: RegExp[]; sensitive_files: RegExp[]
  }
  test_paths: RegExp[]
  limits: Record<Origin, { max_chunks: number; total_ms: number }>      // total_ms counts from the start of the hook, git included
  network: {
    timeout_ms: number; connect_attempts: number; overload_attempts: number; backoff_ms: number; max_retry_after_ms: number
    overflow_resplits: number; parallel_rizzo: number; parallel_other: number
  }
  detectors: Detector[]
  hook: { enabled: boolean; on_error: 'warn' | 'ask'; cache_ttl_min: number }
  colors: { high: number; mid: number }
  file: string
}

export interface CalibrationEntry { sha256: string; a?: number; b?: number; t?: number; n?: number; errors?: number }

export interface Profile {
  name: string
  match: { fingerprint?: string; model_prefix?: string; host?: string }
  calibrated: boolean
  noul?: { a: number; b: number }
  choice?: { t: number }
  score?: { t: number }
  per_question?: Record<string, CalibrationEntry>
  thresholds?: Record<string, number>
  band_delta_logit?: number               // always applies (caution); thresholds only if calibrated
  note?: string
}

export interface Calibration { wide_delta_logit: number; profiles: Profile[]; file: string }

// Router. An effort step is either a step relative to the session's effort
// (an integer, 0 = unchanged) or an absolute level.
export type EffortStep = number | Effort

// Condition of adjust and floors: p_gte on the calibrated nouls, level_gte on the
// argmax level of the scores (which does not depend on the temperature). Exactly one
// of the two.
export interface RouterCondition { question: string; p_gte?: number; level_gte?: number }

// When the cache guard judges a step (router.ts, cacheGuard): only after an effort
// change, on a prefix of at least min_prefix_tokens, when this turn started at most
// max_gap_ms after the start of the turn that made the previous request. A cache read
// below max_read_ratio of that prefix is a suspect; trips suspects in a row turn the
// router off for the session.
export interface CacheGuard { min_prefix_tokens: number; max_read_ratio: number; max_gap_ms: number; trips: number }

export interface RouterConfig {
  enabled: boolean
  timeout_ms: number
  busy_after_timeout_ms: number
  prompt_max_chars: number
  prompt_head_chars: number
  skip_prefixes: string[]
  only_origins: string[]
  only_models: string[]
  min_effort: Effort
  max_effort: Effort
  respect_session_effort: boolean
  assume_session_effort: Effort | null
  min_top_probability: number
  cache_guard: CacheGuard | null         // null: no guard
  base: Record<string, EffortStep | 'previous'>          // keys = options of the task-kind question
  adjust: { if: RouterCondition; raise?: number; at_least?: Effort }[]   // exactly one of raise and at_least
  explicit_depth: { question: string; min_probability: number; map: Record<string, EffortStep | null> } | null
  floors: { if: RouterCondition; at_least: Effort }[]
  questions: Record<string, WireQuestion>
  taskQuestion: string                  // the choice whose options are the keys of base (derived, not written in the JSON)
  // max_effort of .jev-hooks/router.json: an extra cap that always applies. With
  // enabled: false, it is the only thing the router takes from the project (routerRestrictions)
  projectCap?: Effort
  calibration: Calibration
  file: string
}

// Configuration layers, read by the adapters and composed by the core.
// path only serves notes and sources ("~/.config/jev-hooks/policy.json").
export interface ConfigFile { path: string; text: string }

export interface ConfigLayers {
  plugin: { checks: ConfigFile; policy: ConfigFile; calibration: ConfigFile }
  user: { checks?: ConfigFile; policy?: ConfigFile; calibration?: ConfigFile }
  project: { checks?: ConfigFile; policy?: ConfigFile; calibration?: ConfigFile }
}

export interface ComposedConfig {
  checks: Checks
  policy: Policy
  calibration: Calibration
  sources: Record<string, string>          // checks | policy | calibration → description of the source
  warnings: string[]                        // ignored or invalid files, ignored project fields
  userProblems: Problem[]              // invalid user files: the CLI exits with 4, the hooks use the defaults
}

// ─── Backend (backend.ts) ─────────────────────────────────────────────────────

// A layer is a triple: a layer's key goes ONLY to the URLs of that layer.
export interface BackendLayer { name: string; url?: string; key?: string; model?: string }

export interface BackendSources {
  layers: BackendLayer[]               // in order: the first one with a URL wins, and the key is taken only from there
  explicitUrl?: string                   // CLI --url: it gets a layer's key only if that layer has the same origin
  typesafe?: { key?: string; baseUrl?: string; model?: string }   // TYPESAFE_*: the key applies only to the host of baseUrl or api.typesafe.ai
}

export interface ParsedUrl { scheme: 'http' | 'https'; host: string; port: number; path: string }

// ─── Request (systemone.ts) ───────────────────────────────────────────────────

export interface RequestBody { state: string; model: string; questions: Record<string, WireQuestion> }

// ─── Diff (diff.ts) ───────────────────────────────────────────────────────────

export interface AddedLine { number: number; text: string }

export interface FileDiff {
  path: string
  oldPath?: string
  status: 'A' | 'M' | 'D' | 'R' | 'B'
  header: string
  hunks: { header: string; lines: string[]; newStart: number }[]
  added: number
  removed: number
  addedLines: AddedLine[]
}

export interface ParsedDiff { files: FileDiff[]; truncated: boolean; bytes: number }

// ─── Detectors (detectors.ts) ────────────────────────────────────────────────

export interface Hit {
  detector: string
  label: string
  check?: string
  file?: string
  line?: number
  where: 'added_lines' | 'title' | 'description' | 'paths'
}

export interface DetectorResult { hits: Hit[]; floors: { lane: string; by: string[] }[]; injection: boolean }

// ─── Redaction and masking (redaction.ts, mask.ts) ────────────────────────

export interface MaskPair { real: string; placeholder: string }

// ─── Chunks (chunks.ts) ────────────────────────────────────────────────────────

export interface Chunk { index: number; files: string[]; text: string; tokens: number }

export interface Plan {
  shape: 'single' | 'chunks'                // 'single' = one chunk only; chunk questions ALWAYS get chunkState
  chunks: Chunk[]
  global: string
  examined: string[]
  ignored: string[]
  unreviewable: string[]                // ignored outside ignore_without_escalation (binaries, .min.js, dist/…)
  omitted: { path: string; reason: string }[]
}

// ─── Calibration (calibration.ts) ────────────────────────────────────────────

export type CalibrationMode = 'client' | 'server'   // server: probability_status is EXACTLY ["temperature_scaled_requires_held_out_validation"]

// How a question's thresholds follow its calibrated values (calibration.ts,
// thresholdScales): the entry the values used, the polarity of the sent question, and
// whether the value is a choice's derived probability.
export interface ThresholdScale { item?: CalibrationEntry; invert: boolean; derived: boolean }

export interface ProfileSelection {
  profile: Profile
  mode: CalibrationMode
  deltaLogit: number
  notes: string[]
  scales?: Readonly<Record<string, ThresholdScale>>
}

// ─── Verdict and escalation (verdict.ts, escalation.ts) ──────────────────────

export interface ChunkValue { chunk: number; files: string[]; p: number; raw: number }

export interface CheckValue {
  value: number
  raw?: number
  source: 'model' | 'computed'
  worst?: string[]
  perChunk?: ChunkValue[]
  level?: string
  choice?: string
  confidence?: number
  // Choice with a value: the most likely option among those the value adds up (all but
  // the subtracted one), in the worst chunk. It is a detail for the reader: the verdict
  // only uses value.
  option?: string
}

export interface FiredRule {
  lane: string
  check: string
  value: number
  op: Op
  threshold: number
  source: 'policy' | 'profile' | 'floor' | 'coverage'
  action?: RuleAction                   // the rule also sends the question to Claude
}

// threshold: a rule with action "escalation" fired. band: a p near the threshold of a
// rule without an action on a critical check. One item per question, not per chunk:
// p is the one of the worst chunk among those named, files are theirs.
export interface EscalationItem {
  check?: string
  reason: 'threshold' | 'band' | 'disagreement' | 'detector' | 'coverage'
  // the detector's name, for items with reason detector: already through composeConfig
  // (a project name that no trusted layer knows arrives as project_detector_N). The log
  // and the hook's key need it: otherwise two detectors without a check cannot be told
  // apart
  detector?: string
  p?: number
  threshold?: number
  band?: [number, number]
  question: string
  files: string[]
  // line ranges (new numbering) of the hunks of the files named, for the escalation
  // prompt; the keys are the already filtered paths, as in files
  lines?: Record<string, [number, number][]>
}

// ─── Review (review.ts) ────────────────────────────────────────────────────

export interface ReviewInput { diff: string; title: string; description: string | null; origin: Origin }

export interface ReviewConfig {
  checks: Checks
  policy: Policy
  calibration: Calibration
  maskMap: MaskPair[] | null
  sources: Record<string, string>
  // The guardrail mask map exists but cannot be read (parseMaskMap failed): nothing goes
  // to a non-local backend, and the core must know it to say so.
  maskMapError?: Failure
}

// Ports and parameters of review(). backend is a Failure when resolveBackend failed
// (empty URL, http towards a public host, TypeSafe without a key): no request, but the
// detectors' floors still apply and the core computes the CI class.
export interface RegexSource { source: string; flags: string }

export interface ReviewDeps {
  transport: Transport
  clock: Clock
  backend: Backend | Failure
  seed: number                            // PRNG of the redaction, usually from the clock
  start?: number                         // start of the entry point (hook: git included); default: the start of review()
  // Detectors added by the project (fromProject): their regexes run outside the core,
  // in a Worker with a time limit. It gets a policy with only those detectors;
  // null means timed out. Without the port they do not run and count as timed out.
  runProjectDetectors?: (p: Policy, d: ParsedDiff, meta: { title: string; description: string | null }) => Promise<DetectorResult | null>
  // The path regexes of a project checks.json (escalation_patterns, all_files_match,
  // any_file_matches),
  // outside the core for the same reason: for every regex, the indexes of the paths it
  // matches; null means timed out. Without the port they do not run: no match and
  // partial coverage.
  matchProjectPaths?: (regex: RegexSource[], paths: string[]) => Promise<number[][] | null>
  // Only for the commit hook: if the detectors already set the most
  // severe lane, no requests. The floor is not lost when the network is slow, and the
  // model could not lower it anyway.
  skipIfTopFloor?: boolean
  // The backend's identity as it declared it (model, fingerprint), for the log line:
  // it is the material of a calibration fit with match.fingerprint. In the
  // result, which goes out to Claude, those names appear only if the trusted
  // configuration knows them, otherwise as a hash (provenance.ts).
  onIdentity?: (id: Identity) => void
}

export interface ReviewResult {
  outcome: 'ok' | 'incomplete' | 'error' | 'empty'
  lane?: string
  exit_code: number
  fired: FiredRule[]
  unevaluated: string[]
  values: Record<string, CheckValue>
  escalation: EscalationItem[]
  merge_ready: boolean
  hits: Hit[]
  files: { examined: string[]; ignored: string[]; unreviewable: string[]; omitted: { path: string; reason: string }[] }
  ci: { conclusion: CiConclusion; class?: 'backend_unavailable' | 'untrusted_input'; reason?: string }   // computed by the core, used by the Action
  // delta_logit: the band's δ used by the escalation (profile, server or policy). The
  // output prints it ("no escalation … δ = 0.62"), and render.ts does not have the
  // profile. model and fingerprint are the ones declared by the backend only if the
  // trusted configuration knows them (the requested model, a match.fingerprint),
  // otherwise "sha256:<12 digits>": the backend is not a trusted layer (provenance.ts).
  backend: { host: string; model?: string; fingerprint?: string; profile?: string; calibrated: boolean; mode?: CalibrationMode; delta_logit?: number; notes: string[] }
  requests: number
  ms: number
  input_tokens: number
  shape: 'single' | 'chunks'
  redactions: number
  config_sources: Record<string, string>
  config_hashes: Record<string, string>
  error?: Failure
  notes?: string[]                         // notes of the verdict and of the review (unless without a value, re-splits, discarded answers)
}

// ─── Commit (commit.ts) ───────────────────────────────────────────────────────

// A `git add` before the commit in the same command, with the options that change what
// goes into the index: -A, -u, -f, -N. The hook repeats it on a copy of the index.
export interface AddStep { paths: string[]; all: boolean; update: boolean; force: boolean; intentToAdd?: true }

export interface CommitIntent {
  dir?: string                       // from "git -C dir" or from a leading "cd dir &&"
  all: boolean
  amend: boolean
  allowEmpty: boolean
  paths: string[]
  // "git add … &&" in the same command: paths and all are the union of the steps,
  // steps the exact sequence to repeat on the temporary index
  adds: { paths: string[]; all: boolean; steps?: AddStep[] } | null
  message?: string                      // -m (also repeated, heredoc $(cat <<'EOF' …))
  messageFile?: string                  // -F
}

// ─── Router (router.ts) ───────────────────────────────────────────────────────

// A prompt's answers, calibrated, by question type. A score keeps its argmax level
// and not the calibrated Σ k·p'_k, which moves with the temperature: level_gte
// compares levels. missing lists what was asked and not answered, so that a rule on
// a missing answer is not silently skipped (chooseEffort).
export interface Classification {
  taskQuestion: string                     // id of the task-kind question (RouterConfig.taskQuestion)
  taskKind: string                         // argmax option of the task-kind question
  pTask: number                            // its calibrated probability
  p: Record<string, number>                // calibrated P(yes) per noul id
  levels: Record<string, number>           // argmax level per score id (ties → the higher level)
  choices: Record<string, { option: string; p: number }>   // argmax option and its calibrated p, per choice id
  missing: string[]                        // asked but not answered (discarded or absent), sorted
  profile: string                          // calibration profile name
  calibrated: boolean                      // profile.calibrated, client-side mode, and a router question with a fit of its own
}

export interface RouterBackend extends Backend {}

// turn.step's effort: a level, or a number that is an internal token budget. A hook
// may pass a number through but never set one (the engine skips the hook).
export type SessionEffort = Effort | number

// previous: the effort the router gave the last turn, for base "previous".
export interface RouterContext { model: string; effort?: SessionEffort; previous?: Effort }

// effort only when it differs from the session's: absent means leave the turn alone.
export interface EffortChoice { effort?: Effort; reason: string }

// problem: a skip the user must hear about (the guardrail mask map), not one that is
// part of the design (an origin, a prefix, an empty prompt).
export type RouterRequest =
  | { skip: string; problem?: true }
  | { url: string; init: { method: 'POST'; headers: Record<string, string>; body: string }; redactions: number }

// Cache guard (router.ts, cacheGuard): the usage of a main-loop step as the API
// reported it, the step, and the guard's state across the session.
export interface StepUsage { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
export interface GuardStep { effort?: SessionEffort; usage: StepUsage | null; messageCount: number; model: string }
export interface GuardState { last: GuardStep | null; suspects: number; tripped: boolean }

// ─── Node adapters (src/node) ─────────────────────────────────────────────────

export type DiffSource =
  | { kind: 'commit'; intent: CommitIntent }
  | { kind: 'staged' }
  | { kind: 'working' }
  | { kind: 'ref'; ref: string }
  | { kind: 'file'; path: string }
  | { kind: 'text'; diff: string; title: string; description: string | null }

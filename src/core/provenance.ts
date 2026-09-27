// Where a text comes from, and whether it may reach Claude.
//
// The user layer (~/.config/jev-hooks) and the plugin defaults are trusted: Claude
// does not write to ~/.config from the sandbox. Two sources are not trusted: the
// project layer (.jev-hooks/ is written by a cloned repo, and a .jev-hooks/ that is
// already committed equals HEAD, so the "HEAD plus ask" rule does not fire) and the
// backend (a wrong or compromised one answers whatever it likes, errors included).
// Any of their text written as an order for Claude would end up in a deny reason, in
// additionalContext or in the CLI output, all of which Claude reads.
//
// The rule: text that goes to Claude comes only from the code and from the trusted
// layers. What leaves an untrusted layer is numbers, names that a trusted layer has
// already written (a plugin check id, the requested model) and references written by
// the code: a position (project_check_3, option 2, level 1) or a hash (sha256:…). A
// name having the shape of an id is not enough: an order for Claude written in
// snake_case has that shape too.
// The project's text stays between the file and the backend, where it is needed
// (questions, criteria).
//
// Pure (rule 4): no I/O.
import { RE_ID } from './json.ts'
import { sha256Hex } from './sha256.ts'
import type { Calibration, CheckDef, Checks, Identity, Detector } from './types.ts'

export const NOT_SHOWN = 'defined by the project: text not shown'

// An id arrives already validated (and, if it comes from the project, replaced) by
// config.ts; the check here keeps the fixed phrase even for an object built elsewhere.
function safeId(s: string): string {
  return RE_ID.test(s) ? s : '?'
}

// How a check is named in a sentence for Claude: its label if the file is trusted,
// otherwise the id with the fixed phrase.
export function checkLabel(name: string, def: Pick<CheckDef, 'label'>, checks: Pick<Checks, 'fromProject'>): string {
  return checks.fromProject ? `check «${safeId(name)}» (${NOT_SHOWN})` : def.label
}

export function detectorLabel(d: Pick<Detector, 'name' | 'label' | 'fromProject'>): string {
  return d.fromProject ? `detector «${safeId(d.name)}» (${NOT_SHOWN})` : d.label
}

// True if the id is a name written by the code in place of the project's one
// (project_check_N, config.ts): it says nothing about the problem, and the question
// for Claude cannot refer to its meaning.
export function isAdded(name: string, checks: Pick<Checks, 'added'>): boolean {
  return checks.added?.includes(name) ?? false
}

// The chosen option of a project choice: the keys of criteria are written by the file.
// The option stays if a trusted layer defines it for the same check (trusted),
// otherwise its position (1 = the first one in criteria).
export function safeChoice(selection: string, options: readonly string[], trusted: readonly string[]): string {
  if (trusted.includes(selection)) return selection
  const k = options.indexOf(selection)
  return k < 0 ? `option (${NOT_SHOWN})` : `option ${k + 1}`
}

// The level of a project score: the levels are texts from the file (and the backend's
// legend repeats them), so only the number is given, counting from the lowest (0).
export function safeLevel(score: number): string {
  return `level ${Number.isFinite(score) ? Math.round(score) : '?'}`
}

// A hash that tells a text apart without showing it: the first 12 characters of the
// sha256, which the user can recompute on the value in the log.
export function shortHash(s: string): string {
  return `sha256:${sha256Hex(s).slice(0, 12)}`
}

// A name the backend gives itself (model, fingerprint, a model from /v1/models, a
// probability_status): text it chose, like a project label. It goes out as it is only
// if the trusted configuration already knows it (known: the requested model, a
// match.fingerprint in calibration.json); otherwise its hash.
export function backendName(s: string, known: readonly string[]): string {
  return known.includes(s) ? s : shortHash(s)
}

// Who answered, as shown: the model is known if it is the requested one (userConfig,
// JEV_HOOKS_MODEL, --model), the fingerprint if a profile in calibration.json names
// it. The real names are needed by the log and by the profile choice, which read them
// from Identity.
export function shownIdentity(
  who: Pick<Identity, 'model' | 'fingerprint'>, requested: string, cal: Pick<Calibration, 'profiles'>,
): { model: string; fingerprint?: string } {
  const out: { model: string; fingerprint?: string } = { model: backendName(who.model, [requested]) }
  if (who.fingerprint !== undefined) {
    const known = cal.profiles.flatMap((pr) => (pr.match.fingerprint !== undefined ? [pr.match.fingerprint] : []))
    out.fingerprint = backendName(who.fingerprint, known)
  }
  return out
}

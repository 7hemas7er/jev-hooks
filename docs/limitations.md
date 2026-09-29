# Limitations

- **A 4B model.** Spark-X2.5-4B answers with a single letter and no reasoning, reads
  literally, handles negations poorly, and scores 0.50 on rizzo-flow's own
  rule-application test. The questions are written around that, and it still misses
  things a human reviewer would not.
- **A small, synthetic, single-author bench.** 239 diffs in total, with 7 to 16
  positives per question (`adds_tests` aside), written and labelled by one person.
  Labels were not double-annotated, and the holdout set was written by the same author
  who wrote the dev set. The AUROCs [above](evaluation.md#the-measured-bench) can move by several points on real code.
- **No calibration fit yet.** `calibrated` is `false` in every profile: thresholds sit on
  raw probabilities of one backend identity. Another quantization or llama.cpp build
  changes the fingerprint and falls back to a provisional profile; Jev has not been
  measured on the bench at all.
- **Injection resistance is partial.** Floors catch what a regex can see. A well-crafted
  injection can still lower a probability below a threshold.
- **A safety net, not a barrier.** Commits made outside Claude's Bash tool, through
  scripts or aliases, are not reviewed, and some `git add && git commit` combinations
  get an approximate diff.
- **Latency.** rizzo serializes requests: a large diff split into many chunks, or a
  second client on the same instance, makes you wait. The router is such a client when
  it shares the reviewer's instance: a review in progress makes it time out and leave
  the effort alone, and its own request can hold a review back by a fraction of a
  second.
- **The router rests on early-access APIs.** Function hooks can change between Claude
  Code releases without notice; the router was written and tested against 2.1.283, in
  Claude Code's own test kit and on a fake engine under Node.
- **One live run so far** (2026-09-28, Claude Code 2.1.283, headless `claude -p` on Opus
  5.5 with the session at `high`, a copy of the plugin that also classifies the `sdk`
  origin, rizzo through Tailscale). A logging proxy in front of the API showed
  `output_config.effort` at `low` on both requests of a routed turn, and at `high`
  with `JEV_HOOKS_ROUTER=0`. After a turn at `low`, the next turn at `high` read
  90,727 tokens from the prompt cache, the whole previous request, with the
  per-turn-control beta on. The module loaded next to the command hooks, `e.effort`
  was there with the session's setting, the `claude-opus-5-5` id matched
  `only_models`, and `turn.start` carried the prompt's text. The classification took
  about 0.7 s through Tailscale; the first request of the session took longer than
  `timeout_ms` and left that turn as it was. `CLAUDE_EFFORT` in a Bash command shows
  the session's effort, not the one the router sets for a request. Later sessions
  checked the `claude-fable-5-1` id and a prompt typed in the interactive composer.
  On 2.1.284 (2026-09-29), Sonnet 5.5 in two arms of two headless turns each, without
  MCP servers, against a fake backend: with the router the first request carried
  effort `low` and the second `high`, each as a `role: "system"` message in the
  conversation under the per-turn-control beta, and `system/init` reported
  `per_turn_effort_active: true`; without it both stayed at `high`. The second turn
  read the same 27,547 cached tokens in both arms, so the change of effort cost
  nothing in cache. Neither arm read the whole previous request back: a new
  `claude -p --continue` process does not rebuild the prefix byte for byte.
  On 2.1.284 a copy with a broken module (`on('turn.stepX', …)`) was refused at load
  ("hooks module … failed to load" in the debug log) while the commit hook of the same
  plugin still fired and denied a commit. Esc pressed while the router waited for a
  slow backend (a staged copy with `timeout_ms` raised to 8 s, the backend answering
  in 6 s) ended the wait at once: `prompt.submit` settled 30 ms after the cancel, the
  classification's request never completed, the composer got the prompt back, and the
  next prompt was classified and routed as usual, with no rest period. A sensitive
  option set in `/plugin` reaches the module too: with `router_api_key` saved as a
  wrong value (kept out of `settings.json`, in Claude Code's secure storage) the next
  prompt got `router: key rejected by the backend (HTTP 401)`, although the key file
  held the right key. The dialog cannot empty a sensitive value once saved (an empty
  field means "unchanged", on 2.1.284): to change `router_api_key`, type the new one.
- **The beta is invisible.** The plugin cannot tell whether the per-turn-control beta
  is active. The cache guard notices a cleared cache only after the fact: two turns
  that each paid for the whole context again.
- **The router's thresholds are not fitted.** Its questions are measured on 240
  labelled prompts, but the thresholds were set by hand, and `underspecified` does not
  separate ([Measured, not fitted](router.md#measured-not-fitted)).
- **Platforms.** Developed on Linux; CI runs Node 22.18 and 24 on Ubuntu. Windows is
  untested (the hook launcher is a bash script; the router needs no bash, but it has
  not been tested there either).

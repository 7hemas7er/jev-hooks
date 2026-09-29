# GitHub Action

The Action reviews pull requests in two phases, so that a pull request from a fork
never runs next to your secrets. Copy the two files of
[`examples/workflows/`](../examples/workflows/) into `.github/workflows/`:

- **`jev-review-collect.yml`**, on `pull_request`, with no secret and no code of the
  pull request run: it uploads the PR number, the two SHAs and the diff as an artifact.
  On a fork its author can rewrite this workflow, so its output is treated as hostile.
- **`jev-review.yml`**, on `workflow_run`, from your default branch, with the secrets.
  It takes the head sha, branch and repository from the event (trusted), finds the one
  open pull request they match, reviews the diff GitHub's API gives for the two SHAs
  (the artifact is only a cross-check) and always publishes a completed `jev-review`
  check run, with the verdict, the values and the escalation prompt ready for a review
  with Claude. The rules come from `.jev-hooks/` on the default branch.

Set the variable `JEV_URL` (and optionally `JEV_MODEL`) and, if the backend needs one,
the secret `JEV_API_KEY`. A backend on your tailnet takes an ephemeral node:
`JEV_TAILSCALE=true`, `JEV_TAILSCALE_PING` (the backend's tailnet name, waited for
before the review) and the `TS_OAUTH_*` secrets, with an ACL that reaches only the
backend's port ([docs/spark.md](spark.md#6-from-github-actions)). Pin the action to the SHA of a release you have read.

| Outcome | Check conclusion (default) |
|---|---|
| BLOCK | `failure` |
| SECURITY REVIEW, or an escalation | `neutral`: visible, does not block the merge |
| NITS, MERGE | `success` |
| Backend down, unreachable or not configured | `neutral` (`ci.backend_unavailable`) |
| Anything the PR author controls or can break: first phase failed, artifact missing or foreign, pull request not identifiable, diff too large, partial coverage, an internal error | `failure` (`ci.untrusted_input`) |

To stop merges on a SECURITY REVIEW, put `{"lanes": [{"name": "SECURITY REVIEW", "ci":
"failure"}]}` in `.jev-hooks/policy.json` and make the check required. A required check
has a catch: created with `GITHUB_TOKEN`, it belongs to the GitHub Actions app, and a
fork can add a workflow with a job named `jev-review` that succeeds on the same head
sha. Create the check run with a dedicated GitHub App instead (`checks-token`, from
`actions/create-github-app-token`) and set that app as the check's expected source in
branch protection.

Nothing runs an agent on a fork's code: the escalation stays text in the check run, for
a maintainer to hand to Claude. `mode: file` reviews a diff file with no GitHub API;
this repository's CI uses it as a smoke test.

The two workflows, copied unchanged with the action pinned by SHA, ran on real pull
requests in a private test repository with no `JEV_URL`. A plain pull request got its
`jev-review` check run on the head commit, completed as `neutral` ("backend not
configured"). A pull request that rewrote the first phase to forge its artifact (the
base sha as head, an empty diff) got `failure` (`untrusted_input`: "first-phase
artifact of another pull request or head sha"), on the real head commit. With a fake
backend started on the runner (`JEV_URL` on 127.0.0.1, `JEV_API_KEY` from a secret
that the fake requires), the 0.5.0 action gave `success` with NITS to a pull request
that left a trace call, and `neutral` with a `hardcoded_secret` escalation to one that
added a token variable. Then a dedicated GitHub App (Checks: read and write, no
webhook) created the check run, required from that app in branch protection with
admins included: a plain pull request got `jev-review` from the app and became
mergeable, and a pull request that forged the first phase and added its own job named
`jev-review`, which succeeded, stayed blocked, and a merge attempt was refused. Last,
the review reached rizzo on the Spark through an ephemeral `tag:ci` node, allowed by the
tailnet policy to reach only the proxy's port: the 0.6.0 action reviewed a real pull
request in 3.0 s (two requests, the Spark's calibration profile matched by fingerprint)
and the app's check came back `success` with NITS. The first attempt, without the
`ping` input, failed to resolve the Spark's name. From a fork in another owner's
namespace (an organization), the second phase found the cross-repository pull request,
rizzo reviewed its diff, and the detector `ci_workflow` escalated the fork's added
workflow (`neutral`); after the fork forged the first phase, the app's check turned
`failure` and the merge stayed blocked beside a succeeding job named `jev-review`.
Not run: a first-time contributor whose workflows wait for approval.

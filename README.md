# Command Code GitHub Agent

Mention `@commandcode-agent` in an issue, pull request or review comment and the agent works on it inside your own repository's GitHub Actions. It implements the change, verifies it, reviews its own work and opens a pull request. The code stays on your runners: the action wraps the [Command Code](https://commandcode.ai/docs) CLI in a composite action.

## How it works

A run follows the same pipeline every time:

```
trigger  ->  permission gate  ->  branch  ->  implementer agent  ->  verification command
   ->  repair attempts (when that verification fails)  ->  reviewer agent
   ->  verification command (re-run)  ->  commit / push  ->  pull request  ->  report comment
```

1. Trigger: an `@commandcode-agent` comment (on an issue, a pull request or a pull request review), an issue assigned to the app, an issue carrying the configured `label`, or a manual `workflow_dispatch`. Opening an issue does not start a run. Images pasted into the triggering comment are downloaded and handed to the agent: only image responses within the size cap are kept, and a non-image or oversized response is skipped with a log line. The triggering comment gets a 👀 reaction while the run is in progress, replaced with 🚀 on success or 👎 on failure.
2. Permission gate: the actor must have `write` or `admin` access to the repository. Anyone else gets an explanatory comment and the run stops. Events authored by a bot are ignored.
3. Branch: for an issue the agent creates `commandcode/issue-<n>-<timestamp>` from the default branch. For a pull request it checks out the PR head branch and pushes back to it.
4. Implementer agent: `cmdc` runs headless (`-p ... --yolo --output-format json --max-turns ...`) with the task, the sanitized issue/PR context and a set of rules. It edits the working tree. The write token is removed from the local git config before this point.
5. Verification command: the `verify-command` runs in the workspace with a restricted environment (no GitHub, Actions or provider tokens, the same allowlist the agent gets) and its output is kept for the reviewer.
6. Repair: when that verification fails, the failing output is handed back to the implementer for up to `repair-attempts` bounded attempts (default one, zero disables). Each attempt resumes the implementer's own session by id when the previous result carried a usable one, or starts a fresh session with the failure in the prompt otherwise. The verification re-runs after every attempt and the loop stops as soon as it passes; an attempt that leaves the working tree unchanged stops the loop instead of retrying. This step runs only when the reviewer is enabled.
7. Reviewer agent: a second `cmdc` session with no shared context audits the actual diff (truncated with a visible marker when very large) and the verification output, fixes gaps and writes a review summary.
8. Re-verification: because the reviewer may have changed the tree, the `verify-command` runs again after the reviewer pass. The pull request body reports this final result and states which run it describes.
9. Commit and push: the harness commits the working tree as `commandcode-agent[bot]` and pushes. Before staging it compares the tree with the one the implementer left and reports any files that appeared during verification or review (build output, caches, coverage) in the log and the report, so they are not committed silently. Auth is configured for the push and removed immediately after. If the push is rejected, the harness writes the commit as a patch to a workflow artifact and the failure comment says where to find it, so the work survives the run.
10. Pull request: for issues it opens a PR; for pull requests it updates the branch. The body has the task, the change summary, the verification result and the review, and says how many repair attempts ran.
11. Report comment: a final comment links the branch, the PR, the model, the agent sessions, the duration and the workflow run.

If the mention asks a question or requests an explanation rather than a change, the agent replies in the thread and opens no pull request; the recent comments are part of its context, so you can keep the conversation going by mentioning it again. With a read-only token configured, it also checks whether the question was already asked or answered in another issue or pull request and points you there.

## When a push fails

A rejected push can happen for reasons that have nothing to do with the change: a missing app permission, a protected branch, a fork without "Allow edits by maintainers", a transient network failure, or a pre-receive hook. Without a rescue that rejection would discard the agent's commit together with the runner.

When the push fails, the harness captures the commit as a patch relative to the branch point (new files included, `--binary` for binary changes), bounded with a visible truncation marker when it is very large. The composite action uploads it as the `commandcode-rescue` artifact, and the failure comment links to the artifact instead of only reporting why the push failed. The artifact holds `changes.patch`, an mbox you re-apply with `git am`, and a `README.md` naming the branch point and the exact commands to recover the work.

The upload lives inside the action, so there is no extra workflow step to add. A push that succeeds is unaffected: no artifact directory is created and the upload step is skipped.

## Quick start

1. Copy [`.github/workflows/commandcode.yml`](.github/workflows/commandcode.yml) into your repository, or adapt its `on:`/`uses:` block to point at this action.
2. Create a Command Code API key (https://commandcode.ai/settings/keys), store it as a secret (e.g. `AGENT_API_KEY`) and pass it as `command-code-api-key` in the `with:` block, together with a `model` id from your plan. BYOK is the alternative, see [Auth](#auth).
3. Comment `@commandcode-agent fix the flaky login test`, or assign the issue to the app.

The action sets up Node.js 22 itself before installing the CLI, so you do not need a Node step of your own.

The workflow must declare write permissions for the agent to push and comment:

```yaml
permissions:
  contents: write
  pull-requests: write
  issues: write
```

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `mentions` | `@commandcode-agent` | Comma-separated trigger strings; a comment containing one of them at a word boundary starts the agent. |
| `label` | none | Issue label that starts a run on an `issues: labeled` event. Left empty, labeled events never start a run. |
| `bot-login` | resolved from the token | Login of the bot this action runs as, matched against the assignee of an `issues: assigned` event (e.g. `commandcode-agent[bot]`). Left empty, the login is resolved from the token through the GraphQL `viewer`; if it cannot be resolved, issue assignments are ignored. |
| `model` | none | Model identifier passed to the Command Code CLI (`-m`). Required when `provider-api-key` is set. |
| `subagent-model` | none | Model pinned for subagents the agent delegates to, not the session model. Ignored when the model is not available to the account, in which case subagents inherit the session model. |
| `max-turns` | `100` | Maximum number of agent turns per agent run (implementer and reviewer). |
| `agent-timeout-minutes` | `40` | Wall-clock limit for each agent process, in minutes. On expiry the process is killed and the timeout is reported through the normal failure path. Keep it below the job's `timeout-minutes` so the run can still post its report. |
| `verify-command` | none | Command run to verify the change (e.g. `npm ci && npm test`); runs after the implementer agent, again after each repair attempt, and once more after the reviewer pass. |
| `review` | `true` | Run the reviewer agent pass after verification (`true`/`false`). |
| `repair-attempts` | `1` | Bounded repair attempts when the verification fails after the implementer pass. The failing output goes back to the implementer, which resumes its own session when a usable session id is available, and verification re-runs after each attempt. `0` disables repair; ignored when `review` is false. |
| `command-code-api-key` | none | Command Code API key (https://commandcode.ai/settings/keys), exported to the CLI as `COMMAND_CODE_API_KEY`. The recommended CI path; it takes precedence over the BYOK provider inputs. The same key works for the Provider API. |
| `provider` | none | BYOK provider id written to `~/.commandcode/providers.json` (e.g. `openrouter`). |
| `provider-base-url` | none | Base URL for the BYOK provider (e.g. `https://openrouter.ai/api/v1`). |
| `provider-api-key` | none | API key for the BYOK provider; provide it through a secret. |
| `github-token` | `${{ github.token }}` | Token used for the GitHub API and git push; defaults to the workflow token. |
| `agent-token` | none | Optional read-only token exposed to the agent as `GH_TOKEN` so it can read other issues and pull requests with the `gh` CLI. Generate it with `actions/create-github-app-token` restricted to read permissions. |

## Usage

```yaml
name: commandcode
on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  issues:
    types: [assigned]

permissions:
  contents: write
  pull-requests: write
  issues: write

# One run at a time per repository. Keep the same `group` in every workflow that
# calls this action: concurrency groups are repository-wide, so a different or
# missing group lets the runs race again.
concurrency:
  group: commandcode-${{ github.repository }}
  cancel-in-progress: false
  queue: max

jobs:
  commandcode:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          # Required. By default actions/checkout persists the write token as an
          # http.extraheader credential in the local .git/config. The agent runs
          # with --yolo, so a prompt injection could read and exfiltrate it. With
          # this false, the action configures its own auth header only around the
          # push and removes it before any agent session runs.
          persist-credentials: false

      - uses: <owner>/commandcode-github-agent@main
        with:
          verify-command: "npm ci && npm test && npm run typecheck"
          command-code-api-key: ${{ secrets.AGENT_API_KEY }}
          model: <model-id>
```

For the BYOK alternative, replace `command-code-api-key` with `provider`, `provider-base-url` and `provider-api-key` (see [Auth](#auth)).

### Triggers

Subscribe only to the events you want, because the handler matches them strictly:

- `issue_comment` and `pull_request_review_comment` (`types: [created]`) for mentions.
- `issues` with `types: [assigned]` to start on an assignment. The run fires only when the assignee is the account the action authenticates as, resolved from the token or from the `bot-login` input, so assigning another bot does nothing.
- `issues` with `types: [labeled]` to start on a label. Set the `label` input to the label that should trigger; with no `label` set, labeled events are ignored.
- `workflow_dispatch` with a `prompt` input for manual runs.

Opening an issue never starts a run, so there is no need to subscribe to `types: [opened]`.

### Concurrency

Keep the `concurrency` block. Every run rebuilds `dist/index.js`, the committed bundle the action executes, so two runs started from different issues both change that file and their pull requests conflict by the time they meet.

Keying the group on `github.repository` serializes runs across the whole repository. `cancel-in-progress: false` keeps a queued run from being cancelled mid-flight, after it may already have spent tokens and pushed a branch, and `queue: max` raises the pending queue from GitHub's default of a single run to 100. Without `queue: max`, a burst of mentions leaves only the most recent run pending and cancels the rest, which is the opposite of queueing.

Two things worth knowing about the group. It is repository-wide rather than per workflow, so if you call this action from more than one workflow, give each one the identical `group` value; with a different or missing group the runs stop queueing and the conflicts come back. And `queue: max` has a ceiling of its own: once 100 runs are pending, GitHub cancels any further ones.

This serializes the repository on purpose, and it costs throughput. With several maintainers triggering the agent, each run waits for the one before it. If you would rather accept conflicts than wait, key the group per issue instead, for example `commandcode-${{ github.event.issue.number || github.run_id }}`.

## Auth

The action installs the CLI with `npm install -g command-code@<pinned>` (binary `cmdc`). The CLI requires Node.js 22, which the action sets up for you.

### Command Code API key (recommended for CI)

Create a key at https://commandcode.ai/settings/keys, store it as a secret and pass it as `command-code-api-key`. The action exports it as `COMMAND_CODE_API_KEY`, which the CLI reads at startup, so you do not need an interactive login or a `providers.json` file. The same key also authorizes the Provider API.

```yaml
with:
  command-code-api-key: ${{ secrets.COMMAND_CODE_API_KEY }}
  model: <model-id>
```

This path takes precedence over the BYOK inputs below.

### BYOK provider (alternative)

When `provider-api-key` is set, the action writes `~/.commandcode/providers.json` with a `$VAR` reference, so the key itself never lands in the file. The CLI receives it through `CMD_AGENT_PROVIDER_KEY`, alongside `CMD_LOCAL_ONLY=1` to keep the CLI from contacting Command Code's own services. The file uses the CLI's `{ "provider": { "<id>": ... } }` shape; a legacy `providers` key is migrated on write. With no key, the file is left untouched and the CLI keeps its existing configuration.

### Subagent model (optional)

By default the subagents the agent delegates to run on the session model. To pin a separate model for them, set `subagent-model` to any id the CLI accepts, or commit a repository default in `.commandcode/subagent-model` (a plain text file holding one model id, `#` comments allowed). The action input wins over the repository file.

Before the agents run, the action asks the CLI for the models available to the account (`cmdc --list-models`, which also reports BYOK provider models) and checks the configured value against that list. When the model is available it writes a small agent file under `.commandcode/agents/` with the `model` field set; the file is removed again at the end of the run. When the model is missing, the action logs a warning, notes it in the final report, and continues with subagents on the session model, so a stale or mistyped id never fails a run. This is independent of `model`, which sets the session model.

## Security

- Collaborators-only gate: only actors with `write` or `admin` on the repository can trigger a run. The permission is looked up through the GitHub API.
- Bot loop guard: events whose actor ends in `[bot]` are ignored, so the agent cannot trigger itself in a loop.
- Assignment gate: an `issues: assigned` event only starts a run when the assignee is the account the action authenticates as, resolved through the GraphQL `viewer` or set with `bot-login`, so assigning Dependabot, Renovate or another bot cannot start one.
- Label gate: `issues: labeled` only starts a run when the added label matches the configured `label`; no label configured means the event is ignored.
- Prompt-injection sanitization: issue and PR text is stripped of HTML comments, zero-width and bidi control characters before it reaches a prompt, and the remaining context is marked as information only.
- Scoped token: the action uses the `github-token` you pass, which defaults to the workflow token limited to the job's `permissions`. With the optional GitHub App setup (`app/`, `actions/create-github-app-token`), the agent acts as a bot with a short-lived installation token. The write token never enters the agent's environment; if you pass `agent-token`, that separate token is read-only.
- Git config: the write token is removed from the local `.git/config` before any agent session runs, and re-added only for the push, as described above. Set `persist-credentials: false` on `actions/checkout` so the token is not persisted there in the first place.
- Restricted verification: the `verify-command` runs with the same least-privilege environment as the agent, so the project's test and build commands (code the agent just wrote) cannot read `GITHUB_TOKEN`, the Command Code key or the provider keys.
- Token pushes: commits pushed with the plain `GITHUB_TOKEN` do not trigger other workflows, which is a GitHub platform behavior. Using the app token lifts that; the dogfood workflow in this repository does it.

## Limitations / roadmap

- Fork pull requests are supported for the checkout and the push when the contributor has "Allow edits by maintainers" enabled and the token can reach the fork; otherwise the run reports the push failure in a comment and saves the work as the `commandcode-rescue` artifact.
- There is no live progress comment during a run. You get the reaction while it works and the final report when it finishes.
- The GitHub App in `app/` provides the bot identity with short-lived, revocable tokens and enables workflow chaining.

## Links

- Command Code docs: https://commandcode.ai/docs

## License

MIT. See [LICENSE](LICENSE). Copyright (c) 2026 Carlos Muñoz.

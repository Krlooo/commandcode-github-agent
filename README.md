# Command Code GitHub Agent

Mention `/cmd` (or `/commandcode`) in an issue or pull request comment and the agent works on it
inside your own repository's GitHub Actions: it implements the change, verifies it, reviews its own
work and opens a pull request. No external bot service, no code leaving your runners against your
will — just a composite action wrapping the [Command Code](https://commandcode.ai/docs) CLI.

## How it works

A single run walks a fixed pipeline:

```
trigger  ->  permission gate  ->  branch  ->  implementer agent  ->  verification command
   ->  reviewer agent  ->  commit / push  ->  pull request  ->  report comment
```

1. **Trigger** — a `/cmd` (or `/commandcode`) comment, an issue opened with the `commandcode`
   label, or a manual `workflow_dispatch`. The trigger comment receives an 👀 reaction while the
   run is in progress, replaced with 🚀 on success (and 👎 on failure).
2. **Permission gate** — the actor must be a collaborator with `write` or `admin` access. Anyone
   else gets an explanatory comment and the run stops. Events authored by a bot are ignored.
3. **Branch** — for an issue the agent branches `commandcode/issue-<n>-<timestamp>` off the default
   branch; for a pull request it checks out the PR's head branch and pushes back to it.
4. **Implementer agent** — `cmdc` runs headless (`-p … --yolo --output-format json --max-turns …`)
   with the task, the sanitized issue/PR context and a set of rules; it edits the working tree.
5. **Verification command** — the `verify-command` runs in the workspace; its output is captured for
   both the reviewer and the pull request body.
6. **Reviewer agent** — a second, fresh `cmdc` session audits the diff and the verification output,
   fixes gaps and writes a short review summary.
7. **Commit & push** — the harness commits the working tree as `commandcode-agent[bot]` and pushes
   with the workflow token.
8. **Pull request** — a PR is opened for issues (or the existing PR branch is updated); the body
   contains the task, the change summary, the verification result and the review.
9. **Report comment** — a final comment links the branch, the PR, the model, agent sessions, the
   duration and the workflow run.

## Quick start

1. Copy [`.github/workflows/commandcode.yml`](.github/workflows/commandcode.yml) into your
   repository, or adapt its `on:`/`uses:` block to point at this action.
2. Create a provider secret (e.g. `AGENT_API_KEY`) and set `provider`, `provider-base-url` and
   `model` in the `with:` block of the workflow.
3. Comment `/cmd fix the flaky login test` on an issue (or add the `commandcode` label to a new
   issue).

The workflow **must** declare write permissions for the agent to push and comment:

```yaml
permissions:
  contents: write
  pull-requests: write
  issues: write
```

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `mentions` | `/cmd,/commandcode` | Comma-separated trigger strings; a comment starting a line with one of them (at a word boundary) starts the agent. |
| `model` | — | Model identifier passed to the Command Code CLI (`-m`). Required when `provider-api-key` is set. |
| `max-turns` | `100` | Maximum number of agent turns per agent run (implementer and reviewer). |
| `verify-command` | — | Command run after the implementer agent to verify the change (e.g. `npm ci && npm test`). |
| `review` | `true` | Run the reviewer agent pass after verification (`true`/`false`). |
| `provider` | — | BYOK provider id written to `~/.commandcode/providers.json` (e.g. `openrouter`). |
| `provider-base-url` | — | Base URL for the BYOK provider (e.g. `https://openrouter.ai/api/v1`). |
| `provider-api-key` | — | API key for the BYOK provider; provide it through a secret. |
| `github-token` | `${{ github.token }}` | Token used for the GitHub API and git push; defaults to the workflow token. |

## Usage

```yaml
name: commandcode
on:
  issue_comment:
    types: [created]

permissions:
  contents: write
  pull-requests: write
  issues: write

jobs:
  commandcode:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: <owner>/commandcode-github-agent@main
        with:
          verify-command: "npm ci && npm test && npm run typecheck"
          provider: openrouter
          provider-base-url: https://openrouter.ai/api/v1
          provider-api-key: ${{ secrets.AGENT_API_KEY }}
          model: <model-id>
```

## Auth (BYOK)

The action installs the CLI with `npm install -g command-code` (binary `cmdc`). When
`provider-api-key` is set, it writes `~/.commandcode/providers.json` with a `$VAR` reference —
the key itself is never stored in the file; it is passed to the CLI through the
`CMD_AGENT_PROVIDER_KEY` environment variable, alongside `CMD_LOCAL_ONLY=1` to keep the CLI
offline from Command Code's own services. When no key is provided, the file is left untouched and
the CLI falls back to its existing configuration.

In short: bring your own provider key via a secret; the model is billed to that key.

## Security

- **Collaborators-only gate** — only actors with `write`/`admin` on the repository can trigger a
  run; the permission is looked up through the GitHub API.
- **Bot loop guard** — events whose actor ends in `[bot]` are ignored, so the agent cannot trigger
  itself in a loop.
- **Prompt-injection sanitization** — issue and PR text is stripped of HTML comments, zero-width
  and bidi control characters before it reaches a prompt, and the remaining context is explicitly
  marked as untrusted "information only".
- **Scoped token** — `GITHUB_TOKEN` in the step is limited to the job's declared `permissions`.
- **Token pushes** — commits pushed with `GITHUB_TOKEN` do **not** trigger other workflows (a
  GitHub platform behavior). The GitHub App phase below is intended to lift that limitation.

## Limitations / roadmap

- **Fork pull requests** are not supported yet — the agent refuses to run on a PR whose head
  repository is a fork.
- **Single-run evidence** — there is no live, streaming progress comment during a run; you get the
  reaction while it works and the final report comment when it finishes.
- **GitHub App phase** — a dedicated GitHub App identity with short-lived tokens, which also
  enables fork support and workflow chaining.

## Links

- Command Code docs — https://commandcode.ai/docs

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Carlos Muñoz.

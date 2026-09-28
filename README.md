# Command Code GitHub Agent

Mention `@commandcode-agent` in an issue, pull request or review comment and the agent works on it inside your own repository's GitHub Actions. It implements the change, verifies it, reviews its own work and opens a pull request. The code stays on your runners: the action wraps the [Command Code](https://commandcode.ai/docs) CLI in a composite action.

## How it works

A run follows the same pipeline every time:

```
trigger  ->  permission gate  ->  branch  ->  implementer agent  ->  verification command
   ->  reviewer agent  ->  commit / push  ->  pull request  ->  report comment
```

1. Trigger: an `@commandcode-agent` comment (on an issue, a pull request or a pull request review), an issue assigned to the app, or a manual `workflow_dispatch`. Images pasted into the triggering comment are downloaded and handed to the agent. The triggering comment gets a 👀 reaction while the run is in progress, replaced with 🚀 on success or 👎 on failure.
2. Permission gate: the actor must have `write` or `admin` access to the repository. Anyone else gets an explanatory comment and the run stops. Events authored by a bot are ignored.
3. Branch: for an issue the agent creates `commandcode/issue-<n>-<timestamp>` from the default branch. For a pull request it checks out the PR head branch and pushes back to it.
4. Implementer agent: `cmdc` runs headless (`-p ... --yolo --output-format json --max-turns ...`) with the task, the sanitized issue/PR context and a set of rules. It edits the working tree.
5. Verification command: the `verify-command` runs in the workspace and its output is kept for the reviewer and the pull request body.
6. Reviewer agent: a second `cmdc` session with no shared context audits the diff and the verification output, fixes gaps and writes a review summary.
7. Commit and push: the harness commits the working tree as `commandcode-agent[bot]` and pushes.
8. Pull request: for issues it opens a PR; for pull requests it updates the branch. The body has the task, the change summary, the verification result and the review.
9. Report comment: a final comment links the branch, the PR, the model, the agent sessions, the duration and the workflow run.

If the mention asks a question or requests an explanation rather than a change, the agent replies in the thread and opens no pull request; the recent comments are part of its context, so you can keep the conversation going by mentioning it again. With a read-only token configured, it also checks whether the question was already asked or answered in another issue or pull request and points you there.

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
| `model` | none | Model identifier passed to the Command Code CLI (`-m`). Required when `provider-api-key` is set. |
| `max-turns` | `100` | Maximum number of agent turns per agent run (implementer and reviewer). |
| `verify-command` | none | Command run after the implementer agent to verify the change (e.g. `npm ci && npm test`). |
| `review` | `true` | Run the reviewer agent pass after verification (`true`/`false`). |
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
          command-code-api-key: ${{ secrets.AGENT_API_KEY }}
          model: <model-id>
```

For the BYOK alternative, replace `command-code-api-key` with `provider`, `provider-base-url` and `provider-api-key` (see [Auth](#auth)).

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

## Security

- Collaborators-only gate: only actors with `write` or `admin` on the repository can trigger a run. The permission is looked up through the GitHub API.
- Bot loop guard: events whose actor ends in `[bot]` are ignored, so the agent cannot trigger itself in a loop.
- Prompt-injection sanitization: issue and PR text is stripped of HTML comments, zero-width and bidi control characters before it reaches a prompt, and the remaining context is marked as information only.
- Scoped token: the action uses the `github-token` you pass, which defaults to the workflow token limited to the job's `permissions`. With the optional GitHub App setup (`app/`, `actions/create-github-app-token`), the agent acts as a bot with a short-lived installation token. The write token never enters the agent's environment; if you pass `agent-token`, that separate token is read-only.
- Token pushes: commits pushed with the plain `GITHUB_TOKEN` do not trigger other workflows, which is a GitHub platform behavior. Using the app token lifts that; the dogfood workflow in this repository does it.

## Limitations / roadmap

- Fork pull requests are supported for the checkout and the push when the contributor has "Allow edits by maintainers" enabled and the token can reach the fork; otherwise the run reports the push failure in a comment.
- There is no live progress comment during a run. You get the reaction while it works and the final report when it finishes.
- The GitHub App in `app/` provides the bot identity with short-lived, revocable tokens and enables workflow chaining.

## Links

- Command Code docs: https://commandcode.ai/docs

## License

MIT. See [LICENSE](LICENSE). Copyright (c) 2026 Carlos Muñoz.

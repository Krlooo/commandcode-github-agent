# Feature: commandcode-github-agent

Created: 2026-09-28 · Updated: 2026-09-28 (multi-agent pipeline + fork constraints)
Branch: feature/mvp
TDD: enabled (vitest) — authored checks: `npm test`, `npm run typecheck`, `npm run build`

## Objective

A GitHub Action that lets anyone mention `/cmd` (or `/commandcode`) in an issue or PR comment and have
Command Code (`cmdc`) solve it inside GitHub Actions with a multi-agent pipeline: implement -> verify by
running the repo's own checks -> a second reviewer agent audits the diff against the issue and fixes what
is missing -> push + pull request whose body documents the steps, with verification evidence attached.
The mechanism mirrors the MIT `opencode-agent` design (comment trigger -> Actions job -> agent -> PR) but
is built from scratch on `cmdc -p`. This repository also dogfoods it: its own issues get solved by the
agent.

## Problem

There is no way to run Command Code from GitHub events today. opencode ships an equivalent app that runs
`opencode github run` inside the client repository's Actions; Command Code has headless mode but no
GitHub integration.

## Multi-agent pipeline (the "gentle-ai spirit")

1. **Implementer agent**: `cmdc -p "<issue context + task>" --yolo` — makes the changes on the working
   branch and reports what it did. Instructed to run the repo's own checks before finishing.
2. **Verification**: the action runs `verify_command` (e.g. `npm test`) after the agent and captures the
   output; the PR body includes this as evidence. Failures do not silently pass: they are reported.
3. **Reviewer agent** (fresh eyes — no shared session with the implementer, to avoid confirmation bias):
   reads the issue, the diff and the verification output; audits correctness and requirement coverage;
   fixes gaps and commits. Configurable: `review: true|false`.

Every step is one headless cmdc run (tokens on the user's key). Pipeline knobs: model, max turns,
verify command, review on/off. Sessions are chainable (`-p --continue` / `--resume <id>`, documented in
the headless reference) when context reuse is wanted instead of fresh eyes.

## Fork support — verified constraints (2026-09-28)

GitHub REST docs, "Create a fork", and Actions token scoping:

- The workflow `GITHUB_TOKEN` cannot create forks (repo-scoped, no Administration).
- `POST /repos/{o}/{r}/forks` works with a fine-grained PAT requiring **"Administration: write"** +
  "Contents: read", or a GitHub App installation token — but the App must be installed on the
  destination account with access to all repositories AND on the source account.
- "Administration: write" is a powerful permission to expose in a runner where the agent runs `--yolo`.
- PRs opened from a fork do not automatically run the destination repo's workflows without maintainer
  approval, so automatic CI on the PR is not guaranteed in fork mode.
- Modes: **A** (default) push branch `commandcode/issue-N-<ts>` to the repo itself; **B** push to a
  pre-created fork owned by a bot/user with a Contents-scoped PAT (no Administration; fork created
  upfront); **C** auto-create fork per run (requires Administration PAT or the App installed on the
  destination account).
- Open decision (user): which mode ships in the MVP. Working assumption until answered: mode A for the
  MVP; B documented and supported behind inputs; C deferred to the GitHub App phase.

## Why this shape

- Everything runs inside the client repo's Actions: no third party hosts code or runs the model.
- MVP authenticates with the workflow `GITHUB_TOKEN` (no app install needed). The dedicated GitHub App
  (OIDC -> installation token exchange) is phase 2 and removes `GITHUB_TOKEN` limitations (fork PRs
  blocked-workflow issue, bot identity, events not re-triggering workflows).
- Agent auth uses the documented CI path: BYOK provider key via secret, `providers.json` with a
  `"$ENV_VAR"` reference and `CMD_LOCAL_ONLY=1` (no Command Code backend traffic).

## Scope (MVP)

- `action.yml` composite action: installs the `command-code` npm package and runs the compiled handler.
- Handler (TypeScript, Node 20, zero runtime dependencies):
  - Events: `issue_comment`, `issues` (label-gated auto mode), `workflow_dispatch` with prompt.
  - Permission gate: only collaborators with write/admin may trigger.
  - Prompt extraction from the trigger comment, configurable mentions.
  - Context gathering: issue/PR title, body and recent comments.
  - Git flow: branch `commandcode/issue-<n>-<ts>` (issue) or checkout of the PR branch; commit/push.
  - Pipeline: implementer run -> `verify_command` -> reviewer run (fresh session) -> final commit.
  - PR body with steps: implementer summary, verification evidence, reviewer summary + fixes.
  - Feedback: `👀` reaction while running, result comment with run link and usage.
- Dogfood + CI workflows on this repository.

## Phase 2 (authorized): GitHub App

- Create the Command Code Agent GitHub App. GitHub has no API to create Apps; the official manifest flow
  requires one human confirmation in the UI. Deliverable: `app/manifest.json` + a local auto-submit page
  (one click) + documented secrets.
- Default architecture (private app for own repos): `actions/create-github-app-token` in the workflow -
  no backend; installation tokens; PRs opened by the app can trigger other workflows; enables fork
  mode C when the app is installed on the destination account with all-repos access.
- Optional (public multi-tenant distribution, opencode-style): OIDC -> installation token exchange on a
  Cloudflare Worker holding GITHUB_APP_ID + private key; the action exchanges `getIDToken()` per run.
  Deferred until distribution is wanted.
- Also in this phase: image attachments, share links, cost caps.

## Constraints

- Zero runtime dependencies (global `fetch` + node builtins). `dist/` is committed: actions run it as-is.
- Strict TypeScript, no `any`, async/await only.
- TDD on pure logic: event parsing, prompt building, NDJSON parsing. Runner integration by smoke test.
- Conventional commits, one work-unit commit per task.

## Tasks

- [ ] T1 Scaffold: package.json, tsconfig, esbuild + vitest setup, .gitignore — route: inline
- [ ] T2 RED tests: event parsing, prompt building, NDJSON result parsing — route: inline
- [ ] T3 GREEN core with pipeline: src/event.ts, src/prompt.ts, src/github.ts, src/git.ts, src/agent.ts,
      src/index.ts (implementer + verify + reviewer orchestration) — route: delegated writer
- [ ] T4 Packaging: action.yml (inputs: mentions, model, api_key/provider, verify_command, review, fork
      settings), .github/workflows/commandcode.yml (dogfood), ci.yml, README — route: delegated writer
- [ ] T5 Smoke: recorded event payload end-to-end with real `cmdc -p` — route: inline
- [ ] T6 Publish: create GitHub remote, push, secrets, real issue test — requires user OK
- [ ] T7 GitHub App: manifest + one-click creation + app-token workflow path — phase 2

## Acceptance criteria

- `npm test`, `npm run typecheck`, `npm run build` all green.
- A simulated `issue_comment` payload produces branch + commit + PR body (with steps + evidence) + reply
  comment; simulated non-collaborator comment is rejected with an explanatory reply.
- In T6: commenting `/cmd` on a real issue of the published repo triggers the workflow and opens a PR.

## Checks

- `npm test` (vitest) · `npm run typecheck` (tsc --noEmit) · `npm run build` (esbuild bundle)
- T5 smoke: `node dist/index.js` against a recorded payload fixture in a disposable repo clone.

## Delivery strategy

single-pr: `feature/mvp` -> `main` on this new repository.

Budget note: the core handler is expected to exceed the ~400 authored lines heuristic as one coherent
unit (new repository scaffold + action + tests). Kept as a single PR because the repository is new and
there is no existing delivery gate to disturb.

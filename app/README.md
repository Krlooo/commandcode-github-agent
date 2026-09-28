# Command Code Agent — GitHub App

The app gives the action a bot identity (`commandcode-agent[bot]`) with short-lived
installation tokens, instead of the workflow `GITHUB_TOKEN`.

- `manifest.json` — the app definition: permissions (`contents: write`,
  `issues: write`, `pull_requests: write`, `metadata: read`), no webhook events
  (the trigger is the repository's own workflow — the app only provides the token),
  and `public: true` so anyone can install it from its install page.
- `create.js` — the one-click creation helper (manifest flow):
  1. `node app/create.js` and open http://localhost:8765
  2. Press **Create GitHub App** (the only manual click; GitHub builds the app from
     the manifest with every permission prefilled)
  3. GitHub redirects back to the local helper, which exchanges the code for the
     credentials (id + private key) and writes them to `~/.commandcode-agent/`
     (never inside the repository)
  4. Configure what consumes them:
     - per-repository usage: `gh variable set APP_ID` + `gh secret set APP_PRIVATE_KEY`,
       then use `actions/create-github-app-token` in the workflow and pass the token
       to the action's `github-token` input.
     - multi-tenant usage (opencode-style, without sharing the private key): an
       OIDC exchange backend (Cloudflare Worker) holding the private key; the action
       exchanges the workflow's OIDC token for an installation token per run.

- `logo.png` — the official Command Code mark (sourced from commandcode.ai's app
  icons, 192x192), ready to upload in the app settings:
  **Settings → Display information → Logo** (GitHub has no API for the app avatar;
  it is a one-time UI step after creation).

Once the app exists, its install button lives at
`https://github.com/apps/commandcode-agent` — the same one-click page opencode uses.

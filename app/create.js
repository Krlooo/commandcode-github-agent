/**
 * One-click GitHub App creation (manifest flow) for Command Code Agent.
 *
 * Usage:
 *   node app/create.js
 *
 * What it does:
 *   1. Serves a tiny local page that auto-submits the manifest in app/manifest.json
 *      to GitHub ("Create GitHub App" - the only human click).
 *   2. GitHub redirects back to http://localhost:8765/callback?code=...
 *   3. The code is exchanged (POST /app-manifests/{code}/conversions) for the app
 *      credentials: id, slug, private key (PEM), client id/secret, webhook secret.
 *   4. Credentials are written OUTSIDE the repository, under
 *      ~/.commandcode-agent/, and the exact `gh` commands to configure the repo
 *      secrets are printed.
 *
 * No dependencies: node:http + global fetch (Node >= 22).
 */

import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const PORT = Number(process.env["PORT"] ?? 8765);
const STATE = randomBytes(16).toString("hex");
const here = dirname(fileURLToPath(import.meta.url));
const credentialsDir = join(homedir(), ".commandcode-agent");

function loadManifest() {
  const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
  manifest.redirect_url = `http://localhost:${PORT}/callback`;
  return manifest;
}

function escapeAttribute(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function page(manifest) {
  const action = `https://github.com/settings/apps/new?state=${STATE}`;
  const value = escapeAttribute(JSON.stringify(manifest));
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Create Command Code Agent</title></head>
<body>
  <p>Redirecting to GitHub to create the app…</p>
  <form id="create" method="post" action="${action}">
    <input type="hidden" name="manifest" value='${value}'>
    <noscript><button type="submit">Create GitHub App</button></noscript>
  </form>
  <script>document.getElementById("create").submit();</script>
</body>
</html>`;
}

async function exchangeCode(code) {
  const response = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "commandcode-agent-setup",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`code exchange failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

function saveCredentials(conversion) {
  mkdirSync(credentialsDir, { recursive: true });
  const slug = conversion.slug ?? "commandcode-agent";
  const pemPath = join(credentialsDir, `${slug}.private-key.pem`);
  const jsonPath = join(credentialsDir, `${slug}.json`);

  writeFileSync(pemPath, conversion.pem, { mode: 0o600 });
  writeFileSync(
    jsonPath,
    `${JSON.stringify(
      {
        id: conversion.id,
        slug: conversion.slug,
        name: conversion.name,
        html_url: conversion.html_url,
        client_id: conversion.client_id,
        client_secret: conversion.client_secret,
        webhook_secret: conversion.webhook_secret,
        private_key_path: pemPath,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return { pemPath, jsonPath };
}

const manifest = loadManifest();

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://localhost:${PORT}`);

  if (url.pathname === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(page(manifest));
    return;
  }

  if (url.pathname === "/callback") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || state !== STATE) {
      response.writeHead(400, { "content-type": "text/plain" });
      response.end("Invalid callback (missing code or state mismatch).");
      return;
    }
    try {
      const conversion = await exchangeCode(code);
      const { pemPath, jsonPath } = saveCredentials(conversion);
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end(
        [
          `App created: ${conversion.html_url}`,
          `App id: ${conversion.id}`,
          `Credentials saved outside the repository:`,
          `  ${jsonPath}`,
          `  ${pemPath}`,
          ``,
          `Next steps (run from the repository checkout):`,
          `  1. Upload the logo: app/logo.png (app settings -> Display information -> Logo)`,
          `  2. gh variable set APP_ID --repo <owner>/<repo> --body "${conversion.id}"`,
          `  3. gh secret set APP_PRIVATE_KEY --repo <owner>/<repo> < "${pemPath}"`,
          `     (or store them in the OIDC exchange backend for multi-tenant use)`,
          ``,
          `Install page for users: ${conversion.html_url}`,
        ].join("\n"),
      );
      console.log(`App created: ${conversion.html_url} (id ${conversion.id})`);
      console.log(`Credentials written to ${jsonPath}`);
      console.log(`Users install it from: ${conversion.html_url}`);
    } catch (error) {
      response.writeHead(502, { "content-type": "text/plain" });
      response.end(`Exchange failed: ${error instanceof Error ? error.message : String(error)}`);
      console.error(error);
    }
    setTimeout(() => server.close(), 250);
    return;
  }

  response.writeHead(404, { "content-type": "text/plain" });
  response.end("not found");
});

server.listen(PORT, () => {
  console.log(`Command Code Agent - GitHub App setup`);
  console.log(`Open this URL in your browser to create the app (one click):`);
  console.log(`  http://localhost:${PORT}/`);
  console.log(`Waiting for GitHub to redirect back after you press "Create GitHub App"...`);
});

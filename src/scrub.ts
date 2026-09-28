/**
 * Secret scrubbing for any text that can reach a public comment or the console.
 *
 * Zero dependencies: pure string work only. Used to make sure a Git push
 * failure (whose error message embeds the command line) never leaks the
 * workflow token into a posted comment or CI log.
 */

/**
 * `x-access-token:<secret>@` inside a git remote URL, where `<secret>` is any
 * run of characters that is neither `@` nor whitespace.
 */
const ACCESS_TOKEN_URL = /x-access-token:[^@\s]+@/g;

/**
 * Collects the non-empty secret strings from a list of candidates, so callers
 * can build a secrets list without repeating empty-string guards.
 */
export function collectSecrets(values: Array<string | undefined>): string[] {
  return values.filter((value): value is string => typeof value === "string" && value.length > 0);
}

/**
 * Returns a copy of `text` with known secrets removed:
 *
 * 1. every `x-access-token:<token>@` URL credential becomes `x-access-token:***@`;
 * 2. every exact occurrence of each string in `secrets` becomes `***`.
 *
 * Empty secret strings are ignored (they would otherwise match everywhere).
 */
export function scrubSecrets(text: string, secrets: string[]): string {
  let scrubbed = text.replace(ACCESS_TOKEN_URL, "x-access-token:***@");
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    scrubbed = scrubbed.split(secret).join("***");
  }
  return scrubbed;
}

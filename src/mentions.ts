/**
 * Trigger mentions.
 *
 * The default lives here so the runtime fallback and the `action.yml` input
 * default cannot drift apart; `test/mentions.test.ts` asserts that the two
 * agree.
 */

/** Default trigger mention; mirrors the `mentions` default declared in action.yml. */
export const DEFAULT_MENTIONS = "@commandcode-agent";

/**
 * Parses the comma-separated `mentions` input into a list. An empty (or
 * all-blank) value falls back to {@link DEFAULT_MENTIONS}.
 */
export function parseMentions(value: string): string[] {
  const mentions = value
    .split(",")
    .map((mention) => mention.trim())
    .filter((mention) => mention.length > 0);
  return mentions.length > 0 ? mentions : [DEFAULT_MENTIONS];
}

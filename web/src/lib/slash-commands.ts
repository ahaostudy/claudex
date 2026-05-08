/**
 * Built-in slash commands surfaced in the composer's `/` picker.
 *
 * We don't execute anything ourselves — selecting a command just inserts its
 * literal token into the composer. The underlying `claude` CLI (spawned by
 * the server via @anthropic-ai/claude-agent-sdk) is what actually interprets
 * `/review`, `/compact`, etc.
 *
 * Kept hardcoded here rather than fetched from the server because these are
 * CLI-level behaviors that ship with `claude`, not things claudex defines.
 * If the CLI ever exposes a listing, this can move to an API.
 */

export interface SlashCommand {
  /** The token that gets inserted (without the leading slash). */
  name: string;
  /** One-line human-readable description, shown under the name. */
  description: string;
  /** Optional badge text. "built-in" mirrors mockup screen 09. */
  badge?: string;
}

export const BUILTIN_SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "review",
    description: "Review the current diff",
    badge: "built-in",
  },
  {
    name: "compact",
    description: "Summarize and free context window",
    badge: "built-in",
  },
  {
    name: "btw",
    description: "Open a side chat that doesn't derail the main session",
    badge: "built-in",
  },
  {
    name: "plan",
    description: "Switch to plan mode for this turn",
    badge: "built-in",
  },
];

/**
 * Filter commands by a substring of the user's typed query (post-`/`). Case-
 * insensitive match against both `name` and `description` — keeps the
 * behavior forgiving on mobile where exact typing is harder.
 */
export function filterSlashCommands(
  query: string,
  commands: SlashCommand[] = BUILTIN_SLASH_COMMANDS,
): SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  return commands.filter(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      c.description.toLowerCase().includes(q),
  );
}

import type { ModelId, Project, Session, SessionEvent } from "@claudex/shared";

/**
 * Per-session transcript export — Markdown + JSON.
 *
 * Pure, input-driven: the caller (HTTP route) loads the session row, its
 * project, and the full event array, then hands them in here. No I/O.
 *
 * We deliberately keep this simple & honest — no streaming, no truncation of
 * transcripts as a whole, no redaction. Large individual `tool_result`
 * payloads are truncated at 4000 chars so a single command with a huge
 * stdout doesn't produce an unreadable wall of text.
 */

const MODEL_LABEL: Record<ModelId, string> = {
  "claude-opus-4-7": "Opus 4.7",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-haiku-4-5": "Haiku 4.5",
};

const TOOL_RESULT_MAX_CHARS = 4000;

export function exportSessionJson(
  session: Session,
  events: SessionEvent[],
): { session: Session; events: SessionEvent[] } {
  return { session, events };
}

/**
 * Render a session + its events as Markdown.
 *
 * Unknown event kinds are skipped rather than crashing — keeps the exporter
 * robust against schema drift.
 */
export function renderTranscriptMarkdown(
  session: Session,
  events: SessionEvent[],
  opts?: { project?: Project | null },
): string {
  const out: string[] = [];

  // -- header -------------------------------------------------------------
  out.push(`# ${session.title}`);
  out.push("");
  out.push(`- **Session**: ${session.id}`);
  const project = opts?.project ?? null;
  if (project) {
    out.push(`- **Project**: ${project.name} (${project.path})`);
  }
  const modelLabel =
    MODEL_LABEL[session.model as ModelId] ?? session.model;
  out.push(`- **Model**: ${modelLabel}`);
  out.push(`- **Mode**: ${session.mode}`);
  out.push(`- **Created**: ${session.createdAt}`);
  out.push(
    `- **Last message**: ${session.lastMessageAt ?? "—"}`,
  );
  out.push("");
  out.push("---");
  out.push("");

  // -- events -------------------------------------------------------------
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  for (const ev of sorted) {
    const chunk = renderEvent(ev);
    if (chunk === null) continue; // unknown kind
    out.push(chunk);
    out.push("");
  }

  // Trim trailing blank lines for tidiness.
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n") + "\n";
}

function renderEvent(ev: SessionEvent): string | null {
  const p = ev.payload ?? {};
  switch (ev.kind) {
    case "user_message": {
      const text = getStr(p, "content") ?? getStr(p, "text") ?? "";
      return `**You:** ${text}`;
    }
    case "assistant_text": {
      const text = getStr(p, "text") ?? getStr(p, "content") ?? "";
      return `**Claude:** ${text}`;
    }
    case "assistant_thinking": {
      const text = getStr(p, "text") ?? getStr(p, "content") ?? "";
      return `> _thinking_ ${text}`;
    }
    case "tool_use": {
      const toolName = getStr(p, "toolName") ?? getStr(p, "name") ?? "tool";
      const rawInput = (p as Record<string, unknown>).input;
      const inputJson = safeJson(rawInput ?? {});
      return ["```", `<tool: ${toolName}>`, inputJson, "```"].join("\n");
    }
    case "tool_result": {
      const toolUseId =
        getStr(p, "toolUseId") ?? getStr(p, "tool_use_id") ?? "";
      const isError = Boolean((p as Record<string, unknown>).isError);
      let content = stringifyContent((p as Record<string, unknown>).content);
      if (content.length > TOOL_RESULT_MAX_CHARS) {
        content = content.slice(0, TOOL_RESULT_MAX_CHARS) + "…";
      }
      return [
        "```",
        `<result for ${toolUseId}>`,
        `isError: ${isError}`,
        content,
        "```",
      ].join("\n");
    }
    case "permission_request": {
      const toolName = getStr(p, "toolName") ?? getStr(p, "name") ?? "tool";
      const summary =
        getStr(p, "summary") ?? getStr(p, "title") ?? "";
      return `> ⚠ Permission: ${toolName} — ${summary}`;
    }
    case "permission_decision": {
      const decision = getStr(p, "decision") ?? "";
      const mark =
        decision === "deny" || decision === "denied" ? "✗" : "✓";
      return `> ${mark} Permission ${decision}`;
    }
    case "turn_end": {
      const usage = (p as Record<string, unknown>).usage as
        | Record<string, unknown>
        | undefined;
      if (!usage || typeof usage !== "object") {
        return "---";
      }
      const i = pickNum(usage, "inputTokens");
      const o = pickNum(usage, "outputTokens");
      const cr = pickNum(usage, "cacheReadInputTokens");
      const cc = pickNum(usage, "cacheCreationInputTokens");
      return [
        "---",
        "",
        `_turn end · in ${i} tok / out ${o} tok · cache read ${cr} / create ${cc}_`,
      ].join("\n");
    }
    case "error": {
      const message = getStr(p, "message") ?? getStr(p, "error") ?? "";
      return `> ❌ Error: ${message}`;
    }
    default:
      return null;
  }
}

function getStr(p: Record<string, unknown>, key: string): string | null {
  const v = p[key];
  return typeof v === "string" ? v : null;
}

function pickNum(p: Record<string, unknown>, key: string): number {
  const v = p[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/**
 * `tool_result.content` can legitimately be a plain string or an array of
 * SDK content blocks (`[{type: "text", text: "..."}]`). Fold the array form
 * down to a single string; pretty-print anything else via JSON so we don't
 * silently drop data.
 */
function stringifyContent(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const parts: string[] = [];
    for (const item of c) {
      if (item && typeof item === "object") {
        const rec = item as Record<string, unknown>;
        if (typeof rec.text === "string") {
          parts.push(rec.text);
          continue;
        }
      }
      if (typeof item === "string") {
        parts.push(item);
        continue;
      }
      parts.push(safeJson(item));
    }
    return parts.join("\n");
  }
  if (c === undefined || c === null) return "";
  return safeJson(c);
}

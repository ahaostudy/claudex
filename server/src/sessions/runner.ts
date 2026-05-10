import type { EventEmitter } from "node:events";
import type {
  AskUserQuestionAnnotation,
  AskUserQuestionItem,
  ModelId,
  PermissionMode,
} from "@claudex/shared";

// -----------------------------------------------------------------------------
// Runner abstraction
//
// The server holds one Runner per active session. A Runner is responsible for:
//   • spawning and managing the claude subprocess (via the Agent SDK)
//   • accepting user messages and forwarding them
//   • emitting RunnerEvent to anyone listening (the transport layer)
//   • surfacing permission requests as awaitable promises
//
// Concrete implementation lives in `agent-runner.ts`. This file is the
// contract the transport + tests pin against, so the SDK wrapper can
// evolve without ripple effects.
// -----------------------------------------------------------------------------

export interface RunnerInitOptions {
  sessionId: string;
  cwd: string;
  model: ModelId;
  permissionMode: PermissionMode;
  // Persisted SDK session id (for resume across turns). Undefined on first run.
  resumeSdkSessionId?: string;
  // Whether CLAUDE.md / settings files should be loaded. Default true.
  useProjectSettings?: boolean;
  // Optional pino-shaped logger for diagnostic breadcrumbs (e.g. raw SDK
  // usage on every turn_end). When absent the runner stays silent — tests
  // don't need to thread a logger through.
  logger?: {
    info: (obj: Record<string, unknown>, msg: string) => void;
  };
}

export type RunnerEvent =
  // `starting` / `terminated` are runner-lifecycle values; the WS bridge
  // maps them to `running` / `idle` respectively. `awaiting` and `error`
  // are never emitted by the AgentRunner itself — the SessionManager
  // synthesizes them via `broadcastStatus` when the DB row flips to
  // those states (e.g. pending permission / ask_user_question /
  // plan_accept_request, or a watchdog-forced error) so subscribed tabs
  // see the session's status dot change without waiting for the next
  // runner event.
  | {
      type: "status";
      status:
        | "starting"
        | "running"
        | "idle"
        | "terminated"
        | "awaiting"
        | "error"
        // Manager-synthesized from the CLI process scanner
        // (server/src/cli-sync/process-scanner.ts). Flips idle sessions that
        // have a live external `claude` CLI process attached. Never emitted
        // by the AgentRunner.
        | "cli_running";
    }
  | { type: "sdk_session_id"; sdkSessionId: string }
  | { type: "assistant_text"; messageId: string; text: string; done: boolean }
  | { type: "thinking"; text: string }
  | {
      type: "tool_use";
      toolUseId: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      toolUseId: string;
      content: string;
      isError: boolean;
    }
  | {
      type: "permission_request";
      toolUseId: string;
      toolName: string;
      input: Record<string, unknown>;
      title: string;
    }
  // SDK's built-in `AskUserQuestion` tool — NOT a permission ask. Surfaces a
  // multiple-choice interaction the model wants the user to answer before it
  // continues. We resolve the corresponding `canUseTool` promise via
  // `resolveAskUserQuestion` with the user's selections as `updatedInput`.
  | {
      type: "ask_user_question";
      askId: string;
      questions: AskUserQuestionItem[];
    }
  // SDK's built-in `ExitPlanMode` tool — NOT a permission ask either. The
  // model calls it after a planning pass to signal "I've sketched the plan,
  // ready to execute?". We resolve the `canUseTool` promise via
  // `resolvePlanAccept`: accept → `{behavior: "allow"}`, reject →
  // `{behavior: "deny", message: ...}` (the model sees a tool error and can
  // regenerate the plan). `plan` is the markdown text the SDK delivered in
  // the tool_use input payload.
  | {
      type: "plan_accept_request";
      planId: string;
      plan: string;
    }
  | {
      type: "turn_end";
      stopReason: string;
      // Token usage from the SDK's `result` message. `inputTokens` is the
      // *new* (uncached) input for this turn — with prompt caching on, most
      // of the real context sits under `cacheReadInputTokens` and
      // `cacheCreationInputTokens`. The UI sums all three to reflect the
      // true context body shipped to the model.
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadInputTokens?: number;
        cacheCreationInputTokens?: number;
      };
    }
  // Manager-synthesized (not emitted by the Agent SDK). Broadcast when a
  // user message lands in the session so every subscribed tab sees it
  // right away. The originating tab gets it too and reconciles it
  // against its local optimistic echo. `echoId` is an opaque nonce the
  // originating tab attached to its `ClientUserMessage` — relayed
  // verbatim so the sender can match its optimistic piece without the
  // legacy text+3s heuristic. Undefined for messages from legacy clients.
  | { type: "user_message"; text: string; at: string; echoId?: string }
  // Manager-synthesized. Fired when the server has appended events to a
  // session out-of-band (e.g. the CLI JSONL resync path) — the client
  // refetches the transcript tail rather than us re-streaming each event.
  | { type: "refresh_transcript" }
  // Manager-synthesized. Fired when the queued_prompts table changes in any
  // way (create, patch, delete, move, runner status transition). Not tied
  // to a specific session — the WS layer routes it through the global
  // channel so every authenticated tab's Queue screen can refetch.
  | { type: "queue_update"; at: string }
  // Alerts list changed (new row, seen/resolved/dismissed, or auto-resolved
  // by a session status transition). Cross-session by design — routed
  // through the global WS channel just like queue_update.
  | { type: "alerts_update"; at: string }
  | { type: "error"; code: string; message: string };

export type RunnerListener = (event: RunnerEvent) => void;

export interface PermissionDecision {
  behavior: "allow" | "deny";
  reason?: string;
}

export interface Runner {
  readonly sessionId: string;
  readonly sdkSessionId: string | null;
  start(initialPrompt?: string): Promise<void>;
  sendUserMessage(content: string): Promise<void>;
  resolvePermission(toolUseId: string, decision: PermissionDecision): void;
  // Resolve a pending AskUserQuestion interaction with the user's answers.
  // Mirror of `resolvePermission`: no-op when the askId is unknown (double
  // submit / stale client). The runner resolves the SDK `canUseTool` promise
  // with `{ behavior: "allow", updatedInput: { answers, annotations? } }`.
  resolveAskUserQuestion(
    askId: string,
    answers: Record<string, string>,
    annotations?: Record<string, AskUserQuestionAnnotation>,
  ): void;
  // Resolve a pending `ExitPlanMode` interaction. `accept` resolves the SDK's
  // `canUseTool` with `{ behavior: "allow" }` (letting the model proceed with
  // its plan; the SDK itself handles transitioning out of `plan` mode).
  // `reject` resolves with `{ behavior: "deny", message }` — the model sees
  // a tool error and can revise the plan. No-op on unknown planId (double
  // submit / stale client).
  resolvePlanAccept(planId: string, decision: "accept" | "reject"): void;
  interrupt(): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  dispose(): Promise<void>;
  on(listener: RunnerListener): () => void;
  // For tests / diagnostics.
  listenerCount(): number;
}

export interface RunnerFactory {
  create(opts: RunnerInitOptions): Runner;
}

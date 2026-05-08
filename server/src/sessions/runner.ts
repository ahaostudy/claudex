import type { EventEmitter } from "node:events";
import type { ModelId, PermissionMode } from "@claudex/shared";

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
}

export type RunnerEvent =
  | { type: "status"; status: "starting" | "running" | "idle" | "terminated" }
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
  | {
      type: "turn_end";
      stopReason: string;
      usage?: { inputTokens?: number; outputTokens?: number };
    }
  // Manager-synthesized (not emitted by the Agent SDK). Broadcast when a
  // user message lands in the session so every subscribed tab sees it
  // right away. The originating tab gets it too and reconciles it
  // against its local optimistic echo.
  | { type: "user_message"; text: string; at: string }
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

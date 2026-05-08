import {
  query,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { nanoid } from "nanoid";
import type {
  PermissionDecision,
  Runner,
  RunnerEvent,
  RunnerFactory,
  RunnerInitOptions,
  RunnerListener,
} from "./runner.js";
import type {
  AskUserQuestionAnnotation,
  AskUserQuestionItem,
  PermissionMode,
} from "@claudex/shared";

/**
 * Real Agent SDK runner. One instance per session.
 *
 * Notes:
 *   - we drive the SDK with an async-iterable input queue so we can push
 *     follow-up user messages without restarting the subprocess
 *   - SDK session_id arrives on the first `system/init` message; we capture
 *     and emit it so the caller can persist & `resume` later turns
 *   - permission requests resolve via a per-toolUseId promise map, which
 *     the transport fulfils after the UI responds
 *   - env MUST be merged with process.env — the SDK replaces rather than
 *     extends it (v0.2.113 breaking change)
 */
export class AgentRunner implements Runner {
  readonly sessionId: string;
  private _sdkSessionId: string | null = null;
  private listeners = new Set<RunnerListener>();
  private pendingPermissions = new Map<
    string,
    (decision: PermissionDecision) => void
  >();
  // Pending AskUserQuestion interactions. Separate map from permissions so the
  // SDK tool branch can't collide with a genuine permission ask and so
  // double-submit protection is trivial (delete on first resolve).
  private pendingAskUserQuestion = new Map<
    string,
    (resp: {
      answers: Record<string, string>;
      annotations?: Record<string, AskUserQuestionAnnotation>;
    }) => void
  >();
  private userMessages: AsyncPush<SDKUserMessageShape>;
  private sdkHandle: ReturnType<typeof query> | null = null;
  private disposed = false;
  private permissionMode: PermissionMode;

  constructor(private readonly opts: RunnerInitOptions) {
    this.sessionId = opts.sessionId;
    this.permissionMode = opts.permissionMode;
    this.userMessages = new AsyncPush();
  }

  get sdkSessionId(): string | null {
    return this._sdkSessionId;
  }

  on(listener: RunnerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listenerCount(): number {
    return this.listeners.size;
  }

  private emit(ev: RunnerEvent): void {
    for (const l of this.listeners) {
      try {
        l(ev);
      } catch {
        // a bad listener must not take down the runner
      }
    }
  }

  async start(initialPrompt?: string): Promise<void> {
    if (this.sdkHandle) return;
    if (this.disposed) throw new Error("runner disposed");

    const sdkOptions: Options = {
      cwd: this.opts.cwd,
      permissionMode: mapPermissionMode(this.permissionMode),
      model: this.opts.model,
      // MUST merge — SDK replaces process.env otherwise.
      env: { ...process.env } as Record<string, string>,
      resume: this.opts.resumeSdkSessionId,
      // Opus 4.7's default adaptive-thinking display is "omitted" — the model
      // thinks but the SDK never forwards the text. Explicitly ask for
      // summarized thinking so the UI's Verbose view-mode has something to
      // render. Keeps the model in adaptive mode (no fixed budget).
      thinking: { type: "adaptive", display: "summarized" },
      canUseTool: (toolName, input, { toolUseID, title }) =>
        new Promise<
          | { behavior: "allow"; updatedInput?: Record<string, unknown> }
          | { behavior: "deny"; message: string }
        >((resolve) => {
          // AskUserQuestion is a multiple-choice interaction, not a security
          // gate. Branch early so the permission_request flow never fires for
          // it. The SDK expects `updatedInput` to match
          // `AskUserQuestionOutput` (answers + optional annotations) — we fill
          // that from whatever the client posts back via `resolveAskUserQuestion`.
          if (toolName === "AskUserQuestion") {
            const questions = extractAskUserQuestions(input);
            this.pendingAskUserQuestion.set(toolUseID, ({ answers, annotations }) => {
              const updatedInput: Record<string, unknown> = {
                ...input,
                answers,
              };
              if (annotations) updatedInput.annotations = annotations;
              resolve({ behavior: "allow", updatedInput });
            });
            this.emit({
              type: "ask_user_question",
              askId: toolUseID,
              questions,
            });
            return;
          }
          this.pendingPermissions.set(toolUseID, (d) => {
            if (d.behavior === "allow") {
              resolve({ behavior: "allow", updatedInput: input });
            } else {
              resolve({
                behavior: "deny",
                message: d.reason ?? "user denied",
              });
            }
          });
          this.emit({
            type: "permission_request",
            toolUseId: toolUseID,
            toolName,
            input,
            title: title ?? `use ${toolName}`,
          });
        }),
      // By default Agent SDK loads user + project + CLAUDE.md.
      ...(this.opts.useProjectSettings === false
        ? { settingSources: [] as Options["settingSources"] }
        : {}),
    };

    this.emit({ type: "status", status: "starting" });

    this.sdkHandle = query({
      prompt: this.userMessages.iterator(),
      options: sdkOptions,
    });

    // Seed an initial user message if provided.
    if (initialPrompt) {
      this.userMessages.push(userMessage(initialPrompt));
    }

    // Consume the stream in the background.
    this.consume().catch((err) => {
      this.emit({
        type: "error",
        code: "runner_failed",
        message: err instanceof Error ? err.message : String(err),
      });
      this.emit({ type: "status", status: "terminated" });
    });
  }

  private async consume(): Promise<void> {
    if (!this.sdkHandle) return;
    this.emit({ type: "status", status: "running" });
    for await (const msg of this.sdkHandle) {
      if (this.disposed) break;
      this.translate(msg);
    }
    this.emit({ type: "status", status: "terminated" });
  }

  private translate(msg: SDKMessage): void {
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") {
          if (!this._sdkSessionId) {
            this._sdkSessionId = msg.session_id;
            this.emit({
              type: "sdk_session_id",
              sdkSessionId: msg.session_id,
            });
          }
        }
        return;
      case "assistant": {
        const id = (msg as any).uuid ?? nanoid(12);
        const content = msg.message?.content ?? [];
        for (const block of content as Array<any>) {
          if (block.type === "text" && typeof block.text === "string") {
            this.emit({
              type: "assistant_text",
              messageId: id,
              text: block.text,
              done: true,
            });
          } else if (
            block.type === "thinking" &&
            typeof block.thinking === "string"
          ) {
            this.emit({ type: "thinking", text: block.thinking });
          } else if (block.type === "tool_use") {
            this.emit({
              type: "tool_use",
              toolUseId: String(block.id ?? nanoid(12)),
              name: String(block.name ?? "unknown"),
              input: (block.input as Record<string, unknown>) ?? {},
            });
          }
        }
        return;
      }
      case "user": {
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content as Array<any>) {
            if (block.type === "tool_result") {
              const text =
                typeof block.content === "string"
                  ? block.content
                  : Array.isArray(block.content)
                    ? block.content
                        .map((c: any) =>
                          c.type === "text" ? c.text : JSON.stringify(c),
                        )
                        .join("\n")
                    : JSON.stringify(block.content ?? "");
              this.emit({
                type: "tool_result",
                toolUseId: String(block.tool_use_id ?? ""),
                content: text,
                isError: Boolean(block.is_error),
              });
            }
          }
        }
        return;
      }
      case "result": {
        // Diagnostic: log the raw usage payload the SDK actually emits on
        // each turn. The Usage ring's context % depends on
        // `cache_read_input_tokens` + `cache_creation_input_tokens` being
        // present — with prompt caching on, `input_tokens` alone is only a
        // few dozen tokens on warm cache turns and makes the ring read "0%".
        // We've been burned by this blind spot twice; the log is a
        // permanent breadcrumb so future sessions can be diagnosed from the
        // server log alone.
        const rawUsage = (msg as { usage?: unknown }).usage ?? null;
        if (this.opts.logger) {
          this.opts.logger.info(
            { sessionId: this.sessionId, usage: rawUsage },
            "turn_end usage",
          );
        }
        this.emit({
          type: "turn_end",
          stopReason: msg.subtype ?? "end_turn",
          usage: msg.usage
            ? {
                inputTokens: Number((msg.usage as any).input_tokens ?? 0),
                outputTokens: Number((msg.usage as any).output_tokens ?? 0),
                cacheReadInputTokens: Number(
                  (msg.usage as any).cache_read_input_tokens ?? 0,
                ),
                cacheCreationInputTokens: Number(
                  (msg.usage as any).cache_creation_input_tokens ?? 0,
                ),
              }
            : undefined,
        });
        this.emit({ type: "status", status: "idle" });
        return;
      }
    }
  }

  async sendUserMessage(content: string): Promise<void> {
    if (!this.sdkHandle) {
      await this.start(content);
      return;
    }
    this.userMessages.push(userMessage(content));
  }

  resolvePermission(toolUseId: string, decision: PermissionDecision): void {
    const resolver = this.pendingPermissions.get(toolUseId);
    if (!resolver) return;
    this.pendingPermissions.delete(toolUseId);
    resolver(decision);
  }

  resolveAskUserQuestion(
    askId: string,
    answers: Record<string, string>,
    annotations?: Record<string, AskUserQuestionAnnotation>,
  ): void {
    const resolver = this.pendingAskUserQuestion.get(askId);
    if (!resolver) return;
    // Delete BEFORE calling so a second resolve races cleanly (no-op).
    this.pendingAskUserQuestion.delete(askId);
    resolver({ answers, annotations });
  }

  async interrupt(): Promise<void> {
    if (!this.sdkHandle) return;
    await this.sdkHandle.interrupt();
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.permissionMode = mode;
    if (this.sdkHandle) {
      await this.sdkHandle.setPermissionMode(mapPermissionMode(mode));
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.userMessages.close();
    // Reject all outstanding permissions so the SDK loop can exit.
    for (const [id, resolver] of this.pendingPermissions) {
      resolver({ behavior: "deny", reason: "runner disposed" });
    }
    this.pendingPermissions.clear();
    // Resolve any pending AskUserQuestion with empty answers — the SDK doesn't
    // accept a "deny" shape for allow-only tools, and leaving these hanging
    // would keep the query loop alive past dispose().
    for (const [id, resolver] of this.pendingAskUserQuestion) {
      resolver({ answers: {} });
    }
    this.pendingAskUserQuestion.clear();
    try {
      await this.sdkHandle?.interrupt();
    } catch {
      // ignore
    }
    this.listeners.clear();
  }
}

export const agentRunnerFactory: RunnerFactory = {
  create(opts) {
    return new AgentRunner(opts);
  },
};

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// Map our surface permission mode → SDK permission mode.
// Our "auto" isn't yet supported by the SDK; fall back to default so we still
// prompt. MVP is expected to run in "default" or "bypassPermissions".
function mapPermissionMode(mode: PermissionMode): NonNullable<Options["permissionMode"]> {
  switch (mode) {
    case "default":
    case "acceptEdits":
    case "plan":
    case "bypassPermissions":
      return mode;
    case "auto":
      return "default";
    default:
      return "default";
  }
}

type SDKUserMessageShape = SDKUserMessage;

/**
 * Narrow the AskUserQuestion tool input into the shape the rest of claudex
 * uses. The SDK's `AskUserQuestionInput` type is strict (tuples of 2-4
 * options), but at runtime we accept whatever arrives and let the UI render
 * it. Unknown fields pass through verbatim.
 */
function extractAskUserQuestions(
  input: Record<string, unknown>,
): AskUserQuestionItem[] {
  const raw = (input as { questions?: unknown }).questions;
  if (!Array.isArray(raw)) return [];
  const out: AskUserQuestionItem[] = [];
  for (const q of raw) {
    if (!q || typeof q !== "object") continue;
    const qo = q as Record<string, unknown>;
    const question = typeof qo.question === "string" ? qo.question : "";
    if (!question) continue;
    const header = typeof qo.header === "string" ? qo.header : undefined;
    const multiSelect =
      typeof qo.multiSelect === "boolean" ? qo.multiSelect : undefined;
    const options: AskUserQuestionItem["options"] = [];
    if (Array.isArray(qo.options)) {
      for (const opt of qo.options) {
        if (!opt || typeof opt !== "object") continue;
        const oo = opt as Record<string, unknown>;
        if (typeof oo.label !== "string") continue;
        options.push({
          label: oo.label,
          description:
            typeof oo.description === "string" ? oo.description : undefined,
          preview: typeof oo.preview === "string" ? oo.preview : undefined,
        });
      }
    }
    out.push({ question, header, multiSelect, options });
  }
  return out;
}

function userMessage(text: string): SDKUserMessageShape {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    session_id: "",
  } as SDKUserMessageShape;
}

/**
 * Tiny async-iterable queue. Producers call .push(); the iterator resolves
 * when values arrive and terminates when .close() is called.
 */
class AsyncPush<T> {
  private queue: T[] = [];
  private resolvers: Array<(v: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const resolve = this.resolvers.shift();
    if (resolve) resolve({ value, done: false });
    else this.queue.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.resolvers.length) {
      const r = this.resolvers.shift()!;
      r({ value: undefined as any, done: true });
    }
  }

  iterator(): AsyncIterable<T> {
    const self = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
          next(): Promise<IteratorResult<T>> {
            if (self.queue.length > 0) {
              return Promise.resolve({
                value: self.queue.shift()!,
                done: false,
              });
            }
            if (self.closed) {
              return Promise.resolve({ value: undefined as any, done: true });
            }
            return new Promise((res) => self.resolvers.push(res));
          },
          async return(): Promise<IteratorResult<T>> {
            self.close();
            return { value: undefined as any, done: true };
          },
        };
      },
    };
  }
}

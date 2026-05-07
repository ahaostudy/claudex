import { describe, it, expect } from "vitest";
import { AgentRunner } from "../src/sessions/agent-runner.js";
import type { RunnerEvent } from "../src/sessions/runner.js";

/**
 * These tests reach into AgentRunner's private translate() method to exercise
 * the SDK → RunnerEvent mapping deterministically, without spawning a real
 * `claude` subprocess. Unit-level confidence that the wire-format handling
 * matches what the SDK sends lives here; live integration coverage comes
 * later when we can point at a real claude install.
 */
describe("AgentRunner.translate (SDK message → RunnerEvent)", () => {
  function collect(): {
    runner: AgentRunner;
    events: RunnerEvent[];
    translate: (msg: any) => void;
  } {
    const runner = new AgentRunner({
      sessionId: "sess-1",
      cwd: "/tmp",
      model: "claude-opus-4-7",
      permissionMode: "default",
    });
    const events: RunnerEvent[] = [];
    runner.on((e) => events.push(e));
    return {
      runner,
      events,
      translate: (runner as any).translate.bind(runner),
    };
  }

  it("captures sdk session id from system/init", () => {
    const { runner, events, translate } = collect();
    translate({
      type: "system",
      subtype: "init",
      session_id: "sdk-abc-123",
      model: "claude-opus-4-7",
      tools: [],
      cwd: "/tmp",
      mcp_servers: [],
      permissionMode: "default",
    });
    expect(runner.sdkSessionId).toBe("sdk-abc-123");
    expect(events).toContainEqual({
      type: "sdk_session_id",
      sdkSessionId: "sdk-abc-123",
    });
  });

  it("does not overwrite sdk session id on duplicate init", () => {
    const { runner, translate } = collect();
    translate({ type: "system", subtype: "init", session_id: "a" });
    translate({ type: "system", subtype: "init", session_id: "b" });
    expect(runner.sdkSessionId).toBe("a");
  });

  it("maps assistant text blocks", () => {
    const { events, translate } = collect();
    translate({
      type: "assistant",
      uuid: "msg-1",
      message: {
        content: [{ type: "text", text: "hello world" }],
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "assistant_text",
      messageId: "msg-1",
      text: "hello world",
      done: true,
    });
  });

  it("maps thinking blocks", () => {
    const { events, translate } = collect();
    translate({
      type: "assistant",
      uuid: "msg-1",
      message: {
        content: [{ type: "thinking", thinking: "let me check…" }],
      },
    });
    expect(events).toContainEqual({
      type: "thinking",
      text: "let me check…",
    });
  });

  it("maps tool_use blocks with input intact", () => {
    const { events, translate } = collect();
    translate({
      type: "assistant",
      uuid: "msg-1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "tu-1",
            name: "Bash",
            input: { command: "ls -la" },
          },
        ],
      },
    });
    expect(events).toContainEqual({
      type: "tool_use",
      toolUseId: "tu-1",
      name: "Bash",
      input: { command: "ls -la" },
    });
  });

  it("maps tool_result string content", () => {
    const { events, translate } = collect();
    translate({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-1",
            content: "hello\nworld",
            is_error: false,
          },
        ],
      },
    });
    expect(events).toContainEqual({
      type: "tool_result",
      toolUseId: "tu-1",
      content: "hello\nworld",
      isError: false,
    });
  });

  it("maps tool_result with array content (text blocks)", () => {
    const { events, translate } = collect();
    translate({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-2",
            content: [
              { type: "text", text: "line 1" },
              { type: "text", text: "line 2" },
            ],
            is_error: false,
          },
        ],
      },
    });
    expect(events).toContainEqual({
      type: "tool_result",
      toolUseId: "tu-2",
      content: "line 1\nline 2",
      isError: false,
    });
  });

  it("marks tool_result as error when is_error=true", () => {
    const { events, translate } = collect();
    translate({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-3",
            content: "command not found",
            is_error: true,
          },
        ],
      },
    });
    expect(events).toContainEqual({
      type: "tool_result",
      toolUseId: "tu-3",
      content: "command not found",
      isError: true,
    });
  });

  it("maps result message to turn_end and status idle", () => {
    const { events, translate } = collect();
    translate({
      type: "result",
      subtype: "success",
      result: "Done.",
      total_cost_usd: 0,
      usage: { input_tokens: 100, output_tokens: 50 },
      num_turns: 1,
    });
    const kinds = events.map((e) => e.type);
    expect(kinds).toContain("turn_end");
    expect(kinds).toContain("status");
    const turnEnd = events.find((e) => e.type === "turn_end")!;
    expect(turnEnd).toMatchObject({
      type: "turn_end",
      stopReason: "success",
      usage: { inputTokens: 100, outputTokens: 50 },
    });
  });

  it("maps error result subtype", () => {
    const { events, translate } = collect();
    translate({
      type: "result",
      subtype: "error_during_execution",
      errors: ["boom"],
      total_cost_usd: 0,
      num_turns: 1,
    });
    const turnEnd = events.find((e) => e.type === "turn_end")!;
    expect((turnEnd as any).stopReason).toBe("error_during_execution");
  });

  it("ignores unknown message types silently", () => {
    const { events, translate } = collect();
    translate({ type: "system", subtype: "task_progress" });
    translate({ type: "system", subtype: "task_notification" });
    translate({ type: "made_up_type" });
    expect(events).toEqual([]);
  });

  it("ignores malformed assistant blocks instead of crashing", () => {
    const { events, translate } = collect();
    translate({
      type: "assistant",
      uuid: "msg-1",
      message: {
        content: [
          { type: "text" }, // missing text
          { type: "thinking", thinking: 123 as any }, // wrong type
          { type: "totally_unknown", data: 1 },
        ],
      },
    });
    // None of those should emit (text requires string text; thinking requires string)
    expect(events).toEqual([]);
  });
});

describe("AgentRunner.resolvePermission", () => {
  it("resolves the matching pending permission and is a no-op otherwise", async () => {
    const runner = new AgentRunner({
      sessionId: "s1",
      cwd: "/tmp",
      model: "claude-opus-4-7",
      permissionMode: "default",
    });
    const resolutions: Array<{ id: string; behavior: string }> = [];
    // Manually insert a resolver
    const promise = new Promise<void>((done) => {
      (runner as any).pendingPermissions.set("tu-1", (d: any) => {
        resolutions.push({ id: "tu-1", behavior: d.behavior });
        done();
      });
    });
    runner.resolvePermission("bogus", { behavior: "allow" });
    runner.resolvePermission("tu-1", { behavior: "deny", reason: "no" });
    await promise;
    expect(resolutions).toEqual([{ id: "tu-1", behavior: "deny" }]);
    // pending should be cleared
    expect((runner as any).pendingPermissions.size).toBe(0);
  });
});

describe("AgentRunner listener lifecycle", () => {
  it("supports multiple listeners and isolates errors", () => {
    const runner = new AgentRunner({
      sessionId: "s1",
      cwd: "/tmp",
      model: "claude-opus-4-7",
      permissionMode: "default",
    });
    const calls: string[] = [];
    runner.on(() => {
      throw new Error("boom");
    });
    runner.on((e) => calls.push(e.type));
    (runner as any).emit({ type: "status", status: "running" });
    expect(calls).toEqual(["status"]);
    expect(runner.listenerCount()).toBe(2);
  });

  it("unsubscribes listeners via the returned disposer", () => {
    const runner = new AgentRunner({
      sessionId: "s1",
      cwd: "/tmp",
      model: "claude-opus-4-7",
      permissionMode: "default",
    });
    const calls: RunnerEvent[] = [];
    const off = runner.on((e) => calls.push(e));
    (runner as any).emit({ type: "status", status: "idle" });
    off();
    (runner as any).emit({ type: "status", status: "terminated" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ status: "idle" });
    expect(runner.listenerCount()).toBe(0);
  });
});

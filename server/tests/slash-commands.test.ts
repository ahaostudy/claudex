import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  extractDescription,
  listSlashCommands,
  BUILT_IN_SLASH_COMMANDS,
} from "../src/sessions/slash-commands.js";
import { bootstrapAuthedApp } from "./helpers.js";

describe("slash-commands scanner", () => {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    while (disposers.length) disposers.pop()!();
  });

  function mkTmp(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    disposers.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  describe("extractDescription", () => {
    it("prefers YAML frontmatter description", () => {
      const raw = [
        "---",
        "name: foo",
        "description: Does the foo thing",
        "---",
        "",
        "# Heading shouldn't win",
        "body",
      ].join("\n");
      expect(extractDescription(raw)).toBe("Does the foo thing");
    });

    it("strips surrounding quotes on the frontmatter value", () => {
      const raw = ["---", 'description: "Quoted thing"', "---"].join("\n");
      expect(extractDescription(raw)).toBe("Quoted thing");
    });

    it("falls back to a leading `# Heading` line", () => {
      const raw = "# Review the current diff\n\nsome body";
      expect(extractDescription(raw)).toBe("Review the current diff");
    });

    it("falls back to the first non-empty line", () => {
      const raw = "\n\nJust a prose description.\nMore body.\n";
      expect(extractDescription(raw)).toBe("Just a prose description.");
    });

    it("returns null when the file is empty", () => {
      expect(extractDescription("")).toBeNull();
      expect(extractDescription("\n\n  \n")).toBeNull();
    });
  });

  describe("listSlashCommands", () => {
    it("returns only built-ins when the user commands dir is absent", async () => {
      const home = mkTmp("claudex-slash-home-");
      // intentionally do NOT create home/.claude/commands
      const out = await listSlashCommands({
        userClaudeDir: path.join(home, ".claude"),
      });
      expect(out).toHaveLength(BUILT_IN_SLASH_COMMANDS.length);
      expect(out.every((c) => c.kind === "built-in")).toBe(true);
      // Spot-check: the most common commands are present.
      const names = out.map((c) => c.name);
      expect(names).toContain("help");
      expect(names).toContain("clear");
      expect(names).toContain("compact");
      expect(names).toContain("review");
    });

    it("scans user commands and parses frontmatter + heading descriptions", async () => {
      const home = mkTmp("claudex-slash-home-");
      const cmdsDir = path.join(home, ".claude", "commands");
      fs.mkdirSync(cmdsDir, { recursive: true });
      fs.writeFileSync(
        path.join(cmdsDir, "deploy.md"),
        ["---", "description: Deploy the app", "---", "body"].join("\n"),
      );
      fs.writeFileSync(
        path.join(cmdsDir, "refactor.md"),
        "# Refactor this module\n\nBody.\n",
      );
      fs.writeFileSync(
        path.join(cmdsDir, "zzz-blank.md"),
        "", // no description at all
      );
      // Skips: hidden, non-md, subdirectory.
      fs.writeFileSync(path.join(cmdsDir, ".hidden.md"), "# nope");
      fs.writeFileSync(path.join(cmdsDir, "notes.txt"), "not a command");
      fs.mkdirSync(path.join(cmdsDir, "nested"));

      const out = await listSlashCommands({
        userClaudeDir: path.join(home, ".claude"),
      });
      const userCmds = out.filter((c) => c.kind === "user");
      expect(userCmds.map((c) => c.name)).toEqual([
        "deploy",
        "refactor",
        "zzz-blank",
      ]);
      const deploy = userCmds.find((c) => c.name === "deploy")!;
      expect(deploy.description).toBe("Deploy the app");
      expect(deploy.source).toBe(path.join(cmdsDir, "deploy.md"));
      const refactor = userCmds.find((c) => c.name === "refactor")!;
      expect(refactor.description).toBe("Refactor this module");
      const blank = userCmds.find((c) => c.name === "zzz-blank")!;
      expect(blank.description).toBeNull();
    });

    it("includes project commands when projectPath is given", async () => {
      const home = mkTmp("claudex-slash-home-");
      const projRoot = mkTmp("claudex-slash-proj-");
      const projCmds = path.join(projRoot, ".claude", "commands");
      fs.mkdirSync(projCmds, { recursive: true });
      fs.writeFileSync(
        path.join(projCmds, "bench.md"),
        "# Run benchmarks\n",
      );

      const out = await listSlashCommands({
        userClaudeDir: path.join(home, ".claude"),
        projectPath: projRoot,
      });
      const projOut = out.filter((c) => c.kind === "project");
      expect(projOut).toHaveLength(1);
      expect(projOut[0].name).toBe("bench");
      expect(projOut[0].description).toBe("Run benchmarks");
      expect(projOut[0].source).toBe(path.join(projCmds, "bench.md"));

      // Bucket order: built-in first, then project (no user cmds here).
      const firstProjectIdx = out.findIndex((c) => c.kind === "project");
      const lastBuiltinIdx = out.reduce(
        (acc, c, i) => (c.kind === "built-in" ? i : acc),
        -1,
      );
      expect(firstProjectIdx).toBeGreaterThan(lastBuiltinIdx);
    });

    it("omits project commands when projectPath is not given", async () => {
      const home = mkTmp("claudex-slash-home-");
      const projRoot = mkTmp("claudex-slash-proj-");
      const projCmds = path.join(projRoot, ".claude", "commands");
      fs.mkdirSync(projCmds, { recursive: true });
      fs.writeFileSync(path.join(projCmds, "bench.md"), "# Run benches\n");

      const out = await listSlashCommands({
        userClaudeDir: path.join(home, ".claude"),
      });
      expect(out.some((c) => c.kind === "project")).toBe(false);
    });
  });
});

describe("GET /api/slash-commands", () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  function mkTmpDir(prefix: string, cleanup: Array<() => Promise<void>>) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    cleanup.push(async () =>
      fs.rmSync(dir, { recursive: true, force: true }),
    );
    return dir;
  }

  it("requires auth", async () => {
    // Point userClaudeDir at an empty tmp so the production ~/.claude isn't
    // read even if the auth gate regresses.
    const home = mkTmpDir("claudex-slash-home-", disposers);
    const ctx = await bootstrapAuthedApp(undefined, {
      userClaudeDir: path.join(home, ".claude"),
    });
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/slash-commands",
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns built-ins only when the user commands dir is absent", async () => {
    const home = mkTmpDir("claudex-slash-home-", disposers);
    const ctx = await bootstrapAuthedApp(undefined, {
      userClaudeDir: path.join(home, ".claude"),
    });
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/slash-commands",
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { commands: Array<{ kind: string }> };
    expect(body.commands.length).toBe(BUILT_IN_SLASH_COMMANDS.length);
    expect(body.commands.every((c) => c.kind === "built-in")).toBe(true);
  });

  it("returns user commands when the commands dir has .md files", async () => {
    const home = mkTmpDir("claudex-slash-home-", disposers);
    const cmdsDir = path.join(home, ".claude", "commands");
    fs.mkdirSync(cmdsDir, { recursive: true });
    fs.writeFileSync(
      path.join(cmdsDir, "ship.md"),
      ["---", "description: Ship it", "---"].join("\n"),
    );

    const ctx = await bootstrapAuthedApp(undefined, {
      userClaudeDir: path.join(home, ".claude"),
    });
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/slash-commands",
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      commands: Array<{ name: string; kind: string; description: string | null }>;
    };
    const ship = body.commands.find((c) => c.name === "ship");
    expect(ship).toBeDefined();
    expect(ship!.kind).toBe("user");
    expect(ship!.description).toBe("Ship it");
  });

  it("includes project commands when projectId is given", async () => {
    const home = mkTmpDir("claudex-slash-home-", disposers);
    const ctx = await bootstrapAuthedApp(undefined, {
      userClaudeDir: path.join(home, ".claude"),
    });
    disposers.push(ctx.cleanup);

    // The tmpDir that bootstrap gives us is a fine project root.
    const projCmds = path.join(ctx.tmpDir, ".claude", "commands");
    fs.mkdirSync(projCmds, { recursive: true });
    fs.writeFileSync(path.join(projCmds, "bench.md"), "# Run benchmarks\n");

    const createRes = await ctx.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: ctx.cookie },
      payload: { name: "proj", path: ctx.tmpDir },
    });
    expect(createRes.statusCode).toBe(200);
    const projId = createRes.json().project.id as string;

    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/slash-commands?projectId=${encodeURIComponent(projId)}`,
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      commands: Array<{ name: string; kind: string }>;
    };
    const bench = body.commands.find((c) => c.name === "bench");
    expect(bench).toBeDefined();
    expect(bench!.kind).toBe("project");
  });

  it("soft-ignores an unknown projectId — still returns built-ins", async () => {
    const home = mkTmpDir("claudex-slash-home-", disposers);
    const ctx = await bootstrapAuthedApp(undefined, {
      userClaudeDir: path.join(home, ".claude"),
    });
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/slash-commands?projectId=does-not-exist",
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { commands: Array<{ kind: string }> };
    expect(body.commands.length).toBe(BUILT_IN_SLASH_COMMANDS.length);
    expect(body.commands.every((c) => c.kind === "built-in")).toBe(true);
  });
});

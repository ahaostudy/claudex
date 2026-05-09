import { describe, it, expect, afterEach } from "vitest";
import { bootstrapAuthedApp } from "./helpers.js";
import type { MetaResponse } from "@claudex/shared";

// ---------------------------------------------------------------------------
// Meta route — powers the About screen. Thin surface; test that auth is
// enforced and that the shape returned is what `@claudex/shared::MetaResponse`
// claims (string version, nullable commit fields, numeric uptime, sqlite
// version actually looks like a sqlite version).
// ---------------------------------------------------------------------------

describe("meta routes", () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  it("requires auth", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/meta",
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns version, platform, sqlite, node, and uptime", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/meta",
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as MetaResponse;

    // Version — `@claudex/server/package.json#version`. We don't pin the
    // value (it bumps with releases) but insist on the shape.
    expect(typeof body.version).toBe("string");
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);

    // Commit fields are either both null or both non-null; commitShort is
    // the first 7 chars of commit when present.
    if (body.commit === null) {
      expect(body.commitShort).toBeNull();
    } else {
      expect(body.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(body.commitShort).toBe(body.commit.slice(0, 7));
    }

    // buildTime is always ISO-ish. Node's Date constructor round-trips.
    expect(typeof body.buildTime).toBe("string");
    expect(Number.isNaN(Date.parse(body.buildTime))).toBe(false);

    // nodeVersion should match process.versions.node exactly — no `v` prefix.
    expect(body.nodeVersion).toBe(process.versions.node);

    // sqliteVersion is dotted semver-ish.
    expect(body.sqliteVersion).toMatch(/^\d+\.\d+\.\d+/);

    // platform has the form `${os.platform()} ${os.arch()}`.
    expect(body.platform.split(" ")).toHaveLength(2);

    // uptimeSec is a non-negative integer. Tests boot quickly, so it should
    // be < 60 on a sane CI — but we only enforce non-negativity here, since
    // the ≥ bound is what actually matters for the shape.
    expect(Number.isFinite(body.uptimeSec)).toBe(true);
    expect(body.uptimeSec).toBeGreaterThanOrEqual(0);
  });
});

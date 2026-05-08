import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { bootstrapAuthedApp } from "./helpers.js";
import type { LinkPreview } from "@claudex/shared";

// ---------------------------------------------------------------------------
// GET /api/link-preview — login-gated URL preview card fetcher.
//
// We stub `fetch` with `vi.stubGlobal` so no test ever hits the real
// network. Each case installs its own stub and asserts the route honors:
//   - auth wall (401 unauth)
//   - URL shape + private-IP blocklist (400)
//   - successful parse of a mocked HTML body
//   - cache hit avoids a second upstream call
//   - failed upstream is cached with 1h TTL (no upstream call within that
//     window, route still returns the right error)
//   - per-user rate limit trips after RATE_LIMIT_MAX
// ---------------------------------------------------------------------------

type Ctx = Awaited<ReturnType<typeof bootstrapAuthedApp>>;

const HTML = `
<!doctype html><html><head>
<meta property="og:title" content="Anthropic">
<meta property="og:description" content="Claude is an AI assistant.">
<meta property="og:image" content="https://example.com/og.png">
<meta property="og:site_name" content="Anthropic">
<title>Anthropic — Fallback</title>
</head><body>ignored</body></html>`;

function okHtml(body = HTML): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

describe("link preview routes", () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    vi.unstubAllGlobals();
    while (disposers.length) await disposers.pop()!();
  });

  beforeEach(() => {
    // Default stub: any test that doesn't replace this gets a predictable
    // failure so we don't accidentally hit the real internet.
    vi.stubGlobal("fetch", async () => {
      throw new Error("no fetch stub installed in test");
    });
  });

  it("401s unauthenticated callers", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/link-preview?url=" + encodeURIComponent("https://example.com"),
    });
    expect(res.statusCode).toBe(401);
  });

  it("400s on private / non-http URLs", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const bads = [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "ftp://example.com",
      "http://127.0.0.1",
      "http://localhost:8080/metrics",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.1",
      "http://192.168.1.1",
      "http://172.16.0.1",
      "http://[::1]",
      "http://foo.local",
      "not a url at all",
      "",
    ];
    for (const url of bads) {
      const res = await ctx.app.inject({
        method: "GET",
        url:
          "/api/link-preview" +
          (url ? "?url=" + encodeURIComponent(url) : ""),
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode, `expected 400 for ${url}`).toBe(400);
    }
  });

  it("parses og tags from a known HTML response", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    vi.stubGlobal("fetch", vi.fn(async () => okHtml()));

    const res = await ctx.app.inject({
      method: "GET",
      url:
        "/api/link-preview?url=" + encodeURIComponent("https://example.com/x"),
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as LinkPreview;
    expect(body.url).toBe("https://example.com/x");
    expect(body.title).toBe("Anthropic");
    expect(body.description).toBe("Claude is an AI assistant.");
    expect(body.image).toBe("https://example.com/og.png");
    expect(body.siteName).toBe("Anthropic");
    expect(typeof body.fetchedAt).toBe("string");
  });

  it("serves a second hit from cache without fetching", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const spy = vi.fn(async () => okHtml());
    vi.stubGlobal("fetch", spy);

    const url =
      "/api/link-preview?url=" + encodeURIComponent("https://example.com/cached");
    const r1 = await ctx.app.inject({
      method: "GET",
      url,
      headers: { cookie: ctx.cookie },
    });
    expect(r1.statusCode).toBe(200);
    const r2 = await ctx.app.inject({
      method: "GET",
      url,
      headers: { cookie: ctx.cookie },
    });
    expect(r2.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    // Same fetchedAt on both — they're the same row.
    expect((r1.json() as LinkPreview).fetchedAt).toBe(
      (r2.json() as LinkPreview).fetchedAt,
    );
  });

  it("caches a failed fetch (negative cache) and does not re-fetch within the TTL", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const spy = vi.fn(
      async () => new Response("nope", { status: 500 }),
    );
    vi.stubGlobal("fetch", spy);

    const url =
      "/api/link-preview?url=" +
      encodeURIComponent("https://example.com/broken");
    const r1 = await ctx.app.inject({
      method: "GET",
      url,
      headers: { cookie: ctx.cookie },
    });
    expect(r1.statusCode).toBe(502);
    const r2 = await ctx.app.inject({
      method: "GET",
      url,
      headers: { cookie: ctx.cookie },
    });
    expect(r2.statusCode).toBe(502);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("trips the rate limit after 60 previews", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    // Always return something uncached so every call hits the limiter.
    vi.stubGlobal("fetch", vi.fn(async () => okHtml()));

    let lastStatus = 0;
    let limited = false;
    for (let i = 0; i < 62; i++) {
      const res = await ctx.app.inject({
        method: "GET",
        url:
          "/api/link-preview?url=" +
          encodeURIComponent(`https://example.com/u${i}`),
        headers: { cookie: ctx.cookie },
      });
      lastStatus = res.statusCode;
      if (res.statusCode === 429) {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
    expect(lastStatus).toBe(429);
  });
});

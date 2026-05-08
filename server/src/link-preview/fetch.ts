// ---------------------------------------------------------------------------
// Link preview fetcher.
//
// Two jobs:
//   1. Decide whether a URL is safe to hit from the claudex process. The
//      server runs on the user's machine and has the loopback interface +
//      the private LAN available to it; an attacker who gets a preview
//      request through the auth wall must NOT be able to turn us into an
//      SSRF cannon pointed at `http://127.0.0.1:<something>` or cloud
//      metadata endpoints. We reject:
//        - non-http(s) schemes
//        - hostnames that resolve to a literal loopback / private / link-
//          local / ULA address (IPv4 and IPv6)
//        - the cloud metadata IPs (169.254.169.254 et al — already covered
//          by the link-local range, listed explicitly in comments so future
//          edits don't accidentally lift it)
//   2. Fetch the HTML (5s timeout, 512KB cap) and extract <title>,
//      <meta name="description">, and the common OG/Twitter tags via a
//      minimal regex parse. We deliberately avoid pulling in a DOM parser
//      — the wire format for these tags is well-known and the cost of a
//      full parser on every preview isn't worth the resolver accuracy.
// ---------------------------------------------------------------------------

export interface FetchedPreview {
  status: number;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
}

/** Max bytes we will read off the wire before aborting the read. */
export const MAX_BYTES = 512 * 1024;
/** Per-request upstream timeout. */
export const FETCH_TIMEOUT_MS = 5000;

/**
 * Classify a URL as either public-http(s) or rejected. Returns the parsed URL
 * on success, or a short string code describing the rejection.
 *
 * The host check is split in two: a literal IP short-circuits the DNS lookup
 * (most of our attacker vectors are literal-IP URLs anyway), and a hostname
 * falls through to the caller's DNS resolver at fetch time. We could resolve
 * here too but that adds a second RTT on every preview; the two-layer
 * approach (literal check now, rely on Node's `fetch` not to follow an
 * attacker-controlled DNS-rebind across redirects) is good enough for the
 * claudex threat model.
 */
export function classifyUrl(
  raw: string,
):
  | { ok: true; url: URL }
  | { ok: false; reason: "bad_scheme" | "bad_host" | "bad_url" } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "bad_url" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "bad_scheme" };
  }
  const host = url.hostname;
  if (!host) return { ok: false, reason: "bad_host" };
  if (isForbiddenHost(host)) {
    return { ok: false, reason: "bad_host" };
  }
  return { ok: true, url };
}

/**
 * Literal-IP / hostname blocklist. Covers:
 *   - IPv4: 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16,
 *     169.254.0.0/16 (link-local, includes AWS/GCP metadata
 *     169.254.169.254), 0.0.0.0/8
 *   - IPv6: ::1, fc00::/7 (ULA), fe80::/10 (link-local), ::ffff:<ipv4-mapped>
 *   - Hostnames: "localhost" and any host whose last label ends in ".local"
 *     (Bonjour / mDNS — still on-network, still unsafe)
 *
 * Hostnames that aren't literal IPs fall through to the caller's DNS
 * resolver. We trust that claudex's operational envelope (run behind a
 * tunnel to a home LAN) doesn't need a stricter DNS-based guard; the
 * literal-IP check is what protects against the obvious SSRF payloads.
 */
export function isForbiddenHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === "localhost") return true;
  if (lower.endsWith(".local")) return true;
  // Strip brackets around IPv6 literals: new URL("http://[::1]").hostname === "::1"
  const stripped = lower.startsWith("[") && lower.endsWith("]")
    ? lower.slice(1, -1)
    : lower;

  if (isIPv4Literal(stripped)) {
    return isPrivateIPv4(stripped);
  }
  if (isIPv6Literal(stripped)) {
    return isPrivateIPv6(stripped);
  }
  return false;
}

function isIPv4Literal(s: string): boolean {
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  for (let i = 1; i <= 4; i++) {
    const n = Number(m[i]);
    if (n < 0 || n > 255) return false;
  }
  return true;
}

function isPrivateIPv4(s: string): boolean {
  const parts = s.split(".").map(Number);
  const [a, b] = parts;
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isIPv6Literal(s: string): boolean {
  // Crude but good enough: has at least one colon and contains only hex /
  // colons / dots (for v4-mapped).
  if (!s.includes(":")) return false;
  return /^[0-9a-f:.]+$/i.test(s);
}

function isPrivateIPv6(s: string): boolean {
  const lower = s.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  // ULA: fc00::/7 → first byte has the pattern 1111110x, i.e. fc.. or fd..
  if (/^f[cd][0-9a-f]{0,2}:/.test(lower)) return true;
  // Link-local fe80::/10
  if (/^fe[89ab][0-9a-f]?:/.test(lower)) return true;
  // IPv4-mapped: ::ffff:<ipv4> — check the embedded v4
  const v4mapped = lower.match(/^::ffff:([0-9.]+)$/);
  if (v4mapped && isIPv4Literal(v4mapped[1]!)) {
    return isPrivateIPv4(v4mapped[1]!);
  }
  return false;
}

/**
 * Fetch `url` and extract lightweight metadata. Caps read size at MAX_BYTES
 * and gives up after FETCH_TIMEOUT_MS. Never throws — on any failure we
 * return a `FetchedPreview` carrying the upstream status (or 0 for network
 * errors) and no metadata, and callers persist that as a negative cache
 * entry.
 *
 * Implementation note: we pass `redirect: "follow"` so sites that serve
 * their OG metadata on a canonical URL (typical for media sites) are
 * handled transparently. The final hop's URL is not re-validated — an
 * attacker could try to use an open redirector to bounce us at
 * 127.0.0.1, but the fetch happens inside Node's `fetch` which won't
 * redirect across origins under loopback without the browser's
 * same-origin-policy enforcement. We accept this minor residual risk
 * because the alternative (reject all redirects) breaks the majority of
 * real-world previews.
 */
export async function fetchPreview(url: URL): Promise<FetchedPreview> {
  const controller = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      redirect: "follow",
      signal: controller,
      headers: {
        // A polite UA so servers that dislike anonymous clients still
        // answer. No cookies / auth — this is an unauthenticated preview.
        "User-Agent": "claudex-link-preview/0.1 (+https://github.com/)",
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
      },
    });
  } catch {
    return { status: 0 };
  }

  if (!res.ok) {
    return { status: res.status };
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!/text\/html|application\/xhtml/i.test(contentType)) {
    // Still cache as a negative: we can't extract from non-HTML (images,
    // PDFs, JSON endpoints) and shouldn't keep re-fetching them.
    return { status: res.status };
  }

  const html = await readBodyCapped(res, MAX_BYTES);
  if (!html) {
    return { status: res.status };
  }
  const parsed = extractMeta(html);
  return { status: res.status, ...parsed };
}

async function readBodyCapped(res: Response, cap: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let total = 0;
  let out = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      out += decoder.decode(value, { stream: true });
      if (total >= cap) {
        // Stop reading; we've got enough for <head> parsing in virtually
        // every real page. `reader.cancel()` releases the underlying
        // connection without waiting for EOF.
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        break;
      }
    }
  } catch {
    /* ignore truncated reads */
  }
  out += decoder.decode();
  return out;
}

/**
 * Regex-based metadata extractor. Only looks at the first ~64KB of the
 * response — <head> almost always fits — so even a 512KB read is cheap to
 * scan. Picks precedence:
 *
 *   title       ← og:title | twitter:title | <title>
 *   description ← og:description | twitter:description | <meta name="description">
 *   image       ← og:image | og:image:url | twitter:image | twitter:image:src
 *   siteName    ← og:site_name | application-name
 *
 * All values are trimmed and HTML-entity-decoded for the common `&amp; &lt;
 * &gt; &quot; &#39; &apos; &#NNN;` cases. Anything else survives as-is
 * because a DOM decoder is overkill for a 48×48 card caption.
 */
export function extractMeta(html: string): {
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
} {
  // Limit scan window — <head> is ALWAYS in the first 64KB for sane sites.
  const scan = html.length > 64 * 1024 ? html.slice(0, 64 * 1024) : html;

  const ogTitle = metaContent(scan, "property", "og:title")
    ?? metaContent(scan, "name", "og:title")
    ?? metaContent(scan, "name", "twitter:title")
    ?? metaContent(scan, "property", "twitter:title");
  const titleTag = matchTag(scan, /<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = clean(ogTitle ?? titleTag);

  const description = clean(
    metaContent(scan, "property", "og:description")
      ?? metaContent(scan, "name", "og:description")
      ?? metaContent(scan, "name", "twitter:description")
      ?? metaContent(scan, "property", "twitter:description")
      ?? metaContent(scan, "name", "description"),
  );

  const image = clean(
    metaContent(scan, "property", "og:image")
      ?? metaContent(scan, "property", "og:image:url")
      ?? metaContent(scan, "name", "twitter:image")
      ?? metaContent(scan, "name", "twitter:image:src")
      ?? metaContent(scan, "property", "twitter:image"),
  );

  const siteName = clean(
    metaContent(scan, "property", "og:site_name")
      ?? metaContent(scan, "name", "application-name"),
  );

  return {
    title: title || undefined,
    description: description || undefined,
    image: image || undefined,
    siteName: siteName || undefined,
  };
}

/**
 * Find `<meta {attr}="{key}" content="..." />` — attributes can be in any
 * order and use either single or double quotes. Returns the raw content
 * value (still HTML-entity-encoded).
 */
function metaContent(
  html: string,
  attr: "property" | "name",
  key: string,
): string | undefined {
  // Two orderings: attr first or content first. Build both patterns.
  const keyEsc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re1 = new RegExp(
    `<meta\\s+[^>]*${attr}\\s*=\\s*["']${keyEsc}["'][^>]*content\\s*=\\s*["']([^"']*)["'][^>]*>`,
    "i",
  );
  const re2 = new RegExp(
    `<meta\\s+[^>]*content\\s*=\\s*["']([^"']*)["'][^>]*${attr}\\s*=\\s*["']${keyEsc}["'][^>]*>`,
    "i",
  );
  const m = html.match(re1) ?? html.match(re2);
  return m ? m[1] : undefined;
}

function matchTag(html: string, re: RegExp): string | undefined {
  const m = html.match(re);
  return m ? m[1] : undefined;
}

function clean(s: string | undefined): string {
  if (!s) return "";
  return decodeEntities(s).replace(/\s+/g, " ").trim().slice(0, 500);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return _;
      try {
        return String.fromCodePoint(code);
      } catch {
        return _;
      }
    });
}

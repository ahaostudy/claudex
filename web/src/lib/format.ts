// Shared formatters. Keep this file small and side-effect-free — it is
// imported from both leaf components and screens.
//
// Historical note: prior to consolidation each of Settings / ImportSessionsSheet
// / SessionSettingsSheet carried its own near-identical relative-time or
// bytes formatter. The inputs differed slightly (raw ISO strings vs Date
// objects, some tolerated null, others threw) and thresholds drifted enough
// that the UI output was subtly inconsistent. This module picks one clean
// variant of each and every caller now uses it.

/** "2m ago" / "5h ago" / "3d ago" — short form. */
export function timeAgoShort(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  const t = typeof iso === "string" ? Date.parse(iso) : iso.getTime();
  const delta = Math.max(0, Date.now() - t);
  const s = Math.floor(delta / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  // fall back to YYYY-MM-DD for old items
  return new Date(t).toISOString().slice(0, 10);
}

/** "2 minutes ago" etc — long form, for audit rows and similar. */
export function timeAgoLong(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  const t = typeof iso === "string" ? Date.parse(iso) : iso.getTime();
  const delta = Math.max(0, Date.now() - t);
  const s = Math.floor(delta / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} day${d === 1 ? "" : "s"} ago`;
  return new Date(t).toLocaleDateString();
}

/** Bytes → short human-readable ("4.2 KB"). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

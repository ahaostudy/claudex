// Image extraction helpers.
//
// Transcript events can carry images in a couple of shapes:
//   1. A base64 data URL embedded in a tool_result or user_message content
//      string — `data:image/(png|jpeg|jpg|gif|webp);base64,...`.
//   2. A `/api/attachments/:id/raw` path pointing at the attachments feature.
//
// `extractImagesFromText` finds both, returns an ImageRef[] and the same
// text with the matched tokens stripped so the caller can render them as
// thumbnails above the remaining (now image-free) text body.
//
// The regexes are intentionally narrow and anchored to token characters so
// they don't catch URL fragments mid-word or produce quadratic backtracking
// on large tool_result bodies. The caller should still `useMemo` per-piece
// — we're not reaching for this helper in a hot render loop.

export interface ImageRef {
  src: string;
  alt: string;
}

// Base64 data URL for a supported image mime. We allow the common image/*
// families claude can emit (PNG screenshots, JPEG photos, GIFs, WebP).
// Base64 chars + padding only — stops at the first non-base64 character so
// neighboring text is preserved.
const DATA_URL_RE =
  /data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+/g;

// Attachment reference served by the backend. We don't know the id format
// (the attachments feature is in flight), so we match any non-slash id.
const ATTACHMENT_RE = /\/api\/attachments\/[^/\s)"'<>]+\/raw/g;

export function extractImagesFromText(text: string): {
  images: ImageRef[];
  remainingText: string;
} {
  if (!text) return { images: [], remainingText: text };
  // Fast path: if neither marker is present, short-circuit.
  if (!text.includes("data:image/") && !text.includes("/api/attachments/")) {
    return { images: [], remainingText: text };
  }
  const images: ImageRef[] = [];
  let remaining = text;

  // Strip data URLs first (longer, more specific).
  remaining = remaining.replace(DATA_URL_RE, (match) => {
    images.push({ src: match, alt: mimeFromDataUrl(match) ?? "image" });
    return "";
  });
  remaining = remaining.replace(ATTACHMENT_RE, (match) => {
    images.push({ src: match, alt: "attachment" });
    return "";
  });

  return { images, remainingText: remaining };
}

function mimeFromDataUrl(url: string): string | null {
  const m = url.match(/^data:(image\/[a-z]+);/);
  return m ? m[1] : null;
}

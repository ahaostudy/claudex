// Click-to-expand image overlay used by the Chat transcript when a
// tool_result or user_message contains an inline image.
//
// Behaviour:
//   - Fixed full-viewport overlay (z-60), dark/translucent backdrop.
//   - Centred <img> scaled to max 90vw / 85vh, `object-contain` so the full
//     image is visible without distortion.
//   - Closes on: clicking the backdrop, the X button, or pressing Escape.
//   - If more than one image is in the set, left/right arrows (both on-screen
//     and keyboard) step through them.
//   - Download button uses a plain <a download> so data URLs / remote blobs
//     use the browser's native download flow — no Blob juggling.

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Download, X } from "lucide-react";
import type { ImageRef } from "@/lib/images";
import { useFocusReturn } from "@/hooks/useFocusReturn";

export function ImageLightbox({
  images,
  initialIndex,
  onClose,
}: {
  images: ImageRef[];
  initialIndex: number;
  onClose: () => void;
}) {
  useFocusReturn();
  const [index, setIndex] = useState(() =>
    Math.max(0, Math.min(initialIndex, images.length - 1)),
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (images.length <= 1) return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        setIndex((i) => (i + 1) % images.length);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setIndex((i) => (i - 1 + images.length) % images.length);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, images.length]);

  if (images.length === 0) return null;
  const current = images[index];
  const multi = images.length > 1;

  return (
    <div
      className="fixed inset-0 z-[60] bg-ink/80 backdrop-blur-sm flex items-center justify-center"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Image preview"
    >
      {/* Top-right controls: Download + Close */}
      <div
        className="absolute top-3 right-3 flex items-center gap-2"
        onClick={(e) => e.stopPropagation()}
      >
        <a
          href={current.src}
          download
          title="Download image"
          aria-label="Download image"
          className="h-9 w-9 rounded-full bg-canvas/90 border border-line flex items-center justify-center hover:bg-canvas"
        >
          <Download className="w-4 h-4 text-ink" />
        </a>
        <button
          type="button"
          onClick={onClose}
          title="Close"
          aria-label="Close image preview"
          className="h-9 w-9 rounded-full bg-canvas/90 border border-line flex items-center justify-center hover:bg-canvas"
        >
          <X className="w-4 h-4 text-ink" />
        </button>
      </div>

      {multi && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setIndex((i) => (i - 1 + images.length) % images.length);
          }}
          className="absolute left-3 top-1/2 -translate-y-1/2 h-10 w-10 rounded-full bg-canvas/90 border border-line flex items-center justify-center hover:bg-canvas"
          aria-label="Previous image"
        >
          <ChevronLeft className="w-5 h-5 text-ink" />
        </button>
      )}

      <img
        src={current.src}
        alt={current.alt}
        onClick={(e) => e.stopPropagation()}
        className="max-w-[90vw] max-h-[85vh] object-contain rounded-[8px] shadow-lift"
      />

      {multi && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setIndex((i) => (i + 1) % images.length);
          }}
          className="absolute right-3 top-1/2 -translate-y-1/2 h-10 w-10 rounded-full bg-canvas/90 border border-line flex items-center justify-center hover:bg-canvas"
          aria-label="Next image"
        >
          <ChevronRight className="w-5 h-5 text-ink" />
        </button>
      )}

      {multi && (
        <div
          className="absolute bottom-4 left-1/2 -translate-x-1/2 mono text-[11px] text-canvas/80 bg-ink/60 border border-canvas/10 px-2 py-1 rounded-full"
          onClick={(e) => e.stopPropagation()}
        >
          {index + 1} / {images.length}
        </div>
      )}
    </div>
  );
}

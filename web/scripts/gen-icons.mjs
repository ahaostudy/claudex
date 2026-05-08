#!/usr/bin/env node
// Render claudex PWA icons from web/public/icon.svg.
//
// Produces three PNGs next to the SVG:
//   icon-192.png            - 192x192 standard
//   icon-512.png            - 512x512 standard
//   icon-maskable-512.png   - 512x512 with a safe-zone padded triangle so
//                             Android's maskable clipping doesn't eat the
//                             logo's tips
//
// Run manually when the logo changes:
//   node web/scripts/gen-icons.mjs
// Not wired into `build` so `pnpm build` stays deterministic and doesn't
// require sharp at install time in CI.

import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.resolve(here, "..", "public");
const src = path.join(pub, "icon.svg");

if (!fs.existsSync(src)) {
  console.error(`missing ${src}`);
  process.exit(1);
}

const svg = fs.readFileSync(src);

async function render(size, out) {
  await sharp(svg, { density: 300 })
    .resize(size, size, { kernel: "mitchell" })
    .png()
    .toFile(out);
  console.log(`wrote ${out}`);
}

// Maskable icon: Android crops icons to various shapes (circle, squircle)
// and only guarantees the inner ~80% is safe. We inflate the background
// and shrink the triangle to fit that safe zone.
async function renderMaskable(size, out) {
  const maskableSvg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <rect width="100" height="100" fill="#faf9f5" />
      <g transform="translate(20 20) scale(1.875)">
        <path d="M9 22 L16 8 L23 22 Z" fill="#cc785c" />
        <circle cx="16" cy="18" r="2.2" fill="#faf9f5" />
      </g>
    </svg>
  `;
  await sharp(Buffer.from(maskableSvg), { density: 300 })
    .resize(size, size, { kernel: "mitchell" })
    .png()
    .toFile(out);
  console.log(`wrote ${out}`);
}

await render(192, path.join(pub, "icon-192.png"));
await render(512, path.join(pub, "icon-512.png"));
await renderMaskable(512, path.join(pub, "icon-maskable-512.png"));

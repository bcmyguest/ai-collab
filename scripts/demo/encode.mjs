#!/usr/bin/env node
/**
 * Turns a recording (frames + timeline.json from record.mjs) into an animated GIF:
 * speed marks compress waits, camera marks ease the crop toward the element of interest,
 * each frame sits in a phone frame under its caption, and only changed pixels are re-encoded.
 * Usage: node scripts/demo/encode.mjs <recording-dir> [out.gif] [--stills 4,9.5] (stills: PNGs at those output seconds)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import gifenc from "gifenc";

const { GIFEncoder, quantize, applyPalette } = gifenc;

export const VIEWPORT = { width: 390, height: 844 };
const SCALE = 1;
const SCREEN_W = Math.round(VIEWPORT.width * SCALE);
const SCREEN_H = Math.round(VIEWPORT.height * SCALE);
const BEZEL = 8;
const SIDE = 40;
const BAND = 124;
// Output canvas and where the phone screen sits on it, in output pixels.
export const LAYOUT = {
  width: SCREEN_W + 2 * (BEZEL + SIDE),
  height: BAND + SCREEN_H + 2 * BEZEL + 32,
  screen: { left: SIDE + BEZEL, top: BAND + BEZEL, width: SCREEN_W, height: SCREEN_H, radius: 34 },
  bezel: BEZEL,
};
export const FPS = 10;
const MAX_BYTES = 8 * 1024 * 1024; // above this, re-encode at 2 fps less
const MIN_FPS = 6;
const EASE_S = 0.8;
const TITLE_S = 2.0;
const END_S = 1.8;
const FADE_S = 0.35;
const DIFF = 4; // per-channel change below this keeps the previous pixel

const ease = (x) => x <= 0 ? 0 : x >= 1 ? 1 : x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
const lerp = (a, b, k) => a + (b - a) * k;
const FULL = { x: 0, y: 0, w: VIEWPORT.width, h: VIEWPORT.height };

// Source time (ms, wall clock) → output time (s), from piecewise-constant speed marks.
function timeMap(speeds, t0) {
  const marks = [{ t: t0, speed: 1 }, ...speeds.filter((m) => m.t > t0)];
  const at = [0];
  for (let i = 1; i < marks.length; i++) at.push(at[i - 1] + (marks[i].t - marks[i - 1].t) / 1000 / marks[i - 1].speed);
  const out = (t) => { let i = marks.length - 1; while (i > 0 && marks[i].t > t) i--; return at[i] + (t - marks[i].t) / 1000 / marks[i].speed; };
  const back = (o) => { let i = marks.length - 1; while (i > 0 && at[i] > o) i--; return marks[i].t + (o - at[i]) * 1000 * marks[i].speed; };
  return { out, back };
}

// Eased crop rectangle (CSS px) at each output time; each camera mark starts a new ease from wherever the camera is.
function cameraPath(cameras, map) {
  const marks = cameras.map((m) => ({ o: map.out(m.t), rect: m.rect || FULL })).sort((a, b) => a.o - b.o);
  let i = 0, from = FULL, to = FULL, start = -Infinity;
  const value = (o) => { const k = ease((o - start) / EASE_S); return { x: lerp(from.x, to.x, k), y: lerp(from.y, to.y, k), w: lerp(from.w, to.w, k), h: lerp(from.h, to.h, k) }; };
  return (o) => {
    while (i < marks.length && marks[i].o <= o) { from = value(marks[i].o); to = marks[i].rect; start = marks[i].o; i++; }
    return value(o);
  };
}

async function roundedMask({ width, height, radius }) {
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="${radius}" fill="#fff"/></svg>`)).png().toBuffer();
}

const raw = (img) => img.ensureAlpha().raw().toBuffer();

// One composited RGBA frame: the crop of the source frame, rounded, on the caption's stage.
async function compose(file, rect, stage, mask, frameScale) {
  const s = LAYOUT.screen;
  const left = Math.max(0, Math.round(rect.x * frameScale));
  const top = Math.max(0, Math.round(rect.y * frameScale));
  const meta = await sharp(file).metadata();
  const width = Math.min(meta.width - left, Math.round(rect.w * frameScale));
  const height = Math.min(meta.height - top, Math.round(rect.h * frameScale));
  const screen = await sharp(file).extract({ left, top, width, height }).resize(s.width, s.height, { fit: "fill", kernel: "lanczos3" })
    .composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
  return raw(sharp(stage).composite([{ input: screen, left: s.left, top: s.top }]));
}

function mix(a, b, k) {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i] - a[i]) * k;
  return out;
}

// GIF writer that re-encodes only changed pixels (the rest transparent) with a palette fit to them.
function gifWriter({ width, height }) {
  const gif = GIFEncoder();
  let shown = null, pending = null, frames = 0;
  const flush = () => {
    if (!pending) return;
    gif.writeFrame(pending.index, width, height, { palette: pending.palette, delay: pending.delay, transparent: pending.transparent, transparentIndex: pending.transparentIndex, dispose: 1 });
    frames++;
    pending = null;
  };
  return {
    // full: re-encode every pixel, clearing the drift that DIFF leaves after slow fades.
    add(rgba, delay, { full = false } = {}) {
      const n = width * height;
      let changed = [];
      if (shown && !full) {
        for (let p = 0; p < n; p++) {
          const i = p * 4;
          if (Math.abs(rgba[i] - shown[i]) > DIFF || Math.abs(rgba[i + 1] - shown[i + 1]) > DIFF || Math.abs(rgba[i + 2] - shown[i + 2]) > DIFF) changed.push(p);
        }
        if (!changed.length) { if (pending) pending.delay += delay; return; }
      } else {
        shown ||= Buffer.alloc(n * 4);
        changed = Array.from({ length: n }, (_, p) => p);
      }
      flush();
      const pixels = new Uint8Array(changed.length * 4);
      changed.forEach((p, j) => { pixels.set(rgba.subarray(p * 4, p * 4 + 4), j * 4); pixels[j * 4 + 3] = 255; });
      const partial = changed.length < n;
      const palette = quantize(pixels, partial ? 255 : 256);
      const picked = applyPalette(pixels, palette);
      const transparentIndex = palette.length;
      const index = new Uint8Array(n).fill(partial ? transparentIndex : 0);
      changed.forEach((p, j) => {
        const c = palette[picked[j]];
        index[p] = picked[j];
        shown[p * 4] = c[0]; shown[p * 4 + 1] = c[1]; shown[p * 4 + 2] = c[2]; shown[p * 4 + 3] = 255;
      });
      if (partial) palette.push([0, 0, 0]);
      pending = { index, palette, delay, transparent: partial, transparentIndex: partial ? transparentIndex : 0 };
    },
    finish() { flush(); gif.finish(); return { bytes: gif.bytes(), frames }; },
  };
}

/** Encodes dir/timeline.json into out; returns {bytes, seconds, frames, fps}. */
export async function encode(dir, out, { fps = FPS, stills = [] } = {}) {
  const tl = JSON.parse(readFileSync(join(dir, "timeline.json"), "utf8"));
  const frames = tl.frames.filter((f) => f.t >= tl.t0 && f.t <= tl.t1);
  if (!frames.length) throw new Error("no frames in the recording");
  const map = timeMap(tl.speeds, tl.t0);
  const camera = cameraPath(tl.cameras, map);
  const mask = await roundedMask(LAYOUT.screen);
  const frameScale = (await sharp(join(dir, frames[0].file)).metadata()).width / VIEWPORT.width;
  const stageAt = (t) => { let c = tl.captions[0]; for (const m of tl.captions) if (m.t <= t) c = m; return join(dir, c.stage); };
  const writer = gifWriter(LAYOUT);
  const step = 1 / fps, delay = 1000 / fps;
  const title = await raw(sharp(join(dir, tl.title)));
  const end = await raw(sharp(join(dir, tl.end)));
  const length = map.out(tl.t1);
  let last = null, f = 0;
  const body = [];
  for (let o = 0; o <= length; o += step) {
    const t = map.back(o);
    while (f + 1 < frames.length && frames[f + 1].t <= t) f++;
    body.push({ file: join(dir, frames[f].file), rect: camera(o), stage: stageAt(t) });
  }
  const fade = Math.round(FADE_S * fps);
  for (let i = 0; i < Math.round(TITLE_S * fps); i++) writer.add(title, delay);
  for (let i = 0; i < body.length; i++) {
    const rgba = await compose(body[i].file, body[i].rect, body[i].stage, mask, frameScale);
    if (i === 0) for (let k = 1; k <= fade; k++) writer.add(mix(title, rgba, k / fade), delay);
    writer.add(rgba, delay, { full: i === 0 || body[i].stage !== body[i - 1].stage });
    // Stills are output seconds from the start of the GIF, title card included.
    const at = Math.round(TITLE_S * fps) + fade + i;
    for (const s of stills) if (Math.round(s * fps) === at) await sharp(rgba, { raw: { width: LAYOUT.width, height: LAYOUT.height, channels: 4 } }).png().toFile(join(dir, `still-${s}.png`));
    last = rgba;
  }
  for (let k = 1; k <= fade; k++) writer.add(mix(last, end, k / fade), delay);
  for (let i = 0; i < Math.round(END_S * fps); i++) writer.add(end, delay, { full: i === 0 });
  const { bytes, frames: written } = writer.finish();
  if (bytes.length > MAX_BYTES && fps - 2 >= MIN_FPS) return encode(dir, out, { fps: fps - 2, stills });
  writeFileSync(out, bytes);
  return { bytes: bytes.length, seconds: +(TITLE_S + length + END_S + 2 * FADE_S).toFixed(1), frames: written, fps };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values, positionals: [dir, out = join(dir || "", "demo.gif")] } = parseArgs({ allowPositionals: true, options: { stills: { type: "string", default: "" } } });
  if (!dir) { console.error("usage: encode.mjs <recording-dir> [out.gif] [--stills 4,9.5]"); process.exit(2); }
  const result = await encode(dir, out, { stills: values.stills ? values.stills.split(",").map(Number) : [] });
  console.log(`${out}: ${(result.bytes / 1048576).toFixed(2)} MB, ${result.seconds} s, ${result.frames} GIF frames at ${result.fps} fps`);
}

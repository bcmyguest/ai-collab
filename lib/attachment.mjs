/** Image attachments for operator messages: absolute path, image extension, matching magic bytes, ≤ 15 MB. */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { basename, extname, isAbsolute } from "node:path";

export const ATTACHMENT_MAX_BYTES = 15 * 1024 * 1024;
export const TEXT_ATTACHMENT_MAX_BYTES = 1024 * 1024;
export const IMAGE_ATTACHMENT_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"];
const SIGNATURES = {
  ".png": [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ".jpg": [[0xff, 0xd8, 0xff]],
  ".jpeg": [[0xff, 0xd8, 0xff]],
  ".gif": [[0x47, 0x49, 0x46, 0x38]],
  ".webp": [[0x52, 0x49, 0x46, 0x46]],
};

export function imageAttachment(filename, data) {
  const name = basename(filename);
  const ext = extname(name).toLowerCase();
  if (!IMAGE_ATTACHMENT_EXTENSIONS.includes(ext)) throw new Error("attachment must be a .png, .jpg, .jpeg, .gif or .webp image");
  if (data.length > ATTACHMENT_MAX_BYTES) throw new Error("attachment is over 15 MB");
  const signature = SIGNATURES[ext].some(sig => sig.every((byte, i) => data[i] === byte));
  if (!signature || (ext === ".webp" && data.toString("ascii", 8, 12) !== "WEBP")) {
    throw new Error(`attachment content is not a ${ext.slice(1)} image`);
  }
  return { filename: name, data };
}

/** Reads an image for upload; throws with a reason the agent can act on. */
export function readAttachment(path) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("attachment must be an absolute file path");
  const ext = extname(path).toLowerCase();
  if (!IMAGE_ATTACHMENT_EXTENSIONS.includes(ext)) throw new Error("attachment must be a .png, .jpg, .jpeg, .gif or .webp image");
  let fd;
  try { fd = openSync(path, "r"); } catch { throw new Error("attachment file is unreadable"); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("attachment must be a regular file");
    if (stat.size > ATTACHMENT_MAX_BYTES) throw new Error("attachment is over 15 MB");
    const data = Buffer.alloc(stat.size);
    readSync(fd, data, 0, stat.size, 0);
    return imageAttachment(path, data);
  } finally {
    closeSync(fd);
  }
}

/** Hook-generated text (a large tool result) as a .txt upload; reads no file, so the image-only rule above still holds. */
export function textAttachment(text, filename = "output.txt") {
  const data = Buffer.from(String(text), "utf8");
  if (data.length <= TEXT_ATTACHMENT_MAX_BYTES) return { filename, data };
  const marker = `\n…[truncated ${data.length - TEXT_ATTACHMENT_MAX_BYTES} bytes]`;
  return { filename, data: Buffer.from(data.subarray(0, TEXT_ATTACHMENT_MAX_BYTES).toString("utf8") + marker) };
}

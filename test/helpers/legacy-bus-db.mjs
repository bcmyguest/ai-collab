/**
 * A writer for the retired SQLite bus.db format (schema and poll semantics of the removed `openBusStore`),
 * so `ai-collab bus migrate --to postgres` keeps a source to copy from. Test-only; production has no SQLite bus.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseSince } from "../../lib/bus.mjs";

const FILE_EXT = /\.(png|jpe?g|gif|webp|txt)$/i;
const FILE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".txt": "text/plain; charset=utf-8" };

function fileType(name) {
  const ext = String(name).slice(String(name).lastIndexOf(".")).toLowerCase();
  return FILE_TYPES[ext] || "application/octet-stream";
}

/** Opens or creates a legacy bus.db at `file`, with attachments under `filesDir`. */
export function openLegacyBusDb({ file, filesDir }) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (filesDir) fs.mkdirSync(filesDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic TEXT NOT NULL,
    time INTEGER NOT NULL,
    message TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    attachment TEXT
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS events_topic_id ON events(topic, id)");
  db.exec("CREATE INDEX IF NOT EXISTS events_time ON events(time)");
  db.exec(`CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    size INTEGER NOT NULL,
    created INTEGER NOT NULL
  )`);
  const rowEvent = (row) => ({
    id: String(row.id),
    time: row.time,
    event: "message",
    topic: row.topic,
    message: row.message,
    title: row.title,
    ...(row.attachment ? { attachment: JSON.parse(row.attachment) } : {}),
  });
  const all = (topic) => db.prepare("SELECT * FROM events WHERE topic = ? ORDER BY id").all(topic).map(rowEvent);
  return {
    publish({ topic, message, title = "", attachment = null }) {
      const time = Math.floor(Date.now() / 1000);
      const info = db.prepare("INSERT INTO events(topic, time, message, title, attachment) VALUES (?,?,?,?,?)")
        .run(topic, time, message, title, attachment ? JSON.stringify(attachment) : null);
      return { id: String(info.lastInsertRowid), time, event: "message", topic, message, title, ...(attachment ? { attachment } : {}) };
    },
    poll(topic, since) {
      const s = parseSince(since || "all");
      if (s.kind === "time") return db.prepare("SELECT * FROM events WHERE topic = ? AND time >= ? ORDER BY id").all(topic, s.value).map(rowEvent);
      if (s.kind === "id" && db.prepare("SELECT id FROM events WHERE topic = ? AND id = ?").get(topic, s.value)) {
        return db.prepare("SELECT * FROM events WHERE topic = ? AND id > ? ORDER BY id").all(topic, s.value).map(rowEvent);
      }
      return all(topic);
    },
    putFile({ name, data }) {
      const ext = (FILE_EXT.exec(name)?.[0] || ".bin").toLowerCase();
      const id = `${randomBytes(8).toString("hex")}${ext}`;
      const type = fileType(name);
      if (filesDir) fs.writeFileSync(path.join(filesDir, id), data, { mode: 0o600 });
      db.prepare("INSERT INTO files(id, name, type, size, created) VALUES (?,?,?,?,?)")
        .run(id, String(name).slice(0, 200), type, data.length, Math.floor(Date.now() / 1000));
      return { file: id, type, size: data.length };
    },
    close() {
      try { db.close(); } catch { /* already closed */ }
    },
  };
}

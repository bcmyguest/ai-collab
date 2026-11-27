import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// oxlint-disable-next-line typescript/no-explicit-any -- events are stored and returned as JSON
type Json = any;
/** The UI's local event history and read positions for one bus. */
export type History = {
  add: (topic: string, events: Json[]) => Json[];
  events: (topic: string, limit?: number) => Json[];
  position: (conversation: string, reader: string) => number;
  mark: (conversation: string, reader: string, sequence: number) => void;
  close: () => void;
};

export function openHistory(cfg: { stateDir: string; url: string; token?: string }): History {
  const dir = join(cfg.stateDir, "ui-history");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = createHash("sha256").update(JSON.stringify([cfg.url, cfg.token])).digest("hex");
  const file = join(dir, key + ".sqlite");
  closeSync(openSync(file, "a", 0o600));
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS events (
      topic TEXT NOT NULL, id TEXT NOT NULL, time REAL NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY (topic, id)
    );
    CREATE INDEX IF NOT EXISTS events_time ON events (topic, time);
    CREATE TABLE IF NOT EXISTS read_positions (
      conversation TEXT NOT NULL, reader TEXT NOT NULL, sequence INTEGER NOT NULL,
      PRIMARY KEY (conversation, reader)
    );
  `);
  const insert = db.prepare("INSERT OR IGNORE INTO events VALUES (?, ?, ?, ?)");
  const select = db.prepare("SELECT rowid AS sequence, payload FROM events WHERE topic = ? ORDER BY time, rowid");
  const recent = db.prepare("SELECT rowid AS sequence, payload FROM events WHERE topic = ? ORDER BY time DESC, rowid DESC LIMIT ?");
  const position = db.prepare("SELECT sequence FROM read_positions WHERE conversation = ? AND reader = ?");
  const mark = db.prepare(`
    INSERT INTO read_positions VALUES (?, ?, ?)
    ON CONFLICT (conversation, reader) DO UPDATE SET sequence = excluded.sequence
      WHERE excluded.sequence > read_positions.sequence
  `);
  return {
    add(topic, events) {
      if (!events.length) return [];
      db.exec("BEGIN");
      try {
        const added = events.filter(event => insert.run(topic, event.id, event.time, JSON.stringify(event)).changes);
        db.exec("COMMIT");
        return added;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    events(topic, limit) {
      const rows = limit === undefined ? select.all(topic) : recent.all(topic, limit).reverse();
      return rows.map(row => ({ ...JSON.parse(row.payload as string), sequence: row.sequence }));
    },
    position: (conversation, reader) => (position.get(conversation, reader)?.sequence as number | undefined) ?? 0,
    mark: (conversation, reader, sequence) => mark.run(conversation, reader, sequence),
    close: () => db.close(),
  };
}

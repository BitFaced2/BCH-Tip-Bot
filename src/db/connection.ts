import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";

let db: Database.Database | null = null;

export function getDatabase(dbPath: string): Database.Database {
  if (db) return db;

  mkdirSync(dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

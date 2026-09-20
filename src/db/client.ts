import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { config } from '../config.js';
import fs from 'fs';
import path from 'path';

let db: ReturnType<typeof drizzle> | null = null;
let sqlite: Database.Database | null = null;

export function getDb() {
  if (db) {
    return db;
  }

  // Create or load database using better-sqlite3
  const dbPath = path.resolve(config.databasePath);
  const dbDir = path.dirname(dbPath);

  // Ensure directory exists
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  // Initialize SQLite database
  sqlite = new Database(dbPath);
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite);
  return db;
}

export function getRawDb() {
  getDb();
  return sqlite;
}

export function runMigrations() {
  const currentDb = getDb();

  // Run Drizzle migrations
  migrate(currentDb, { migrationsFolder: './drizzle' });
}

export function closeDb() {
  if (sqlite && db) {
    sqlite.close();
    sqlite = null;
    db = null;
  }
}

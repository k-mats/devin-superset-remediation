import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';

// Minimal schema for Phase 1 - just to verify Drizzle + SQLite setup
export const sessions = sqliteTable('sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  createdAt: integer('created_at').notNull().default(0),
  status: text('status').notNull().default('pending'),
});

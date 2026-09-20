import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it } from 'vitest';

const ATTEMPT_COLUMNS_0002 = `INSERT INTO attempts
  (task_id, attempt_number, correlation_id, state, outcome, devin_session_id, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
const ATTEMPT_WITH_PR_URL_0002 = `INSERT INTO attempts
  (task_id, attempt_number, correlation_id, state, outcome, devin_session_id, created_at, updated_at, pr_url)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function applyMigrations(sqlite: Database.Database, count: number) {
  const journal = JSON.parse(
    fs.readFileSync(path.join('drizzle', 'meta', '_journal.json'), 'utf8')
  ) as { entries: Array<{ tag: string; when: number }> };
  const entries = journal.entries.slice(0, count);
  for (const entry of entries) {
    const sqlText = fs.readFileSync(path.join('drizzle', `${entry.tag}.sql`), 'utf8');
    for (const statement of sqlText.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }
  }
  sqlite.exec(
    'CREATE TABLE IF NOT EXISTS `__drizzle_migrations` (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)'
  );
  const record = sqlite.prepare(
    'INSERT INTO `__drizzle_migrations` (hash, created_at) VALUES (?, ?)'
  );
  for (const entry of entries) {
    record.run('manual', entry.when);
  }
}

describe('migration 0005 against a pre-existing database', () => {
  it('upgrades a pre-0005 database without losing rows and initializes new columns to NULL', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-0003-'));
    const sqlite = new Database(path.join(dir, 'legacy.db'));
    try {
      applyMigrations(sqlite, 3); // 0000..0002

      const timestamp = Date.now();
      const taskId = Number(
        sqlite
          .prepare(
            'INSERT INTO tasks (repo_owner, repo_name, issue_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
          )
          .run('owner', 'repo', 1, timestamp, timestamp).lastInsertRowid
      );
      const attemptId = Number(
        sqlite
          .prepare(ATTEMPT_COLUMNS_0002)
          .run(taskId, 1, randomUUID(), 'session_created', null, 'sess-1', timestamp, timestamp)
          .lastInsertRowid
      );
      const insertLegacyPullRequestAttempt = (
        issueNumber: number,
        sessionId: string,
        prUrl: string
      ) => {
        const legacyTaskId = Number(
          sqlite
            .prepare(
              'INSERT INTO tasks (repo_owner, repo_name, issue_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
            )
            .run('acme', 'widget', issueNumber, timestamp, timestamp).lastInsertRowid
        );
        return Number(
          sqlite
            .prepare(ATTEMPT_WITH_PR_URL_0002)
            .run(
              legacyTaskId,
              1,
              randomUUID(),
              'session_created',
              null,
              sessionId,
              timestamp,
              timestamp,
              prUrl
            ).lastInsertRowid
        );
      };
      const canonicalPullRequestAttemptId = insertLegacyPullRequestAttempt(
        2,
        'sess-canonical',
        'https://github.com/acme/widget/pull/42'
      );
      const unparseablePullRequestAttemptId = insertLegacyPullRequestAttempt(
        3,
        'sess-unparseable',
        'https://example.com/not-a-pull-request'
      );

      migrate(drizzle(sqlite), { migrationsFolder: './drizzle' });

      type Row = {
        id: number;
        state: string;
        structured_output_raw: string | null;
        agent_outcome: string | null;
        structured_output_accepted_at: number | null;
        pr_url: string | null;
        devin_session_status: string | null;
        devin_session_status_detail: string | null;
        acus_consumed: number | null;
        session_updated_at: number | null;
        session_last_polled_at: number | null;
        pr_number: number | null;
        pr_state: string | null;
        pr_head_sha: string | null;
        pr_last_checked_at: number | null;
      };
      const row = sqlite
        .prepare(
          `SELECT id, state, structured_output_raw, agent_outcome, structured_output_accepted_at,
                  pr_url, devin_session_status, devin_session_status_detail, acus_consumed,
                  session_updated_at, session_last_polled_at, pr_number, pr_state,
                  pr_head_sha, pr_last_checked_at
           FROM attempts WHERE id = ?`
        )
        .get(attemptId) as Row;
      expect(row).toEqual({
        id: attemptId,
        state: 'session_created',
        pr_url: null,
        structured_output_raw: null,
        agent_outcome: null,
        structured_output_accepted_at: null,
        devin_session_status: null,
        devin_session_status_detail: null,
        acus_consumed: null,
        session_updated_at: null,
        session_last_polled_at: null,
        pr_number: null,
        pr_state: null,
        pr_head_sha: null,
        pr_last_checked_at: null,
      });
      expect(
        sqlite
          .prepare('SELECT pr_url, pr_number FROM attempts WHERE id = ?')
          .get(canonicalPullRequestAttemptId)
      ).toEqual({
        pr_url: 'https://github.com/acme/widget/pull/42',
        pr_number: 42,
      });
      expect(
        sqlite
          .prepare('SELECT pr_url, pr_number FROM attempts WHERE id = ?')
          .get(unparseablePullRequestAttemptId)
      ).toEqual({
        pr_url: 'https://example.com/not-a-pull-request',
        pr_number: null,
      });

      expect(() =>
        sqlite.prepare(`UPDATE attempts SET agent_outcome = 'bogus' WHERE id = ?`).run(attemptId)
      ).toThrow();
      sqlite.prepare(`UPDATE attempts SET agent_outcome = 'no_action' WHERE id = ?`).run(attemptId);
      expect(
        (
          sqlite.prepare(`SELECT agent_outcome FROM attempts WHERE id = ?`).get(attemptId) as {
            agent_outcome: string;
          }
        ).agent_outcome
      ).toBe('no_action');
    } finally {
      sqlite.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

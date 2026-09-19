import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { config } from '../src/config.js';
import { createDevinClientFromConfig, type SessionResponse } from '../src/devin/client.js';

const POLL_TIMEOUT_MS = Number(process.env['SMOKE_POLL_TIMEOUT_MS'] ?? 5 * 60 * 1000);
const POLL_INTERVAL_MS = Number(process.env['SMOKE_POLL_INTERVAL_MS'] ?? 10 * 1000);
const OUTPUT_PATH = process.env['SMOKE_OUTPUT_PATH'];

// v3 `status` enum: new, claimed, running, exit, error, suspended, resuming.
// A running session that is waiting on the user has finished its turn, so stop polling there too.
const NON_TERMINAL_STATUSES = new Set(['new', 'claimed', 'running', 'resuming']);
const IDLE_STATUS_DETAILS = new Set(['waiting_for_user', 'waiting_for_approval', 'finished']);
// Success requires the session to have actually completed its turn: either an
// `exit` status or a status_detail showing it finished or is waiting on the user.
const SUCCESS_STATUSES = new Set(['exit']);
const SUCCESS_STATUS_DETAILS = new Set(['waiting_for_user', 'finished']);

function isTerminal(session: SessionResponse): boolean {
  if (session.status_detail && IDLE_STATUS_DETAILS.has(session.status_detail)) {
    return true;
  }
  return !NON_TERMINAL_STATUSES.has(session.status);
}

function summarize(session: SessionResponse) {
  return {
    session_id: session.session_id,
    url: session.url,
    status: session.status,
    status_detail: session.status_detail,
    origin: session.origin,
    service_user_id: session.service_user_id,
    tags: session.tags,
    acus_consumed: session.acus_consumed,
    created_at: session.created_at,
    updated_at: session.updated_at,
    title: session.title,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<number> {
  const client = createDevinClientFromConfig(config);

  console.error('Creating Devin session (smoke test)...');
  const session = await client.createSession({
    prompt:
      'This is an automated API smoke test. Reply with exactly the word "pong" and then finish the session immediately. Do not run any commands, do not open any repositories, and do not create files or pull requests.',
    title: 'Issue #5 Devin API smoke test',
    tags: ['take-home', 'issue-5', 'smoke-test'],
    max_acu_limit: 1,
    resumable: false,
  });

  console.error(`session_id: ${session.session_id}`);
  console.error(`url: ${session.url}`);

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let current = session;
  while (!isTerminal(current) && Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(POLL_INTERVAL_MS, remaining));
    current = await client.getSession(session.session_id);
    console.error(`status: ${current.status} (detail: ${current.status_detail ?? 'n/a'})`);
  }

  // Always do one final fetch for the freshest state.
  current = await client.getSession(session.session_id);

  const timedOut = !isTerminal(current);
  const completed =
    (current.status_detail !== null &&
      current.status_detail !== undefined &&
      SUCCESS_STATUS_DETAILS.has(current.status_detail)) ||
    SUCCESS_STATUSES.has(current.status);

  const summary = {
    ...summarize(current),
    originIsApi: current.origin === 'api',
    timedOut,
    completed,
  };
  console.log(JSON.stringify(summary, null, 2));

  if (OUTPUT_PATH) {
    await writeFile(OUTPUT_PATH, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    console.error(`summary written to ${OUTPUT_PATH}`);
  }

  if (current.origin !== 'api') {
    console.error(`FAIL: expected origin 'api', got '${String(current.origin)}'`);
    return 1;
  }
  if (!completed) {
    console.error(
      `FAIL: session did not complete its turn (status=${current.status}, detail=${String(current.status_detail)}, timedOut=${String(timedOut)})`
    );
    return 1;
  }
  console.error('OK: session origin is api and session completed its turn');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error('Smoke test failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });

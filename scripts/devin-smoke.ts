import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { config } from '../src/config.js';
import {
  createDevinClientFromConfig,
  type SessionResponse,
  type SessionStatus,
  type SessionStatusDetail,
} from '../src/devin/client.js';

const POLL_TIMEOUT_MS = Number(process.env['SMOKE_POLL_TIMEOUT_MS'] ?? 5 * 60 * 1000);
const POLL_INTERVAL_MS = Number(process.env['SMOKE_POLL_INTERVAL_MS'] ?? 10 * 1000);
const OUTPUT_PATH = process.env['SMOKE_OUTPUT_PATH'];

// Poll until `status` leaves the active set or `status_detail` shows the turn is done.
const NON_TERMINAL_STATUSES = new Set<SessionStatus>(['new', 'claimed', 'running', 'resuming']);
// Success requires a completed turn: `exit` status or a finished/waiting detail.
const SUCCESS_STATUSES = new Set<SessionStatus>(['exit']);
const SUCCESS_STATUS_DETAILS = new Set<SessionStatusDetail>(['waiting_for_user', 'finished']);
const TERMINAL_STATUS_DETAILS = new Set<SessionStatusDetail>([
  ...SUCCESS_STATUS_DETAILS,
  'waiting_for_approval',
]);

type LifecycleEntry = {
  status: SessionStatus;
  status_detail: SessionStatusDetail | null;
  observed_at: string;
};

function isTerminal(session: SessionResponse): boolean {
  if (session.status_detail && TERMINAL_STATUS_DETAILS.has(session.status_detail)) {
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

  const lifecycle: LifecycleEntry[] = [];
  const observe = (s: SessionResponse) => {
    lifecycle.push({
      status: s.status,
      status_detail: s.status_detail ?? null,
      observed_at: new Date().toISOString(),
    });
  };
  observe(session);

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let current = session;
  // Terminal state only counts if it was observed before the deadline.
  let terminalByDeadline = isTerminal(current) && Date.now() < deadline;
  while (!terminalByDeadline && Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(POLL_INTERVAL_MS, remaining));
    current = await client.getSession(session.session_id);
    observe(current);
    console.error(`status: ${current.status} (detail: ${current.status_detail ?? 'n/a'})`);
    terminalByDeadline = isTerminal(current) && Date.now() < deadline;
  }

  const timedOut = !terminalByDeadline;

  // Always do one final fetch for the freshest state.
  current = await client.getSession(session.session_id);
  observe(current);

  const failed = current.status === 'error' || current.status === 'suspended';
  const completed =
    !failed &&
    ((current.status_detail !== null &&
      current.status_detail !== undefined &&
      SUCCESS_STATUS_DETAILS.has(current.status_detail)) ||
      SUCCESS_STATUSES.has(current.status));

  const summary = {
    ...summarize(current),
    originIsApi: current.origin === 'api',
    timedOut,
    failed,
    completed,
    lifecycle,
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
  if (timedOut || !completed) {
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

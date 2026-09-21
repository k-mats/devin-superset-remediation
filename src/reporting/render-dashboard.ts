import type { Report, ReportAttemptRow } from './report-model.js';

export function safeHref(url: string | null): string | null {
  if (url === null) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatTime(timestamp: number | null): string {
  return timestamp === null ? '—' : new Date(timestamp).toISOString();
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return 'n/a';
  return `${String(Math.round(durationMs / 1000))}s`;
}

function renderAttempt(attempt: ReportAttemptRow): string {
  const sessionHref = safeHref(attempt.devinSessionUrl);
  const session =
    attempt.devinSessionUrl === null
      ? '—'
      : sessionHref
        ? `<a href="${escapeHtml(sessionHref)}">session</a>`
        : escapeHtml(attempt.devinSessionUrl);
  const prHref = safeHref(attempt.prUrl);
  const pr =
    attempt.prUrl === null
      ? '—'
      : prHref
        ? `<a href="${escapeHtml(prHref)}">PR${attempt.prNumber === null ? '' : ` #${String(attempt.prNumber)}`}</a> (${escapeHtml(attempt.prState ?? 'unknown')})`
        : `${escapeHtml(attempt.prUrl)} (${escapeHtml(attempt.prState ?? 'unknown')})`;
  return `<li>#${String(attempt.attemptNumber)} · ${escapeHtml(attempt.state)} · ${escapeHtml(attempt.outcome ?? '—')} · ${session} · ${pr}</li>`;
}

export function renderDashboard(report: Report): string {
  const summaryCards = [
    ['Active', report.summary.byBucket.active],
    ['Successful (VERIFIED)', report.summary.byBucket.successful],
    ['Needs human', report.summary.byBucket.needs_human],
    ['Failed', report.summary.byBucket.failed],
    ['No action', report.summary.byBucket.no_action],
    ['Cancelled', report.summary.byBucket.cancelled],
  ]
    .map(
      ([label, count]) =>
        `<div class="card"><strong>${String(count)}</strong><span>${escapeHtml(String(label))} tasks</span></div>`
    )
    .join('');
  const taskRows = report.tasks
    .map((task) => {
      const issueHref = safeHref(task.issueUrl);
      const issue = `${issueHref ? `<a href="${escapeHtml(issueHref)}">#${String(task.issueNumber)}</a>` : escapeHtml(task.issueUrl)} ${escapeHtml(task.title ?? '(untitled)')}`;
      const sessionHref = safeHref(task.devinSessionUrl);
      const session =
        task.devinSessionUrl === null
          ? '—'
          : sessionHref
            ? `<a href="${escapeHtml(sessionHref)}">session</a>`
            : escapeHtml(task.devinSessionUrl);
      const prHref = safeHref(task.prUrl);
      const pr =
        task.prUrl === null
          ? '—'
          : prHref
            ? `<a href="${escapeHtml(prHref)}">PR${task.currentAttempt.prNumber === null ? '' : ` #${String(task.currentAttempt.prNumber)}`}</a> (${escapeHtml(task.currentAttempt.prState ?? 'unknown')})`
            : `${escapeHtml(task.prUrl)} (${escapeHtml(task.currentAttempt.prState ?? 'unknown')})`;
      const history =
        task.attemptCount > 1
          ? `<details><summary>Attempt history</summary><ol>${task.attempts.map(renderAttempt).join('')}</ol></details>`
          : '';
      return `<tr><td>${issue}</td><td><strong>${escapeHtml(task.state)}</strong><small>${escapeHtml(task.reason)}</small></td><td>${escapeHtml(task.currentAttempt.state)} / ${escapeHtml(task.currentAttempt.outcome ?? '—')} / ${escapeHtml(task.currentAttempt.outcomeReason ?? '—')}</td><td>${String(task.currentAttempt.attemptNumber)} / ${String(task.attemptCount)}${history}</td><td>${session}</td><td>${pr}</td><td>${escapeHtml(formatTime(task.lastUpdatedAt))}</td></tr>`;
    })
    .join('');
  const throughputMeasures: Array<[string, { last24h: number; last7d: number }, string]> = [
    ['Tasks discovered', report.throughput.tasksDiscovered, report.unit.throughput.tasksDiscovered],
    [
      'Tasks reached terminal',
      report.throughput.tasksReachedTerminal,
      report.unit.throughput.tasksReachedTerminal,
    ],
    ['Tasks VERIFIED', report.throughput.tasksVerified, report.unit.throughput.tasksVerified],
    ['Attempts created', report.throughput.attemptsCreated, report.unit.throughput.attemptsCreated],
  ];
  const throughputRows = throughputMeasures
    .map(
      ([label, counts, unit]) =>
        `<tr><td>${escapeHtml(label)}</td><td>${String(counts.last24h)} ${unit}</td><td>${String(counts.last7d)} ${unit}</td></tr>`
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="30">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Remediation dashboard</title>
<style>
body{font:14px system-ui,sans-serif;line-height:1.4;margin:2rem;color:#18212b;background:#f7f8fa}
main{max-width:1500px;margin:auto}h1{margin-bottom:.25rem}.muted,small{color:#5f6b76}
.cards{display:flex;gap:1rem;flex-wrap:wrap;margin:1rem 0}.card{background:white;border:1px solid #d8dee4;border-radius:6px;padding:1rem;min-width:140px}.card strong,.card span{display:block}.card strong{font-size:1.6rem}
table{border-collapse:collapse;background:white;width:100%;margin:1rem 0}th,td{border:1px solid #d8dee4;padding:.5rem;text-align:left;vertical-align:top}th{background:#eef1f4}td small{display:block}
a{color:#0969da}details{margin-top:.4rem}ul,ol{margin:.3rem 0;padding-left:1.3rem}
</style>
</head>
<body><main>
<h1>Remediation dashboard</h1>
<p class="muted">Data source: ${escapeHtml(report.context.databasePath)} · env: ${escapeHtml(report.context.nodeEnv)} · configured intake repo: ${escapeHtml(report.context.configuredRepository ?? '—')}</p>
<p class="muted">Generated ${escapeHtml(report.context.generatedAt)} · <a href="">Refresh</a></p>
<div class="cards">${summaryCards}</div>
<p>Successful = VERIFIED only; a PR URL or open PR is not success. Terminal = automation reached an end state (includes needs-human/failed).</p>
<h2>Throughput</h2>
<table><thead><tr><th>Measure</th><th>24h</th><th>7d</th></tr></thead><tbody>${throughputRows}</tbody></table>
<p class="muted">${String(report.summary.terminalWithoutTimestamp)} terminal task(s) have no persisted terminal timestamp and are excluded from terminal throughput / cycle time.</p>
<p>Median intake→terminal cycle time (all historical terminal attempts, n=${String(report.cycleTime.sampleSize)}): ${escapeHtml(formatDuration(report.cycleTime.medianMsIntakeToTerminal))}</p>
<h2>Tasks (${String(report.summary.totalTasks)})</h2>
<table><thead><tr><th>Issue</th><th>State</th><th>Outcome</th><th>Attempt</th><th>Devin session</th><th>PR</th><th>Last updated</th></tr></thead><tbody>${taskRows || '<tr><td colspan="7">No tasks</td></tr>'}</tbody></table>
<p class="muted">Tasks without attempts: ${String(report.tasksWithoutAttempts)}</p>
</main></body></html>`;
}

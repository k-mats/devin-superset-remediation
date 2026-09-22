import type {
  LedgerAttemptEvidence,
  LedgerVerificationEvidence,
  Report,
  ReportAttemptRow,
} from './report-model.js';
import {
  ALL_WORKERS_ENABLED,
  NEXT_ACTION_LABEL,
  stateGuidance,
  type WorkerAvailability,
} from './state-guidance.js';
import type { NormalizedTaskState } from '../tracking/normalized-task-state.js';
import { escapeHtml } from './html.js';
import { renderStateDiagram, renderStateTransitionsList, stateLink } from './state-diagram.js';

export function safeHref(url: string | null): string | null {
  if (url === null) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

export { escapeHtml };

function formatTime(timestamp: number | null): string {
  return timestamp === null ? '—' : new Date(timestamp).toISOString();
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return 'n/a';
  return `${String(Math.round(durationMs / 1000))}s`;
}

function formatAcus(acusConsumed: number | null): string {
  return acusConsumed === null ? '—' : String(acusConsumed);
}

function renderVerificationEvidence(verification: LedgerVerificationEvidence | null): string {
  if (verification === null) return '—';
  const evidenceHref = safeHref(verification.evidenceUrl);
  const evidence = evidenceHref
    ? `<a href="${escapeHtml(evidenceHref)}">evidence</a>`
    : verification.evidenceUrl === null
      ? ''
      : escapeHtml(verification.evidenceUrl);
  const spec =
    verification.specSha256 === null
      ? ''
      : ` · spec <code>${escapeHtml(verification.specSha256.slice(0, 12))}</code>`;
  const exit = verification.exitCode === null ? '' : ` · exit ${String(verification.exitCode)}`;
  return `<strong>${escapeHtml(verification.status)}</strong> · ${escapeHtml(verification.reason ?? '—')} · head <code title="${escapeHtml(verification.headSha)}">${escapeHtml(verification.headSha.slice(0, 12))}</code>${spec}${exit}${evidence === '' ? '' : ` · ${evidence}`} · finished ${escapeHtml(formatTime(verification.finishedAt))} · created ${escapeHtml(formatTime(verification.createdAt))}`;
}

function renderSessionEvidence(attempt: LedgerAttemptEvidence): string {
  const sessionHref = safeHref(attempt.devinSessionUrl);
  const session =
    attempt.devinSessionUrl === null
      ? '—'
      : sessionHref
        ? `<a href="${escapeHtml(sessionHref)}">session</a>`
        : escapeHtml(attempt.devinSessionUrl);
  const status = attempt.devinSessionStatus ?? '—';
  const detail =
    attempt.devinSessionStatusDetail === null
      ? ''
      : ` · ${escapeHtml(attempt.devinSessionStatusDetail)}`;
  return `${session}<small>${escapeHtml(status)}${detail}<br>ACU observed: ${escapeHtml(formatAcus(attempt.acusConsumed))}<br>observed at: ${escapeHtml(formatTime(attempt.timestamps.sessionLastPolledAt))}</small>`;
}

function renderPrEvidence(attempt: LedgerAttemptEvidence): string {
  const prHref = safeHref(attempt.prUrl);
  const pr =
    attempt.prUrl === null
      ? '—'
      : prHref
        ? `<a href="${escapeHtml(prHref)}">PR${attempt.prNumber === null ? '' : ` #${String(attempt.prNumber)}`}</a>`
        : escapeHtml(attempt.prUrl);
  const state = attempt.prState === null ? 'unknown' : attempt.prState;
  const head =
    attempt.prHeadSha === null
      ? ''
      : ` · head <code title="${escapeHtml(attempt.prHeadSha)}">${escapeHtml(attempt.prHeadSha.slice(0, 12))}</code>`;
  return `${pr} <small>(${escapeHtml(state)})${head}</small>`;
}

function renderApproval(attempt: LedgerAttemptEvidence): string {
  const approval = attempt.approval;
  const spec =
    approval.approvedSha256 === null
      ? ''
      : ` · spec <code>${escapeHtml(approval.approvedSha256.slice(0, 12))}</code> · by ${escapeHtml(approval.approvedBy ?? '—')} · ${escapeHtml(formatTime(approval.approvedAt))}`;
  const verificationContext =
    attempt.state === 'VERIFYING' ||
    attempt.state === 'VERIFIED' ||
    attempt.state === 'VERIFICATION_FAILED' ||
    approval.status !== 'no_candidate' ||
    approval.approvedSha256 !== null ||
    attempt.verification.command !== null ||
    attempt.verification.githubChecks !== null ||
    attempt.verification.prior.length > 0 ||
    attempt.verification.stale.length > 0;
  const link = verificationContext
    ? ` · <a href="/operator/attempts/${String(attempt.attemptId)}/verification">Verification</a>`
    : '';
  return `${escapeHtml(approval.status)}${spec}${link}`;
}

/**
 * Static, data-free client script: remembers which <details data-persist> are open across
 * the 30s meta refresh, and turns state links into an in-place highlight: the page only scrolls
 * (to the State map heading) when the diagram is not already fully visible.
 */
const DASHBOARD_SCRIPT = `(function(){
var KEY='dashboard.open';
var open={};
try{open=JSON.parse(localStorage.getItem(KEY)||'{}')||{}}catch(e){}
var details=document.querySelectorAll('details[data-persist]');
for(var i=0;i<details.length;i++){var d=details[i];var k=d.getAttribute('data-persist');if(k in open)d.open=!!open[k];
d.addEventListener('toggle',function(ev){var el=ev.target;var key=el.getAttribute('data-persist');if(el.open)open[key]=true;else delete open[key];try{localStorage.setItem(KEY,JSON.stringify(open))}catch(e){}})}
function select(state){var nodes=document.querySelectorAll('.state-node.selected');for(var j=0;j<nodes.length;j++)nodes[j].classList.remove('selected');
var node=document.getElementById('state-'+state);if(!node)return;node.classList.add('selected');
var map=document.querySelector('details[data-persist="state-map"]');if(map){if(!map.open)map.open=true;
var svg=map.querySelector('svg');var top=map.getBoundingClientRect().top;var bottom=(svg||map).getBoundingClientRect().bottom;
if(top<0||bottom>innerHeight)map.scrollIntoView({block:'start'})}
history.replaceState(null,'','#state-'+state)}
document.addEventListener('click',function(ev){var a=ev.target.closest('a.state-link');if(!a)return;ev.preventDefault();select(a.getAttribute('data-state'))});
if(location.hash.indexOf('#state-')===0)select(location.hash.slice(7));
})();`;

function renderStateCell(
  state: NormalizedTaskState,
  reason: string,
  workers: WorkerAvailability,
  persistKey: string
): string {
  const guidance = stateGuidance(state, reason, workers);
  return `<strong>${escapeHtml(state)}</strong><small>${escapeHtml(reason)} · ${stateLink(state, 'map', 'Highlight this state on the state map')}</small><span class="next next-${guidance.next}" title="${escapeHtml(guidance.text)}">${escapeHtml(NEXT_ACTION_LABEL[guidance.next])}</span><details class="guidance" data-persist="${escapeHtml(persistKey)}"><summary>What now?</summary><p>${escapeHtml(guidance.text)}</p></details>`;
}

function renderHistoryAttempt(attempt: LedgerAttemptEvidence): string {
  const prior =
    attempt.verification.prior.length === 0
      ? ''
      : `<ul>${attempt.verification.prior
          .map(
            (verification) =>
              `<li>prior ${escapeHtml(verification.kind)} (head <code title="${escapeHtml(verification.headSha)}">${escapeHtml(verification.headSha.slice(0, 12))}</code>): ${renderVerificationEvidence(verification)}</li>`
          )
          .join('')}</ul>`;
  const stale =
    attempt.verification.stale.length === 0
      ? ''
      : `<ul>${attempt.verification.stale
          .map(
            (verification) =>
              `<li>stale ${escapeHtml(verification.kind)} (head <code title="${escapeHtml(verification.headSha)}">${escapeHtml(verification.headSha.slice(0, 12))}</code>): ${renderVerificationEvidence(verification)}</li>`
          )
          .join('')}</ul>`;
  return `<li>attempt #${String(attempt.attemptNumber)} · ${escapeHtml(attempt.state)} / ${escapeHtml(attempt.reason)} · ${renderSessionEvidence(attempt)} · ${renderPrEvidence(attempt)} · command: ${renderVerificationEvidence(attempt.verification.command)} · checks: ${renderVerificationEvidence(attempt.verification.githubChecks)}${prior}${stale}</li>`;
}

function renderAttemptHistory(history: LedgerAttemptEvidence[]): string {
  const hasVerificationHistory = history.some(
    (entry) => entry.verification.prior.length > 0 || entry.verification.stale.length > 0
  );
  if (history.length <= 1 && !hasVerificationHistory) return '';
  return `<details><summary>Attempt history (${String(history.length)}) / verification history</summary><ol>${history.map(renderHistoryAttempt).join('')}</ol></details>`;
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

export function renderDashboard(
  report: Report,
  workers: WorkerAvailability = ALL_WORKERS_ENABLED
): string {
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
      const verificationLink = `<a href="/operator/attempts/${String(task.currentAttempt.id)}/verification">Verification</a>`;
      return `<tr><td>${issue}</td><td>${renderStateCell(task.state, task.reason, workers, `task-guidance-${String(task.taskId)}`)}</td><td>${escapeHtml(task.currentAttempt.state)} / ${escapeHtml(task.currentAttempt.outcome ?? '—')} / ${escapeHtml(task.currentAttempt.outcomeReason ?? '—')}</td><td>${String(task.currentAttempt.attemptNumber)} / ${String(task.attemptCount)}${history}</td><td>${session}</td><td>${pr}</td><td>${verificationLink}</td><td>${escapeHtml(formatTime(task.lastUpdatedAt))}</td></tr>`;
    })
    .join('');
  const ledgerRows = report.ledger
    .map((row) => {
      const issueHref = safeHref(row.issueUrl);
      const issue = `${issueHref ? `<a href="${escapeHtml(issueHref)}">#${String(row.issueNumber)}</a>` : escapeHtml(row.issueUrl)} ${escapeHtml(row.title ?? '(untitled)')}`;
      const current = row.current;
      if (current === null) {
        return `<tr><td>${issue}</td><td>${renderStateCell(row.state, row.reason, workers, `ledger-guidance-${String(row.taskId)}`)}</td><td>0 / 0</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td><small>discovered ${escapeHtml(formatTime(row.discoveredAt))}</small></td></tr>`;
      }
      const attemptHistory = renderAttemptHistory(row.history);
      const priorCommandCount = current.verification.prior.filter(
        (verification) => verification.kind === 'command'
      ).length;
      const priorGitHubChecksCount = current.verification.prior.filter(
        (verification) => verification.kind === 'github_checks'
      ).length;
      const commandPrior =
        priorCommandCount === 0
          ? ''
          : `<small>${String(priorCommandCount)} prior run(s) for this head</small>`;
      const githubChecksPrior =
        priorGitHubChecksCount === 0
          ? ''
          : `<small>${String(priorGitHubChecksCount)} prior run(s) for this head</small>`;
      const outcome = `${escapeHtml(current.attemptState)} / ${escapeHtml(current.outcome ?? '—')} / ${escapeHtml(current.outcomeReason ?? '—')}${current.agentReported.needsHumanReason === null ? '' : `<small>needs-human (agent-reported): ${escapeHtml(current.agentReported.needsHumanReason)}</small>`}${current.agentReported.outcome === null ? '' : `<small>agent outcome: ${escapeHtml(current.agentReported.outcome)}</small>`}`;
      const timestamps = `<small>discovered ${escapeHtml(formatTime(row.discoveredAt))}<br>dispatched ${escapeHtml(formatTime(current.timestamps.dispatchedAt))}<br>session created ${escapeHtml(formatTime(current.timestamps.sessionCreatedAt))}<br>completed ${escapeHtml(formatTime(current.timestamps.completedAt))}<br>terminal ${escapeHtml(formatTime(current.timestamps.terminalAt))}<br>verified ${escapeHtml(formatTime(current.timestamps.verifiedAt))}</small>`;
      return `<tr><td>${issue}</td><td>${renderStateCell(row.state, row.reason, workers, `ledger-guidance-${String(row.taskId)}`)}</td><td>${String(current.attemptNumber)} / ${String(row.attemptCount)}${attemptHistory}</td><td>${renderSessionEvidence(current)}</td><td>${renderPrEvidence(current)}</td><td>${renderVerificationEvidence(current.verification.command)}${commandPrior}</td><td>${renderVerificationEvidence(current.verification.githubChecks)}${githubChecksPrior}</td><td>${renderApproval(current)}</td><td>${outcome}</td><td>${timestamps}</td></tr>`;
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
a{color:#0969da}details{margin-top:.4rem}ul,ol{margin:.3rem 0;padding-left:1.3rem}code{font-size:.85em}
.next{display:inline-block;margin-top:.3rem;padding:.1rem .45rem;border-radius:4px;font-size:.8em;font-weight:600}
.next-wait{background:#ddf4ff;color:#0550ae}.next-operator{background:#fff8c5;color:#7d4e00}.next-human{background:#ffebe9;color:#a40e26}.next-done{background:#dafbe1;color:#1a7f37}
.guidance summary{cursor:pointer;color:#5f6b76;font-size:.85em}.guidance p{margin:.2rem 0 0;font-size:.9em;max-width:32rem}
.state-map{overflow-x:auto;background:white;border:1px solid #d8dee4;border-radius:6px;padding:.5rem;margin:.5rem 0}
.state-diagram{font:11px system-ui,sans-serif;display:block}.state-diagram .edge line{stroke:#8c959f;stroke-width:1.2}.state-diagram .edge:hover line{stroke:#0969da;stroke-width:2.5}.transitions ul{columns:2;font-size:.9em}.state-diagram #arrow path{fill:#8c959f}
.state-diagram .state-node rect{fill:#f6f8fa;stroke-width:1.2}.state-diagram .state-node.terminal rect{stroke-dasharray:4 3}
.state-diagram .next-wait rect{stroke:#0969da}.state-diagram .next-operator rect{stroke:#9a6700}.state-diagram .next-human rect{stroke:#cf222e}.state-diagram .next-done rect{stroke:#1a7f37}
.state-diagram .occupied rect{stroke-width:2}.state-diagram .next-wait.occupied rect{fill:#ddf4ff}.state-diagram .next-operator.occupied rect{fill:#fff8c5}.state-diagram .next-human.occupied rect{fill:#ffebe9}.state-diagram .next-done.occupied rect{fill:#dafbe1}
.state-diagram .state-node.selected rect{stroke:#18212b;stroke-width:3;filter:drop-shadow(0 0 4px #18212b)}.state-diagram .state-node.selected .name{text-decoration:underline}
.state-diagram text{text-anchor:middle}.state-diagram .name{font-weight:700;fill:#18212b}.state-diagram .count{fill:#5f6b76;font-size:10px}
.state-diagram .state-node:not(.occupied) .count{fill:#b1b8bf}
section.collapsible{margin-top:1.5rem}section.collapsible>details>summary{cursor:pointer}section.collapsible>details>summary h2{display:inline;margin:0}
</style>
</head>
<body><main>
<h1>Remediation dashboard</h1>
<p class="muted">Data source: ${escapeHtml(report.context.databasePath)} · env: ${escapeHtml(report.context.nodeEnv)} · configured intake repo: ${escapeHtml(report.context.configuredRepository ?? '—')}</p>
<p class="muted">Generated ${escapeHtml(report.context.generatedAt)} · <a href="">Refresh</a></p>
<div class="cards">${summaryCards}</div>
<p>Successful = VERIFIED only; a PR URL or open PR is not success. Terminal = automation reached an end state (includes needs-human/failed).</p>
<h2>Tasks (${String(report.summary.totalTasks)})</h2>
<details class="state-map-details" data-persist="state-map"><summary>State map — where tasks are in the lifecycle</summary>
<div class="state-map">${renderStateDiagram(report.summary.byState)}</div>
<p class="muted">Top row is the happy path left to right; dashed boxes are terminal. Box colours match the State badges below (blue Wait, yellow Action needed, red Needs human, green Terminal); shaded boxes contain tasks. Click "map" next to a task's state to outline its box; hover an arrow (or expand Transitions) for what triggers each move. The raw attempt states behind this projection are in architecture.md ("Attempt state machine").</p>
${renderStateTransitionsList()}
</details>
<p class="muted">The State column says who moves each task forward: <span class="next next-wait">Wait</span> automation continues on its own · <span class="next next-operator">Action needed</span> an operator step (usually on the Verification page) is required · <span class="next next-human">Needs human</span> automation stopped · <span class="next next-done">Terminal</span> nothing further happens. Expand "What now?" for details.</p>
<table><thead><tr><th>Issue</th><th>State</th><th>Outcome</th><th>Attempt</th><th>Devin session</th><th>PR</th><th>Verification</th><th>Last updated</th></tr></thead><tbody>${taskRows || '<tr><td colspan="8">No tasks</td></tr>'}</tbody></table>
<p class="muted">Tasks without attempts: ${String(report.tasksWithoutAttempts)}</p>
<section class="collapsible"><details data-persist="ledger"><summary><h2>Remediation evidence ledger (${String(report.ledger.length)})</h2></summary>
<p>Evidence is shown for the current tracked PR head only; verification of earlier heads is listed as stale and is not evidence for the current head. Independent command verification and GitHub Checks are separate. A PR link is not evidence of success; success = VERIFIED only. ACU is shown only when observed (— = unknown, never 0).</p>
<table><thead><tr><th>Issue</th><th>State</th><th>Attempt</th><th>Devin session</th><th>PR</th><th>Command verification</th><th>GitHub Checks</th><th>Approval</th><th>Outcome</th><th>Timestamps</th></tr></thead><tbody>${ledgerRows || '<tr><td colspan="10">No ledger entries</td></tr>'}</tbody></table>
</details></section>
<section class="collapsible"><details data-persist="throughput"><summary><h2>Throughput</h2></summary>
<table><thead><tr><th>Measure</th><th>24h</th><th>7d</th></tr></thead><tbody>${throughputRows}</tbody></table>
<p class="muted">${String(report.summary.terminalWithoutTimestamp)} terminal task(s) have no persisted terminal timestamp and are excluded from terminal throughput / cycle time.</p>
<p>Median intake→terminal cycle time (all historical terminal attempts, n=${String(report.cycleTime.sampleSize)}): ${escapeHtml(formatDuration(report.cycleTime.medianMsIntakeToTerminal))}</p>
</details></section>
</main>
<script>${DASHBOARD_SCRIPT}</script>
</body></html>`;
}

import { escapeHtml, safeHref } from './render-dashboard.js';

export interface OperatorVerificationView {
  task: {
    repoOwner: string;
    repoName: string;
    issueNumber: number;
    issueUrl: string;
    title: string | null;
  };
  attempt: {
    id: number;
    attemptNumber: number;
    state: string;
    outcome: string | null;
    outcomeReason: string | null;
    prUrl: string | null;
    prNumber: number | null;
    prState: string | null;
    prHeadSha: string | null;
  };
  projection: { state: string; reason: string };
  approvalStatus: 'no_candidate' | 'pending_approval' | 'approved';
  candidate: {
    source: string | null;
    shell: string | null;
    script: string | null;
    sha256: string | null;
    updatedAt: number | null;
  };
  approved: {
    sha256: string | null;
    shell: string | null;
    script: string | null;
    approvedBy: string | null;
    approvedAt: number | null;
  };
  agentTestsRun: Array<{ command: string; result: string; notes?: string }>;
  verifications: Array<{
    id: number;
    kind: string;
    status: string;
    reason: string | null;
    headSha: string;
    specSha256: string | null;
    exitCode: number | null;
    evidenceUrl: string | null;
    startedAt: number | null;
    finishedAt: number | null;
    createdAt: number;
    stale: boolean;
  }>;
  rerunAvailable: boolean;
  rerunUnavailableReason: string | null;
}

function formatTime(timestamp: number | null): string {
  return timestamp === null ? '—' : new Date(timestamp).toISOString();
}

function renderScript(script: string | null): string {
  return script === null ? '—' : `<pre>${escapeHtml(script)}</pre>`;
}

export function renderOperatorVerificationPage(
  view: OperatorVerificationView,
  notice?: { level: 'error' | 'info'; message: string }
): string {
  const candidateScript = view.candidate.script ?? '';
  const issueHref = safeHref(view.task.issueUrl);
  const issue = issueHref
    ? `<a href="${escapeHtml(issueHref)}">${escapeHtml(view.task.repoOwner)}/${escapeHtml(view.task.repoName)}#${String(view.task.issueNumber)}</a>`
    : escapeHtml(view.task.issueUrl);
  const prHref = safeHref(view.attempt.prUrl);
  const pr =
    view.attempt.prUrl === null
      ? '—'
      : prHref
        ? `<a href="${escapeHtml(prHref)}">PR${view.attempt.prNumber === null ? '' : ` #${String(view.attempt.prNumber)}`}</a>`
        : escapeHtml(view.attempt.prUrl);
  const noticeHtml = notice
    ? `<p class="notice ${escapeHtml(notice.level)}">${escapeHtml(notice.message)}</p>`
    : '';
  const agentTests =
    view.agentTestsRun.length === 0
      ? '<p>None reported.</p>'
      : `<ul>${view.agentTestsRun
          .map(
            (test) =>
              `<li><code>${escapeHtml(test.command)}</code> — ${escapeHtml(test.result)}${test.notes === undefined ? '' : ` — ${escapeHtml(test.notes)}`}</li>`
          )
          .join('')}</ul>`;
  const candidate =
    view.candidate.sha256 === null
      ? '<p>no_candidate</p>'
      : `<p>Status: <strong>${escapeHtml(view.approvalStatus)}</strong>; source: ${escapeHtml(view.candidate.source ?? '—')}; shell: ${escapeHtml(view.candidate.shell ?? '—')}; sha256: <code>${escapeHtml(view.candidate.sha256)}</code>; updated: ${escapeHtml(formatTime(view.candidate.updatedAt))}</p>${renderScript(view.candidate.script)}`;
  const proposeForm = `<form method="post" action="/operator/attempts/${String(view.attempt.id)}/verification/propose">
<label>Replace candidate script<br><textarea name="script" rows="8" maxlength="65536">${escapeHtml(candidateScript)}</textarea></label>
<label>Shell <select name="shell"><option value="sh"${view.candidate.shell === 'sh' ? ' selected' : ''}>sh</option><option value="bash"${view.candidate.shell === 'bash' ? ' selected' : ''}>bash</option></select></label>
<button type="submit">Propose candidate</button>
</form>`;
  const approve =
    view.approvalStatus === 'pending_approval' && view.candidate.sha256 !== null
      ? `<form method="post" action="/operator/attempts/${String(view.attempt.id)}/verification/approve"><input type="hidden" name="spec_sha256" value="${escapeHtml(view.candidate.sha256)}"><button type="submit">Approve ${escapeHtml(view.candidate.sha256)}</button></form>`
      : '<p>No pending candidate approval.</p>';
  const approved =
    view.approved.sha256 === null
      ? '<p>None.</p>'
      : `<p>sha256: <code>${escapeHtml(view.approved.sha256)}</code>; shell: ${escapeHtml(view.approved.shell ?? '—')}; approved by: ${escapeHtml(view.approved.approvedBy ?? '—')}; approved at: ${escapeHtml(formatTime(view.approved.approvedAt))}</p>${renderScript(view.approved.script)}`;
  const rows =
    view.verifications.length === 0
      ? '<tr><td colspan="9">No independent verification results.</td></tr>'
      : view.verifications
          .map((row) => {
            const evidenceHref = safeHref(row.evidenceUrl);
            const evidence =
              row.evidenceUrl === null
                ? '—'
                : evidenceHref
                  ? `<a href="${escapeHtml(evidenceHref)}">evidence</a>`
                  : escapeHtml(row.evidenceUrl);
            return `<tr><td>${String(row.id)}</td><td>${escapeHtml(row.kind)}</td><td>${escapeHtml(row.status)}${row.stale ? ' <strong>stale</strong>' : ' <strong>current-head</strong>'}</td><td>${escapeHtml(row.reason ?? '—')}</td><td>${escapeHtml(row.headSha)}</td><td>${escapeHtml(row.specSha256 ?? '—')}</td><td>${row.exitCode === null ? '—' : String(row.exitCode)}</td><td>${escapeHtml(formatTime(row.startedAt))}<br>${escapeHtml(formatTime(row.finishedAt))}<br>${escapeHtml(formatTime(row.createdAt))}</td><td>${evidence}</td></tr>`;
          })
          .join('');
  const rerun = view.rerunAvailable
    ? `<form method="post" action="/operator/attempts/${String(view.attempt.id)}/verification/rerun"><p><strong>Warning:</strong> this runs checkout, repository setup and the approved shell script synchronously; it may take many minutes.</p><button type="submit">Explicitly rerun approved verification</button></form>`
    : `<p><strong>Rerun unavailable:</strong> ${escapeHtml(view.rerunUnavailableReason ?? 'not available')}</p>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Operator verification</title>
<style>body{font:14px system-ui,sans-serif;line-height:1.4;margin:2rem;color:#18212b;background:#f7f8fa}main{max-width:1200px;margin:auto;background:#fff;padding:1.5rem;border:1px solid #d8dee4;border-radius:6px}h1{margin-top:0}.notice{padding:.75rem;border-radius:4px}.notice.error{background:#ffebe9;color:#cf222e}.notice.info{background:#ddf4ff;color:#0969da}section{margin:1.5rem 0}table{border-collapse:collapse;width:100%;overflow:auto}th,td{border:1px solid #d8dee4;padding:.5rem;text-align:left;vertical-align:top}th{background:#eef1f4}textarea{display:block;width:100%;max-width:900px;margin:.5rem 0 1rem}pre{white-space:pre-wrap;background:#f6f8fa;padding:.75rem;border:1px solid #d8dee4}label,select,button{display:block;margin:.5rem 0}a{color:#0969da}code{overflow-wrap:anywhere}</style></head>
<body><main><p><a href="/dashboard">← Back to dashboard</a></p><h1>Operator verification</h1>${noticeHtml}
<section><h2>Task / attempt</h2><p>Task: ${issue} — ${escapeHtml(view.task.title ?? '(untitled)')}</p><p>Attempt #${String(view.attempt.attemptNumber)} (id ${String(view.attempt.id)}): ${escapeHtml(view.attempt.state)} / ${escapeHtml(view.attempt.outcome ?? '—')} / ${escapeHtml(view.attempt.outcomeReason ?? '—')}</p><p>Normalized state: <strong>${escapeHtml(view.projection.state)}</strong> / ${escapeHtml(view.projection.reason)}</p><p>Pull request: ${pr} (${escapeHtml(view.attempt.prState ?? 'unknown')}); head: <code>${escapeHtml(view.attempt.prHeadSha ?? '—')}</code></p></section>
<section><h2>Agent-reported tests_run (agent claim, not verification)</h2>${agentTests}</section>
<section><h2>Candidate verification spec</h2>${candidate}${proposeForm}</section>
<section><h2>Operator-approved spec</h2>${approved}${approve}</section>
<section><h2>Independent verification results</h2><table><thead><tr><th>ID</th><th>Kind</th><th>Status</th><th>Reason</th><th>Head</th><th>Spec SHA</th><th>Exit</th><th>Timestamps</th><th>Evidence</th></tr></thead><tbody>${rows}</tbody></table></section>
<section><h2>Explicit rerun</h2>${rerun}</section>
</main></body></html>`;
}

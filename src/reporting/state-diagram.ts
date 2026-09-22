import {
  NORMALIZED_TASK_STATES,
  type NormalizedTaskState,
} from '../tracking/normalized-task-state.js';
import { escapeHtml } from './html.js';

/**
 * Normalized task-state map rendered as inline SVG (no client-side scripts).
 * Edges mirror how `deriveTaskState` moves between values as the raw attempt
 * state machine (architecture.md) advances; each node carries the number of
 * tasks currently in that state and can be highlighted via the URL fragment
 * (`#state-VERIFYING`), which the Tasks table links to.
 */

export interface StateEdge {
  from: NormalizedTaskState;
  to: NormalizedTaskState;
  label: string;
}

export const STATE_EDGES: StateEdge[] = [
  { from: 'QUEUED', to: 'DISPATCHING', label: 'dispatcher claims' },
  { from: 'DISPATCHING', to: 'QUEUED', label: 'Devin 4xx / transient error' },
  { from: 'DISPATCHING', to: 'RUNNING', label: 'session created / adopted' },
  { from: 'RUNNING', to: 'PR_OPEN', label: 'session finished, PR verified' },
  { from: 'PR_OPEN', to: 'VERIFYING', label: 'verification spec proposed' },
  { from: 'VERIFYING', to: 'CI_PENDING', label: 'GitHub checks running' },
  { from: 'CI_PENDING', to: 'VERIFYING', label: 'checks finished' },
  { from: 'VERIFYING', to: 'VERIFIED', label: 'approved command passed' },
  { from: 'VERIFYING', to: 'VERIFICATION_FAILED', label: 'approved command failed' },
  { from: 'VERIFICATION_FAILED', to: 'VERIFYING', label: 'new commits on PR' },
  { from: 'VERIFIED', to: 'PR_OPEN', label: 'PR head superseded' },
  { from: 'QUEUED', to: 'CANCELLED', label: 'issue closed / label removed' },
  { from: 'DISPATCHING', to: 'FAILED', label: 'ineligible / attempt:requeue' },
  { from: 'RUNNING', to: 'NO_ACTION', label: 'agent: no change needed' },
  { from: 'RUNNING', to: 'FAILED', label: 'agent failed' },
  { from: 'RUNNING', to: 'NEEDS_HUMAN', label: 'escalated / bad output' },
  { from: 'PR_OPEN', to: 'NEEDS_HUMAN', label: 'PR closed or merged early' },
  { from: 'VERIFYING', to: 'NEEDS_HUMAN', label: 'PR closed or merged early' },
];

const NODE_W = 150;
const NODE_H = 44;
const COL = 190;
const ROW = 100;
const PAD = 20;

// [column, row] on a grid: row 0 is the happy path, row 1 verification side states, row 2 terminal states.
const LAYOUT: Record<NormalizedTaskState, [number, number]> = {
  QUEUED: [0, 0],
  DISPATCHING: [1, 0],
  RUNNING: [2, 0],
  PR_OPEN: [3, 0],
  VERIFYING: [4, 0],
  VERIFIED: [5, 0],
  CI_PENDING: [4, 1],
  VERIFICATION_FAILED: [5, 1],
  CANCELLED: [0, 2],
  FAILED: [1, 2],
  NO_ACTION: [2, 2],
  NEEDS_HUMAN: [3, 2],
};

const KIND: Record<NormalizedTaskState, 'active' | 'success' | 'terminal'> = {
  QUEUED: 'active',
  DISPATCHING: 'active',
  RUNNING: 'active',
  PR_OPEN: 'active',
  CI_PENDING: 'active',
  VERIFYING: 'active',
  VERIFICATION_FAILED: 'active',
  VERIFIED: 'success',
  NEEDS_HUMAN: 'terminal',
  NO_ACTION: 'terminal',
  FAILED: 'terminal',
  CANCELLED: 'terminal',
};

interface Point {
  x: number;
  y: number;
}

function center(state: NormalizedTaskState): Point {
  const [col, row] = LAYOUT[state];
  return { x: PAD + col * COL + NODE_W / 2, y: PAD + row * ROW + NODE_H / 2 };
}

/** Point on the border of `state`'s box along the ray from its center toward `toward`. */
function border(state: NormalizedTaskState, toward: Point): Point {
  const c = center(state);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const sx = dx === 0 ? Number.POSITIVE_INFINITY : NODE_W / 2 / Math.abs(dx);
  const sy = dy === 0 ? Number.POSITIVE_INFINITY : NODE_H / 2 / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: c.x + dx * s, y: c.y + dy * s };
}

const fmt = (n: number): string => n.toFixed(1);

function renderEdge(edge: StateEdge, bidirectional: boolean): string {
  const c1 = center(edge.from);
  const c2 = center(edge.to);
  // Offset paired edges so A->B and B->A do not overlap.
  let ox = 0;
  let oy = 0;
  if (bidirectional) {
    const len = Math.hypot(c2.x - c1.x, c2.y - c1.y) || 1;
    ox = (-(c2.y - c1.y) / len) * 7;
    oy = ((c2.x - c1.x) / len) * 7;
  }
  const p1 = border(edge.from, c2);
  const p2 = border(edge.to, c1);
  const x1 = p1.x + ox;
  const y1 = p1.y + oy;
  const x2 = p2.x + ox;
  const y2 = p2.y + oy;
  const title = `${edge.from} → ${edge.to}: ${edge.label}`;
  return `<g class="edge"><title>${escapeHtml(title)}</title><line x1="${fmt(x1)}" y1="${fmt(y1)}" x2="${fmt(x2)}" y2="${fmt(y2)}" marker-end="url(#arrow)"/></g>`;
}

function renderNode(state: NormalizedTaskState, count: number): string {
  const [col, row] = LAYOUT[state];
  const x = PAD + col * COL;
  const y = PAD + row * ROW;
  const cls = `state-node kind-${KIND[state]}${count > 0 ? ' occupied' : ''}`;
  return `<g id="state-${state}" class="${cls}"><title>${escapeHtml(`${state}: ${String(count)} task(s)`)}</title><rect x="${String(x)}" y="${String(y)}" width="${String(NODE_W)}" height="${String(NODE_H)}" rx="6"/><text class="name" x="${String(x + NODE_W / 2)}" y="${String(y + 19)}">${escapeHtml(state)}</text><text class="count" x="${String(x + NODE_W / 2)}" y="${String(y + 36)}">${String(count)} task${count === 1 ? '' : 's'}</text></g>`;
}

/** Text legend for the arrows, in a definition list so the diagram itself stays readable. */
export function renderStateTransitionsList(): string {
  const items = STATE_EDGES.map(
    (edge) =>
      `<li><a href="#state-${edge.from}">${escapeHtml(edge.from)}</a> → <a href="#state-${edge.to}">${escapeHtml(edge.to)}</a>: ${escapeHtml(edge.label)}</li>`
  ).join('');
  return `<details class="transitions"><summary>Transitions (${String(STATE_EDGES.length)})</summary><ul>${items}</ul></details>`;
}

export function renderStateDiagram(counts: Partial<Record<NormalizedTaskState, number>>): string {
  const cols = Math.max(...Object.values(LAYOUT).map(([col]) => col)) + 1;
  const rows = Math.max(...Object.values(LAYOUT).map(([, row]) => row)) + 1;
  const width = PAD * 2 + (cols - 1) * COL + NODE_W;
  const height = PAD * 2 + (rows - 1) * ROW + NODE_H;
  const reverse = new Set(STATE_EDGES.map((edge) => `${edge.to}>${edge.from}`));
  const edges = STATE_EDGES.map((edge) =>
    renderEdge(edge, reverse.has(`${edge.from}>${edge.to}`))
  ).join('');
  const nodes = NORMALIZED_TASK_STATES.map((state) => renderNode(state, counts[state] ?? 0)).join(
    ''
  );
  return `<svg class="state-diagram" viewBox="0 0 ${String(width)} ${String(height)}" width="${String(width)}" height="${String(height)}" role="img" aria-label="Normalized task state map"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z"/></marker></defs>${edges}${nodes}</svg>`;
}

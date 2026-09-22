import { describe, expect, it } from 'vitest';
import { NORMALIZED_TASK_STATES } from '../src/tracking/normalized-task-state.js';
import { STATE_EDGES, renderStateDiagram } from '../src/reporting/state-diagram.js';

describe('renderStateDiagram', () => {
  it('draws every normalized state as an anchorable node with its count', () => {
    const svg = renderStateDiagram({ VERIFYING: 2, QUEUED: 1 });
    for (const state of NORMALIZED_TASK_STATES) {
      expect(svg).toContain(`id="state-${state}"`);
    }
    expect(svg).toContain('2 tasks');
    expect(svg).toContain('1 task<');
    expect(svg).toMatch(/id="state-VERIFYING" class="[^"]*occupied/);
    expect(svg).not.toMatch(/id="state-FAILED" class="[^"]*occupied/);
    expect(svg).not.toContain('<script');
  });

  it('only connects known states and covers every state with at least one edge', () => {
    const states = new Set<string>(NORMALIZED_TASK_STATES);
    const touched = new Set<string>();
    for (const edge of STATE_EDGES) {
      expect(states.has(edge.from)).toBe(true);
      expect(states.has(edge.to)).toBe(true);
      touched.add(edge.from);
      touched.add(edge.to);
    }
    expect([...states].filter((state) => !touched.has(state))).toEqual([]);
  });
});

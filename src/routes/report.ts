import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RUN_KINDS, runKindSchema, type RunKind } from '../db/schema.js';
import { buildReport, type ReportFilter } from '../reporting/report-model.js';
import { renderDashboard } from '../reporting/render-dashboard.js';

const querySchema = z.object({
  run_kind: z.string().optional(),
});

function parseFilter(request: FastifyRequest, reply: FastifyReply): ReportFilter | undefined {
  const query = querySchema.safeParse(request.query);
  if (!query.success) {
    void reply.code(400).send({ error: 'invalid run_kind', allowed: RUN_KINDS });
    return undefined;
  }
  if (query.data.run_kind === undefined) {
    return { runKinds: ['real'] };
  }
  const values = query.data.run_kind.split(',');
  const parsed = values.map((value) => runKindSchema.safeParse(value));
  if (
    values.length === 0 ||
    values.some((value) => value.length === 0) ||
    parsed.some((result) => !result.success)
  ) {
    void reply.code(400).send({ error: 'invalid run_kind', allowed: RUN_KINDS });
    return undefined;
  }
  return {
    runKinds: [
      ...new Set(parsed.map((result) => (result.success ? result.data : 'unknown'))),
    ] as RunKind[],
  };
}

export function reportRoutes(fastify: FastifyInstance) {
  fastify.get('/api/report', async (request, reply) => {
    const filter = parseFilter(request, reply);
    if (!filter) return reply;
    reply.header('Cache-Control', 'no-store');
    return reply.code(200).send(buildReport({ filter }));
  });

  fastify.get('/dashboard', async (request, reply) => {
    const filter = parseFilter(request, reply);
    if (!filter) return reply;
    reply.type('text/html; charset=utf-8');
    return reply.code(200).send(renderDashboard(buildReport({ filter })));
  });
}

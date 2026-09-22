import type { FastifyInstance } from 'fastify';
import { buildReport } from '../reporting/report-model.js';
import { renderDashboard } from '../reporting/render-dashboard.js';
import { ALL_WORKERS_ENABLED, type WorkerAvailability } from '../reporting/state-guidance.js';

export interface ReportRoutesOptions {
  workers?: WorkerAvailability;
}

export function reportRoutes(fastify: FastifyInstance, opts: ReportRoutesOptions) {
  const workers = opts.workers ?? ALL_WORKERS_ENABLED;

  fastify.get('/api/report', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return reply.code(200).send(buildReport({}));
  });

  fastify.get('/dashboard', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.type('text/html; charset=utf-8');
    return reply.code(200).send(renderDashboard(buildReport({}), workers));
  });
}

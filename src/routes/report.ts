import type { FastifyInstance } from 'fastify';
import { buildReport } from '../reporting/report-model.js';
import { renderDashboard } from '../reporting/render-dashboard.js';

export function reportRoutes(fastify: FastifyInstance) {
  fastify.get('/api/report', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return reply.code(200).send(buildReport({}));
  });

  fastify.get('/dashboard', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.type('text/html; charset=utf-8');
    return reply.code(200).send(renderDashboard(buildReport({})));
  });
}

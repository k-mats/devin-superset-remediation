import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getDb, getRawDb } from '../db/client.js';

export function healthRoutes(fastify: FastifyInstance) {
  fastify.get('/health', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(200).send({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  });

  fastify.get('/ready', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      // Test database connectivity with actual query
      void getDb();
      const sqlite = getRawDb();
      if (!sqlite) {
        throw new Error('Database not initialized');
      }
      // Perform a simple SELECT 1 query to verify database connectivity
      sqlite.prepare('SELECT 1').get();

      await reply.code(200).send({
        status: 'ready',
        database: 'connected',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Readiness check failed:', error);
      await reply.code(503).send({
        status: 'not_ready',
        database: 'disconnected',
        timestamp: new Date().toISOString(),
      });
    }
  });
}

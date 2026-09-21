import type { FastifyInstance } from 'fastify';
import {
  handleGitHubWebhook,
  verifyGitHubSignature,
  type GitHubWebhookOptions,
} from '../intake/github-webhook.js';

export interface GitHubWebhookRouteOptions extends GitHubWebhookOptions {
  secret: string;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * `POST /webhooks/github`. Registered as an encapsulated plugin so the
 * buffer-preserving JSON parser below applies to this route only; other routes
 * keep Fastify's default JSON parsing.
 */
export function githubWebhookRoutes(fastify: FastifyInstance, opts: GitHubWebhookRouteOptions) {
  fastify.removeAllContentTypeParsers();
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_request, body: Buffer, done) => {
      done(null, body);
    }
  );

  fastify.post('/webhooks/github', async (request, reply) => {
    const deliveryId = headerValue(request.headers['x-github-delivery']);
    const event = headerValue(request.headers['x-github-event']);
    const rawBody = request.body;
    if (!Buffer.isBuffer(rawBody)) {
      return reply.code(415).send({ error: 'Unsupported content type' });
    }

    const signature = headerValue(request.headers['x-hub-signature-256']);
    if (!verifyGitHubSignature(rawBody, signature, opts.secret)) {
      fastify.log.warn(
        { delivery_id: deliveryId, event, signature_present: signature !== undefined },
        'Rejected GitHub webhook with missing or invalid signature'
      );
      return reply.code(401).send({ error: 'Invalid signature' });
    }

    const outcome = handleGitHubWebhook({ event, deliveryId, rawBody }, opts);
    if (outcome.status === 'invalid_payload') {
      return reply.code(400).send({ error: outcome.message });
    }
    return reply.code(200).send(outcome);
  });
}

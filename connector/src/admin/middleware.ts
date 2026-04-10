/**
 * JWT authentication middleware for admin API
 */
import type { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';

export interface JwtPayload {
  role: string;
  iat?: number;
  exp?: number;
}

export async function registerAuth(fastify: FastifyInstance): Promise<void> {
  const secret = process.env.ADMIN_JWT_SECRET;
  if (!secret) {
    throw new Error('ADMIN_JWT_SECRET environment variable is required');
  }

  await fastify.register(fastifyJwt, {
    secret,
    sign: { expiresIn: '8h' },
  });

  fastify.post('/api/admin/login', async (request, reply) => {
    const { username, password } = request.body as { username?: string; password?: string };
    if (
      username === process.env.ADMIN_USERNAME &&
      password === process.env.ADMIN_PASSWORD
    ) {
      const token = await reply.jwtSign({ role: 'admin' });
      return { token, expiresIn: '8h' };
    }
    return reply.status(401).send({ error: 'Invalid credentials' });
  });
}

export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    await request.jwtVerify();
    // Attach decoded user for ownership guard
    (request as any).user = request.user;
  } catch {
    return reply.status(401).send({ error: 'Unauthorized' });
  }
}

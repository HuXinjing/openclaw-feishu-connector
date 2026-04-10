/**
 * 用户管理路由 - 支持自动创建容器
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import { findAllUsers, findUserByOpenId, createUser, updateUser, deleteUser, updateUserStatus, generateGatewayToken, getNextGatewayPort } from '../../user-map.js';
import { getNetworkProfile } from '../../lib/network-acl.js';
import { CreateUserSchema, UpdateUserSchema } from '../schemas.js';
import { createUserContainer, startUserContainer, stopUserContainer, restartUserContainer, removeUserContainer, getUserGatewayUrl, initDocker, getUserContainerConfig, updateUserContainerConfig, getGatewayAuthToken } from '../../docker.js';
import { requireAuth } from '../middleware.js';
import { resolveAuthContext, requireOwnership } from '../../lib/ownership.js';

const HOOKS_TOKEN_SALT = process.env.HOOKS_TOKEN_SALT || 'default-salt-change-me';
const DATA_DIR = process.env.DATA_DIR || './data/users';
const OPENCLAW_IMAGE = process.env.OPENCLAW_IMAGE || 'openclaw/openclaw:latest';

initDocker({
  host: process.env.DOCKER_HOST || 'localhost',
  port: parseInt(process.env.DOCKER_PORT || '2375'),
  openclawImage: OPENCLAW_IMAGE,
  dataDir: DATA_DIR,
  gatewayBasePort: parseInt(process.env.GATEWAY_BASE_PORT || '18790'),
});

export function registerUserRoutes(fastify: any) {
  // Wrap in scoped plugin so auth only applies to /api/admin/users/* routes, not globally
  fastify.register(async (f: any) => {
    f.addHook('onRequest', requireAuth);
    f.get('/api/admin/users', async (request: FastifyRequest) => {
    // Non-admin users only see themselves
    const ctx = resolveAuthContext(request);
    if (ctx && !ctx.isAdmin) {
      const user = findUserByOpenId(ctx.openId);
      return user ? [user] : [];
    }
    const users = findAllUsers();
    // Enrich each user with name + avatar from user_network_profile (Feishu sync)
    const aclMap = await Promise.all(users.map(u => getNetworkProfile(u.spec.feishuOpenId)));
    return users.map((u, i) => {
      const acl = aclMap[i];
      return {
        ...u,
        spec: {
          ...u.spec,
          // Prefer ACL-sourced name/avatar; fall back to stored spec values
          userName: acl?.user_name || u.spec.userName || null,
          avatarUrl: acl?.avatar_url || null,
        },
      };
    });
  });

  f.get('/api/admin/users/:openId', async (request: FastifyRequest, reply: FastifyReply) => {
    const { openId } = request.params as { openId: string };
    const ctx = resolveAuthContext(request);
    if (ctx && !requireOwnership(ctx, openId, reply)) return;
    const user = findUserByOpenId(openId);
    if (!user) return reply.status(404).send({ error: 'User not found' });
    return user;
  });

  f.post('/api/admin/users', async (request: FastifyRequest, reply: FastifyReply) => {
    const parseResult = CreateUserSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: parseResult.error.message });
    }
    const { feishuOpenId, userName, auto_start } = parseResult.data;

    const existing = findUserByOpenId(feishuOpenId);
    if (existing) return reply.status(409).send({ error: 'User already exists' });

    const gatewayToken = generateGatewayToken(feishuOpenId, HOOKS_TOKEN_SALT);
    const port = getNextGatewayPort();
    const gatewayUrl = getUserGatewayUrl(feishuOpenId, port);
    const user = await createUser(feishuOpenId, gatewayUrl, gatewayToken, userName, port);

    if (auto_start) {
      try {
        const containerId = await createUserContainer(user, gatewayToken, '', port);
        await updateUser(feishuOpenId, { containerId: containerId });
        await startUserContainer(containerId);
        // Wait for Gateway to start and generate its auth token (with retry)
        const actualAuthToken = await getGatewayAuthToken(containerId);
        await updateUserStatus(feishuOpenId, 'active', containerId, actualAuthToken, undefined, port);
        return { success: true, user: { feishuOpenId: user.spec.feishuOpenId, userName: user.spec.userName, status: 'active', gatewayUrl, containerId, gatewayAuthToken: actualAuthToken } };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(500).send({ error: `Failed to create container: ${errMsg}` });
      }
    }
    return { success: true, user: { feishuOpenId: user.spec.feishuOpenId, userName: user.spec.userName, status: user.status.phase, gatewayUrl } };
  });

  f.post('/api/admin/users/:openId/create-container', async (request: FastifyRequest, reply: FastifyReply) => {
    const { openId } = request.params as { openId: string };
    const ctx = resolveAuthContext(request);
    if (ctx && !requireOwnership(ctx, openId, reply)) return;
    const user = findUserByOpenId(openId);
    if (!user) return reply.status(404).send({ error: 'User not found' });
    if (user.status.containerId) return reply.status(400).send({ error: 'Container already exists' });

    try {
      const port = getNextGatewayPort();
      const gatewayUrl = getUserGatewayUrl(openId, port);
      await updateUser(openId, { gatewayUrl });
      const containerId = await createUserContainer(user, user.spec.hooksToken, '');
      await updateUser(openId, { containerId });
      await startUserContainer(containerId);
      await new Promise(resolve => setTimeout(resolve, 5000));
      const actualAuthToken = await getGatewayAuthToken(containerId);
      updateUserStatus(openId, 'active', containerId, actualAuthToken);
      return { success: true, containerId, gatewayUrl, gatewayAuthToken: actualAuthToken };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      return reply.status(500).send({ error: errMsg });
    }
  });

  f.put('/api/admin/users/:openId', async (request: FastifyRequest, reply: FastifyReply) => {
    const { openId } = request.params as { openId: string };
    const ctx = resolveAuthContext(request);
    if (ctx && !requireOwnership(ctx, openId, reply)) return;
    const parseResult = UpdateUserSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: parseResult.error.message });
    }
    const user = findUserByOpenId(openId);
    if (!user) return reply.status(404).send({ error: 'User not found' });
    await updateUser(openId, { userName: parseResult.data.userName });
    return { success: true };
  });

  f.delete('/api/admin/users/:openId', async (request: FastifyRequest, reply: FastifyReply) => {
    const { openId } = request.params as { openId: string };
    const ctx = resolveAuthContext(request);
    if (ctx && !requireOwnership(ctx, openId, reply)) return;
    const user = findUserByOpenId(openId);
    if (!user) return reply.status(404).send({ error: 'User not found' });
    if (user.status.containerId) {
      try { await removeUserContainer(user.status.containerId); }
      catch (e) { console.error('Failed to remove container:', e); }
    }
    await deleteUser(openId);
    return { success: true };
  });

  f.post('/api/admin/users/:openId/start', async (request: FastifyRequest, reply: FastifyReply) => {
    const { openId } = request.params as { openId: string };
    const ctx = resolveAuthContext(request);
    if (ctx && !requireOwnership(ctx, openId, reply)) return;
    const user = findUserByOpenId(openId);
    if (!user) return reply.status(404).send({ error: 'User not found' });
    if (!user.status.containerId) return reply.status(400).send({ error: 'No container associated with user' });
    await startUserContainer(user.status.containerId);
    await updateUserStatus(openId, 'active');
    return { success: true };
  });

  f.post('/api/admin/users/:openId/stop', async (request: FastifyRequest, reply: FastifyReply) => {
    const { openId } = request.params as { openId: string };
    const ctx = resolveAuthContext(request);
    if (ctx && !requireOwnership(ctx, openId, reply)) return;
    const user = findUserByOpenId(openId);
    if (!user) return reply.status(404).send({ error: 'User not found' });
    if (!user.status.containerId) return reply.status(400).send({ error: 'No container associated with user' });
    await stopUserContainer(user.status.containerId);
    await updateUserStatus(openId, 'stopped');
    return { success: true };
  });

  f.post('/api/admin/users/:openId/restart', async (request: FastifyRequest, reply: FastifyReply) => {
    const { openId } = request.params as { openId: string };
    const ctx = resolveAuthContext(request);
    if (ctx && !requireOwnership(ctx, openId, reply)) return;
    const user = findUserByOpenId(openId);
    if (!user) return reply.status(404).send({ error: 'User not found' });
    if (!user.status.containerId) return reply.status(400).send({ error: 'No container associated with user' });
    await restartUserContainer(user.status.containerId);
    await updateUserStatus(openId, 'active');
    return { success: true };
  });

  f.get('/api/admin/users/:openId/config', async (request: FastifyRequest, reply: FastifyReply) => {
    const { openId } = request.params as { openId: string };
    const ctx = resolveAuthContext(request);
    if (ctx && !requireOwnership(ctx, openId, reply)) return;
    const user = findUserByOpenId(openId);
    if (!user) return reply.status(404).send({ error: 'User not found' });
    if (!user.status.containerId) return reply.status(400).send({ error: 'No container associated with user' });
    try {
      const config = await getUserContainerConfig(openId);
      return config;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      return reply.status(500).send({ error: `Failed to get config: ${errMsg}` });
    }
  });

  f.put('/api/admin/users/:openId/config', async (request: FastifyRequest, reply: FastifyReply) => {
    const { openId } = request.params as { openId: string };
    const config = request.body;
    const ctx = resolveAuthContext(request);
    if (ctx && !requireOwnership(ctx, openId, reply)) return;
    const user = findUserByOpenId(openId);
    if (!user) return reply.status(404).send({ error: 'User not found' });
    if (!user.status.containerId) return reply.status(400).send({ error: 'No container associated with user' });
    try {
      await updateUserContainerConfig(openId, config);
      return { success: true };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      return reply.status(500).send({ error: `Failed to update config: ${errMsg}` });
    }
  });

  // Task 9: PUT /api/admin/users/:openId/quota — update user quota
  f.put('/api/admin/users/:openId/quota', async (request: FastifyRequest, reply: FastifyReply) => {
    const { openId } = request.params as { openId: string };
    const ctx = resolveAuthContext(request);
    if (ctx && !requireOwnership(ctx, openId, reply)) return;
    const body = request.body as Partial<import('../../types.js').UserQuota>;
    const { setUserQuota } = await import('../../lib/quota.js');
    setUserQuota(openId, body);
    return { success: true };
  });
  });
}

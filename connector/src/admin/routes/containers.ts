/**
 * 容器管理路由
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import { listOpenclawContainers, getContainerLogs, startContainer, stopContainer, restartContainer, getContainerConfig, updateContainerConfig } from '../../docker.js';
import { requireAuth } from '../middleware.js';
import { ContainerIdSchema, ContainerNameSchema } from '../schemas.js';

export function registerContainerRoutes(fastify: any) {
  fastify.register(async (f: any) => {
    f.addHook('onRequest', requireAuth);
    // 列出所有 OpenClaw 容器
    f.get('/api/admin/containers', async () => {
      return listOpenclawContainers();
    });

    // 启动容器
    f.post('/api/admin/containers/:containerId/start', async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = ContainerIdSchema.safeParse(request.params);
      if (!parseResult.success) return reply.status(400).send({ error: parseResult.error.message });
      const { containerId } = parseResult.data;
      try {
        await startContainer(containerId);
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(500).send({ error: message });
      }
    });

    // 停止容器
    f.post('/api/admin/containers/:containerId/stop', async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = ContainerIdSchema.safeParse(request.params);
      if (!parseResult.success) return reply.status(400).send({ error: parseResult.error.message });
      const { containerId } = parseResult.data;
      try {
        await stopContainer(containerId);
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(500).send({ error: message });
      }
    });

    // 重启容器
    f.post('/api/admin/containers/:containerId/restart', async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = ContainerIdSchema.safeParse(request.params);
      if (!parseResult.success) return reply.status(400).send({ error: parseResult.error.message });
      const { containerId } = parseResult.data;
      try {
        await restartContainer(containerId);
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(500).send({ error: message });
      }
    });

    // 获取容器配置
    f.get('/api/admin/container-config/:containerName', async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = ContainerNameSchema.safeParse(request.params);
      if (!parseResult.success) return reply.status(400).send({ error: parseResult.error.message });
      const { containerName } = parseResult.data;
      try {
        const config = await getContainerConfig(containerName);
        return config;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(500).send({ error: message });
      }
    });

    // 更新容器配置并重启
    f.put('/api/admin/container-config/:containerName', async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = ContainerNameSchema.safeParse(request.params);
      if (!parseResult.success) return reply.status(400).send({ error: parseResult.error.message });
      const { containerName } = parseResult.data;
      const config = request.body;
      try {
        await updateContainerConfig(containerName, config);
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(500).send({ error: message });
      }
    });

    // 获取容器日志
    f.get('/api/admin/container-logs/:containerName', async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = ContainerNameSchema.safeParse(request.params);
      if (!parseResult.success) return reply.status(400).send({ error: parseResult.error.message });
      const { containerName } = parseResult.data;
      const { lines } = request.query as { lines?: string };
      try {
        const logs = await getContainerLogs(containerName, lines ? parseInt(lines) : 100);
        return logs;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(500).send({ error: message });
      }
    });
  });
}

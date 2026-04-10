/**
 * Skill 管理 API - 管理员接口
 */
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { initSkillStore, getAllRequests, getPendingRequests, approveRequest, rejectRequest, getApprovedSkills, getRequest } from '../skill-store.js';
import { broadcastSkillToContainers, restartAllUserGateways } from '../docker.js';

export async function skillAdminRoutes(fastify: FastifyInstance) {
  // 初始化 store
  await initSkillStore();

  // 获取所有 skill 请求
  fastify.get('/api/admin/skills', async () => {
    const requests = getPendingRequests();  // 只返回待审批的请求
    const approved = getApprovedSkills();
    return { requests, approved };
  });

  // 获取单个技能的详情（用于审核代码）
  fastify.get('/api/admin/skills/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const requestId = parseInt(id);
    const skill = getRequest(requestId);

    if (!skill) {
      return reply.status(404).send({ error: 'Skill not found' });
    }

    return skill;
  });

  // 获取待审批的请求
  fastify.get('/api/admin/skills/pending', async () => {
    return { requests: getPendingRequests() };
  });

  // 批准 skill 请求
  fastify.post('/api/admin/skills/:id/approve', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const requestId = parseInt(id);

    const approved = await approveRequest(requestId, 'admin');
    if (!approved) {
      return reply.status(404).send({ error: 'Request not found or already processed' });
    }

    // 如果是 proxy 类型，添加到 Connector
    if (approved.type === 'proxy') {
      // TODO: 注册到 Connector API
      console.log('📦 Proxy skill approved:', approved.name);
    }

    // 如果是 skill 类型，广播到所有容器
    if (approved.type === 'skill') {
      try {
        await broadcastSkillToContainers(approved);
        await restartAllUserGateways();
        console.log('📢 Skill broadcasted and gateways restarted');
      } catch (error) {
        console.error('Failed to broadcast skill:', error);
      }
    }

    return { success: true, skill: approved };
  });

  // 拒绝 skill 请求
  fastify.post('/api/admin/skills/:id/reject', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const requestId = parseInt(id);

    const rejected = await rejectRequest(requestId, 'admin');
    if (!rejected) {
      return reply.status(404).send({ error: 'Request not found or already processed' });
    }

    return { success: true, skill: rejected };
  });
}

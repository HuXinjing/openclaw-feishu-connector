/**
 * 管理后台入口
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 加载 .env — __dirname is .../src/admin, .env is at planC/.env
dotenv.config({ path: join(__dirname, '../../../.env') });

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { registerUserRoutes } from './routes/users.js';
import { registerContainerRoutes } from './routes/containers.js';
import { registerImportRoutes } from './routes/import.js';
import { registerNetworkRoutes } from './routes/network.js';
import { registerDLQRoutes } from './routes/dlq.js';
import { registerModerationRoutes } from './routes/moderation.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerAuth } from './middleware.js';
import { initDocker } from '../docker.js';
import { initUserMap } from '../user-map.js';
import { readFileSync } from 'fs';

const PORT = parseInt(process.env.ADMIN_PORT || '3001');

async function start() {
  // 初始化
  await initUserMap();
  initDocker({
    host: process.env.DOCKER_HOST || 'localhost',
    port: parseInt(process.env.DOCKER_PORT || '2375'),
    openclawImage: process.env.OPENCLAW_IMAGE || 'openclaw/openclaw:latest',
    dataDir: process.env.DATA_DIR || '/data/users',
    gatewayBasePort: parseInt(process.env.GATEWAY_BASE_PORT || '18790'),
  });

  const fastify = Fastify({
    logger: true,
  });

  fastify.register(cors, {
    origin: true,
  });

  // 注册 JWT 认证
  await registerAuth(fastify);

  // 注册路由
  registerUserRoutes(fastify);
  registerContainerRoutes(fastify);
  registerImportRoutes(fastify);
  registerNetworkRoutes(fastify);
  registerDLQRoutes(fastify);
  registerModerationRoutes(fastify);
  registerConfigRoutes(fastify);

  // HTML 页面
  fastify.get('/admin/network', async (_req, reply) => {
    reply.header('Content-Type', 'text/html');
    return readFileSync(join(__dirname, 'ui', 'admin-network.html'), 'utf-8');
  });

  // 主管理后台
  fastify.get('/admin', async (_req, reply) => {
    reply.header('Content-Type', 'text/html');
    return readFileSync(join(__dirname, 'ui', 'admin-dashboard.html'), 'utf-8');
  });

  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`🚀 Admin panel listening on port ${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();

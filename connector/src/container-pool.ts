/**
 * 容器池管理 - 预创建容器，复用空闲容器
 * 池中容器状态: sleep infinity
 * 出池: 改为 running + 配置
 * 归还: docker commit + 改回 sleep infinity
 */
import path from 'path';
import { runDocker, execDocker, listContainers, removeContainer, getUsedHostPorts, getContainerIp } from './docker.js';
import { getNextGatewayPort } from './user-map.js';
import type { FeishuUserRecord } from './types.js';
import { getUserRuntimeState } from './runtime-state.js';
import {
  allocateContainerIp,
  releaseContainerIp,
  getContainerIpByOpenId,
  applyIptablesRules,
  removeIptablesRules,
  getNetworkProfile,
  setupNetworkAcl,
} from './lib/network-acl.js';

// 公共 Skill 目录（可选挂载），仅用于挂载到用户容器的 ~/.openclaw/skills，方便多个插件/agent 共享
const SKILL_SOURCE_DIR = process.env.SKILL_DIR || path.join(process.cwd(), 'skills');
const CONFIG_SKILLS_DIR = '/home/node/.openclaw/skills';

// Bridge 插件配置：宿主路径 + 容器内挂载路径
const BRIDGE_PLUGIN_HOST_DIR = process.env.BRIDGE_PLUGIN_DIR || path.join(process.cwd(), '..', 'bridge-plugin');
const BRIDGE_PLUGIN_MOUNT_PATH = '/connector/bridge-plugin';
// 临时路径：复制到此处后由 Core 的 openclaw plugins install 安装到 ~/.openclaw/extensions/neoway-feishu-bridge
const BRIDGE_PLUGIN_STAGING_PATH = '/tmp/neoway-feishu-bridge';
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN;
if (!BRIDGE_TOKEN) {
  throw new Error('BRIDGE_TOKEN environment variable is required');
}
const CONNECTOR_URL = process.env.CONNECTOR_URL || 'http://host.docker.internal:3000';

/**
 * 在容器内通过 OpenClaw Core 的 plugins install 安装 Bridge 插件（与官方一致：Core 写 openclaw.json 的 plugins.installs）
 * 1. 将挂载的插件复制到临时目录
 * 2. 在容器内执行 openclaw plugins install <path>，由 Core 安装到 ~/.openclaw/extensions 并写入 installPath/installedAt 等
 * 宿主机需先在 BRIDGE_PLUGIN_DIR 执行: npm install && npm run build；package.json 需含 openclaw.extensions / openclaw.install
 */
async function installBridgePlugin(containerId: string): Promise<void> {
  const pluginMountPath = BRIDGE_PLUGIN_MOUNT_PATH;

  console.log(`📦 Installing Bridge plugin via Core (openclaw plugins install) in container ${containerId}...`);

  try {
    runDocker(['exec', containerId, 'sh', '-c', `rm -rf ${BRIDGE_PLUGIN_STAGING_PATH} && mkdir -p ${BRIDGE_PLUGIN_STAGING_PATH} && cp -r ${pluginMountPath}/* ${BRIDGE_PLUGIN_STAGING_PATH}/`]);
    runDocker(['exec', containerId, 'sh', '-c', `OPENCLAW_HOME=/home/node /usr/local/bin/openclaw plugins install ${BRIDGE_PLUGIN_STAGING_PATH}`]);
    console.log(`✅ Bridge plugin installed (Core wrote plugins.installs)`);
  } catch (error) {
    console.error(`❌ Failed to install Bridge plugin:`, error);
    throw error;
  }
}

export interface ContainerPoolConfig {
  poolSize: number;        // 池中预创建的容器数量
  openclawImage: string;   // OpenClaw 镜像
  dataDir: string;         // 数据目录
}

const POOL_CONTAINER_PREFIX = 'openclaw-pool-';
const USER_POOL_CONTAINER_PREFIX = 'openclaw-user-pool-';
const USER_CONTAINER_PREFIX = 'openclaw-gateway-';
const USER_IMAGE_PREFIX = 'openclaw-user:';

function sanitizeOpenId(openId: string): string {
  return openId.replace(/\//g, '_');
}

let poolConfig: ContainerPoolConfig | null = null;

/**
 * 初始化容器池
 */
export function initContainerPool(config: ContainerPoolConfig): void {
  poolConfig = config;
  // Setup network ACL (creates Docker network, default DROP rules)
  try {
    setupNetworkAcl();
  } catch (error) {
    console.warn('⚠️ setupNetworkAcl failed (may already exist):', error);
  }
  console.log(`🏊 Container pool initialized: ${config.poolSize} containers`);
}

/**
 * 获取池中可用容器数量
 */
export async function getPoolSize(): Promise<number> {
  if (!poolConfig) return 0;

  try {
    const containers = await listContainers({ all: true });
    return containers
      .filter(c => {
        const name = (c.Names || '').replace(/^\//, '');
        return name.startsWith(POOL_CONTAINER_PREFIX) && c.State === 'running';
      })
      .length;
  } catch {
    return 0;
  }
}

/**
 * 预热容器池 - 创建指定数量的空闲容器 (sleep infinity)
 */
export async function warmUpPool(): Promise<void> {
  if (!poolConfig) {
    console.warn('⚠️ Container pool not initialized');
    return;
  }

  const currentSize = await getPoolSize();
  const needed = poolConfig.poolSize - currentSize;

  if (needed <= 0) {
    console.log(`🏊 Pool already full: ${currentSize}/${poolConfig.poolSize}`);
    return;
  }

  console.log(`🏊 Warming up pool: creating ${needed} containers...`);

  for (let i = 0; i < needed; i++) {
    try {
      await createPoolContainer();
    } catch (error) {
      console.error(`❌ Failed to create pool container:`, error);
    }
  }

  console.log(`🏊 Pool warm-up complete`);
}

/**
 * 等待容器健康检查通过 - 使用 curl 直接检查健康端点
 */
async function waitForHealthy(containerId: string, timeoutMs: number = 180000): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    try {
      // 使用 curl 检查健康端点
      const output = runDocker(['exec', containerId, 'curl', '-s', '-f', 'http://127.0.0.1:18789/healthz']);
      if (output.includes('"ok":true') || output.includes('"status":"live"')) {
        console.log(`✅ Container ${containerId} is healthy (curl check passed)`);
        return true;
      }
    } catch {
      // curl failed, continue waiting
    }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  console.warn(`⚠️ Container ${containerId} health check timeout`);
  return false; // 超时返回 false，但不阻塞流程
}

// 池容器端口范围：基址 + 步长，动态跳过已被占用的端口（避免与 planB 等已有容器冲突）
const POOL_PORT_BASE = parseInt(process.env.GATEWAY_BASE_PORT || '18790', 10) + 110; // 18900 if base=18790
const POOL_PORT_MAX_OFFSET = 2000;
const PORT_INTERVAL = 20;
let nextPoolPort = POOL_PORT_BASE;

/**
 * 分配下一个未被占用的池容器端口（会跳过已被其他容器占用的端口）
 */
function getNextAvailablePoolPort(): number {
  const used = getUsedHostPorts();
  for (let i = 0; i < POOL_PORT_MAX_OFFSET / PORT_INTERVAL; i++) {
    nextPoolPort += PORT_INTERVAL;
    if (nextPoolPort > POOL_PORT_BASE + POOL_PORT_MAX_OFFSET) {
      throw new Error(`No available pool port in range [${POOL_PORT_BASE}, ${POOL_PORT_BASE + POOL_PORT_MAX_OFFSET}]`);
    }
    if (!used.has(nextPoolPort)) return nextPoolPort;
  }
  throw new Error(`No available pool port in range [${POOL_PORT_BASE}, ${POOL_PORT_BASE + POOL_PORT_MAX_OFFSET}]`);
}

/**
 * 获取池容器的端口
 */
function getPoolContainerPort(containerId: string): number {
  try {
    const output = runDocker(['inspect', '--format', '{{range $p, $conf := .NetworkSettings.Ports}}{{range $conf}}{{.HostPort}}{{end}}{{end}}', containerId]);
    const port = parseInt(output.trim(), 10);
    if (!isNaN(port)) {
      return port;
    }
  } catch (e) {
    // 忽略错误
  }
  return getNextAvailablePoolPort();
}

/**
 * 创建池容器 - 方案：预分配端口 + 共享存储 + 软链接
 * 预热时创建带端口映射的容器，用户请求时切换用户目录
 */
async function createPoolContainer(): Promise<string | null> {
  if (!poolConfig) return null;

  // 分配端口（跳过已被占用的端口）
  const port = getNextAvailablePoolPort();
  const name = `${POOL_CONTAINER_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tempDataDir = `${poolConfig.dataDir}/pool-temp-${Date.now()}`;

  const fs = await import('fs');
  fs.mkdirSync(tempDataDir, { recursive: true, mode: 0o777 });

  // 创建共享存储目录（存放 auth-profiles.json 等模板）
  const sharedDir = `${poolConfig.dataDir}/shared`;
  fs.mkdirSync(sharedDir, { recursive: true });

  // 检查共享目录中是否有 auth-profiles.json
  const authProfilesPath = `${sharedDir}/auth-profiles.json`;
  if (!fs.existsSync(authProfilesPath)) {
    console.warn(`⚠️ Shared directory does not contain auth-profiles.json. Users will need to configure their API keys manually.`);
  }

  // 使用 bridge 网络 + 预分配端口；禁用 HEALTHCHECK（镜像会查 18789/healthz，池容器只跑 sleep 不跑 gateway，会一直 unhealthy）
  const args = [
    'run', '-d',
    '--no-healthcheck',
    '--name', name,
    '--hostname', 'openclaw-pool',
    '-p', `${port}:18789`,
    '--network', 'openclaw-net',
    '-v', `${tempDataDir}:/home/node/.openclaw`,
    '-v', `${sharedDir}:/home/node/.openclaw/shared`,
    '--add-host', 'host.docker.internal:host-gateway',
    '--user', 'root',
    poolConfig.openclawImage,
    'sleep', 'infinity',
  ];

  try {
    const containerId = runDocker(args).trim();
    console.log(`🏊 Created pool container: ${containerId} (port ${port}, sleep infinity)`);
    return containerId;
  } catch (error) {
    console.error(`❌ Failed to create pool container:`, error);
    return null;
  }
}

/**
 * 获取用户的镜像名称
 */
export function getUserImageName(openId: string): string {
  return `${USER_IMAGE_PREFIX}${sanitizeOpenId(openId)}`;
}

/**
 * 检查用户镜像是否存在
 */
export async function userImageExists(openId: string): Promise<boolean> {
  const imageName = getUserImageName(openId);
  try {
    const output = runDocker(['image', 'ls', imageName, '-q']);
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * 从池中获取容器并配置为用户容器
 * @param user 用户映射
 * @param gatewayToken Gateway token
 * @param port 端口
 *
 * 优先级：用户镜像 > 池容器 > 基础镜像
 */
export async function acquireFromPool(
  user: FeishuUserRecord,
  gatewayToken: string,
  port: number
): Promise<string> {
  if (!poolConfig) {
    throw new Error('Container pool not initialized');
  }

  const openId = user.spec.feishuOpenId;

  // 1）先看「带用户 openid 的 sleep 池」里有没有该用户的容器，有则用他的（删池容器 + 用其镜像起网关）
  const userPoolOne = await getOneUserPoolContainer(openId);
  if (userPoolOne) {
    console.log(`🏊 Taking from user pool: ${userPoolOne.Names} -> gateway for ${openId}`);
    return await takeFromUserPool(user, gatewayToken, port);
  }

  // 2）有用户镜像（无对应 user-pool 容器）：直接用用户镜像起网关
  const userImage = getUserImageName(openId);
  const hasUserImage = await userImageExists(openId);
  if (hasUserImage) {
    console.log(`📦 Using user image: ${userImage}`);
    return await createFromUserImage(user, gatewayToken, port, userImage);
  }

  // 3）无用户镜像：从公共池拿一个（删池容器 + 用同端口起新用户容器），没有再从基础镜像创建
  const poolOne = await getOnePoolContainer();
  if (poolOne) {
    console.log(`🏊 Taking container from generic pool: ${poolOne.Names}`);
    return await acquireFromExistingPoolContainer(poolOne, user, gatewayToken, port);
  }

  console.log(`🏊 No pool container available, creating from base image...`);
  return await createFromBaseImage(user, gatewayToken, port);
}

/**
 * 从池中取一个可用容器（仅用于 acquire，不修改容器状态）
 */
async function getOnePoolContainer(): Promise<{ ID: string; Names: string; State: string } | null> {
  try {
    const containers = await listContainers({ all: true });
    const poolContainers = containers.filter(
      c => (c.Names || '').replace(/^\//, '').startsWith(POOL_CONTAINER_PREFIX) && c.State === 'running'
    );
    return poolContainers.length > 0 ? poolContainers[0]! : null;
  } catch {
    return null;
  }
}

/**
 * 按用户 open_id 取「带用户 openid 的 sleep 池」里的一个容器（有则返回，无则 null）
 */
async function getOneUserPoolContainer(openId: string): Promise<{ ID: string; Names: string; State: string } | null> {
  try {
    const name = `${USER_POOL_CONTAINER_PREFIX}${sanitizeOpenId(openId)}`;
    const containers = await listContainers({ all: true });
    const c = containers.find(
      x => (x.Names || '').replace(/^\//, '') === name && x.State === 'running'
    );
    return c ?? null;
  } catch {
    return null;
  }
}

/**
 * 从「带用户 openid 的 sleep 池」里取出该用户的容器：删池容器后用该用户镜像起网关容器并启动
 */
async function takeFromUserPool(
  user: FeishuUserRecord,
  gatewayToken: string,
  port: number
): Promise<string> {
  if (!poolConfig) throw new Error('Pool not initialized');

  const openId = user.spec.feishuOpenId;
  const userPoolName = `${USER_POOL_CONTAINER_PREFIX}${sanitizeOpenId(openId)}`;
  const userContainerName = `${USER_CONTAINER_PREFIX}${sanitizeOpenId(openId)}`;

  try {
    runDocker(['rm', '-f', userPoolName]);
  } catch {
    // 可能不存在
  }

  return createFromUserImage(user, gatewayToken, port, getUserImageName(openId));
}

/**
 * 检查容器内是否在未来一段时间内有定时任务要跑。
 * 通过读取容器内的 openclaw.json / cron jobs.json 来判断。
 */
function hasUpcomingCronJobs(containerId: string, lookaheadMs: number): boolean {
  if (lookaheadMs <= 0) return false;

  try {
    const now = Date.now();

    // 1. 读取容器内的 openclaw 配置
    const configRaw = runDocker([
      'exec',
      containerId,
      'sh',
      '-c',
      'cat /home/node/.openclaw/openclaw.json 2>/dev/null || echo ""',
    ]);
    const trimmed = configRaw.trim();
    if (!trimmed) return false;

    let config: any;
    try {
      config = JSON.parse(trimmed);
    } catch {
      return false;
    }

    // 2. 解析 cron.store，计算 jobs.json 路径
    const cronStore = config?.cron?.store as string | undefined;
    const cronStorePath = cronStore && cronStore.trim()
      ? cronStore.trim()
      : '/home/node/.openclaw/cron/jobs.json';

    // 3. 读取 cron jobs.json
    const jobsRaw = runDocker([
      'exec',
      containerId,
      'sh',
      '-c',
      `cat "${cronStorePath}" 2>/dev/null || echo ""`,
    ]);
    const jobsTrimmed = jobsRaw.trim();
    if (!jobsTrimmed) return false;

    let jobsData: any;
    try {
      jobsData = JSON.parse(jobsTrimmed);
    } catch {
      return false;
    }

    const jobs: any[] = Array.isArray(jobsData?.jobs) ? jobsData.jobs : [];
    if (!jobs.length) return false;

    for (const job of jobs) {
      if (job?.enabled === false) continue;
      const next = job?.state?.nextRunAtMs;
      if (typeof next !== 'number') continue;
      if (next < now) continue;

      if (next - now <= lookaheadMs) {
        // 未来 lookaheadMs 内有要运行的任务
        return true;
      }
    }

    return false;
  } catch {
    // 读取/解析失败时，不阻塞 sleep 判定
    return false;
  }
}

/**
 * 检查容器内是否没有正在执行的 openclaw 任务/定时任务（满足才可 sleep）
 * 方案 C：优先根据 Bridge 上报的会话状态 + Cron 任务判断，再退回到进程检查。
 */
export async function containerHasNoActiveOpenclawTasks(containerId: string): Promise<boolean> {
  // 全局开关：禁用容器 sleep 时，一律认为“没有空闲要求”，直接返回 false（不触发 sleep）
  const sleepEnabled = process.env.CONTAINER_SLEEP_ENABLED !== 'false';
  if (!sleepEnabled) {
    return false;
  }

  // 通过容器名推断 open_id（openclaw-gateway-<open_id>）
  let openId: string | null = null;
  try {
    const nameOutput = runDocker(['inspect', '--format', '{{.Name}}', containerId]).trim();
    const name = nameOutput.replace(/^\//, '');
    if (name.startsWith(USER_CONTAINER_PREFIX)) {
      openId = name.substring(USER_CONTAINER_PREFIX.length);
    }
  } catch {
    // 忽略，退回到旧逻辑
  }

  const now = Date.now();
  const bufferMs = parseInt(process.env.CONTAINER_SESSION_IDLE_BUFFER_MS || '600000', 10); // 默认 10 分钟
  const cronLookaheadMs = parseInt(process.env.CONTAINER_CRON_LOOKAHEAD_MS || '43200000', 10); // 默认 12 小时

  if (openId) {
    const runtime = getUserRuntimeState(openId);
    if (runtime) {
      // 1）有正在进行的会话：认为不空闲
      if (runtime.activeSessionCount > 0) {
        return false;
      }

      // 2）刚结束会话的缓冲期内：认为不空闲
      if (runtime.lastSessionEndAt && now - runtime.lastSessionEndAt < bufferMs) {
        return false;
      }
    }

    // 3）如果未来一段时间内有定时任务要跑，也认为不空闲，避免 Cron 任务触发时容器已被 sleep
    if (hasUpcomingCronJobs(containerId, cronLookaheadMs)) {
      return false;
    }
  }

  // 4）退回到进程级检查（兼容老逻辑）
  try {
    const out = runDocker(['exec', containerId, 'sh', '-c', 'pgrep -c -f "openclaw" || true']);
    const n = parseInt(out.trim(), 10) || 0;
    return n <= 1;
  } catch {
    return true;
  }
}

/**
 * 将用户网关容器放入「带用户 openid 的 sleep 池」：先 commit 防丢失，再删网关容器，再起一个 sleep 的 user-pool 容器
 */
export async function putUserContainerToSleep(openId: string, containerId: string): Promise<void> {
  if (!poolConfig) return;

  const userImageName = getUserImageName(openId);
  const userContainerName = `${USER_CONTAINER_PREFIX}${openId}`;
  const userPoolName = `${USER_POOL_CONTAINER_PREFIX}${sanitizeOpenId(openId)}`;

  try {
    try {
      execDocker(containerId, ['pkill', '-f', 'openclaw gateway']);
    } catch {
      // 可能没有运行
    }
    runDocker(['stop', containerId]);

    runDocker(['commit', containerId, userImageName]);
    runDocker(['rm', '-f', userContainerName]);
    runDocker(['rm', '-f', containerId]);

    const fs = await import('fs');
    const tempDir = `${poolConfig.dataDir}/user-pool-${sanitizeOpenId(openId)}-${Date.now()}`;
    fs.mkdirSync(tempDir, { recursive: true });

    runDocker([
      'run', '-d',
      '--no-healthcheck',
      '--name', userPoolName,
      '-v', `${tempDir}:/home/node/.openclaw`,
      userImageName,
      'sleep', 'infinity',
    ]);
  } catch (e) {
    console.error(`❌ putUserContainerToSleep failed for ${openId}:`, e);
  }
}

/**
 * 从池中现有容器获取
 * 简化方案：直接为用户在宿主机上创建独立目录
 * 1. 获取预分配的端口
 * 2. 重命名池容器
 * 3. 为用户创建独立数据目录
 * 4. 重新挂载用户目录
 * 5. 启动 gateway
 */
async function acquireFromExistingPoolContainer(
  poolContainer: { ID: string; Names: string },
  user: FeishuUserRecord,
  gatewayToken: string,
  port: number
): Promise<string> {
  if (!poolConfig) throw new Error('Pool not initialized');

  const containerId = poolContainer.ID;
  const openId = user.spec.feishuOpenId;
  const userContainerName = `${USER_CONTAINER_PREFIX}${sanitizeOpenId(openId)}`;

  // 使用预分配的端口，如果没有则分配新的
  const actualPort = getPoolContainerPort(containerId) || port || getNextGatewayPort();

  console.log(`🏊 Acquiring from pool: ${poolContainer.Names} -> ${userContainerName}, port: ${actualPort}`);

  // 用户数据目录
  const sanitizedOpenId = openId.replace(/\//g, '_');
  const userDataDir = `${poolConfig.dataDir}/${sanitizedOpenId}`;

  try {
    // 1. 删除可能存在的旧用户容器
    try { runDocker(['rm', '-f', userContainerName]); } catch {}

    // 2. 停止池容器
    runDocker(['stop', containerId]);

    // 3. 在宿主机上创建用户目录
    const fs = await import('fs');
    fs.mkdirSync(`${userDataDir}/.openclaw`, { recursive: true });
    console.log(`📁 Created user data dir: ${userDataDir}/.openclaw`);

    // 4. 删除池容器，用用户目录重新创建（挂载 skills 到全局 ~/.openclaw/skills）
    runDocker(['rm', '-f', containerId]);

    const args = [
      'run', '-d',
      '--name', userContainerName,
      '-p', `${actualPort}:18789`,
      '--network', 'openclaw-net',
      '-v', `${userDataDir}/.openclaw:/home/node/.openclaw`,
      '-v', `${SKILL_SOURCE_DIR}:${CONFIG_SKILLS_DIR}:ro`,
      '-v', `${BRIDGE_PLUGIN_HOST_DIR}:${BRIDGE_PLUGIN_MOUNT_PATH}:ro`,
      '--add-host', 'host.docker.internal:host-gateway',
      '--user', 'root',
      poolConfig.openclawImage,
      'sleep', 'infinity',
    ];

    const newContainerId = runDocker(args).trim();
    console.log(`✅ Created new container for user: ${newContainerId}`);

    // 5. 配置、用 Core 安装 Bridge 插件并启动 Gateway（configureAndStartGateway 内会调 openclaw plugins install）
    await configureAndStartGateway(newContainerId, gatewayToken, actualPort, sanitizedOpenId);

    // Apply network ACL rules (best-effort)
    try {
      const containerIp = await getContainerIp(newContainerId);
      if (containerIp) {
        allocateContainerIp(openId);
        const profile = await getNetworkProfile(openId);
        if (profile) applyIptablesRules(containerIp, profile);
        console.log(`🔒 Network ACL applied for ${openId} at ${containerIp}`);
      }
    } catch (error) {
      console.warn('⚠️ Network ACL setup failed (non-blocking):', error);
    }

    // 7. 等待 gateway 生成配置文件
    console.log(`⏳ Waiting for gateway to generate config...`);
    await new Promise(resolve => setTimeout(resolve, 8000));

    console.log(`✅ Container ready from pool: ${newContainerId}`);
    return newContainerId;

  } catch (error) {
    console.error(`❌ Failed to acquire from pool:`, error);
    return await createFromBaseImage(user, gatewayToken, port);
  }
}

/**
 * 从用户镜像创建
 */
async function createFromUserImage(
  user: FeishuUserRecord,
  gatewayToken: string,
  port: number,
  imageName: string
): Promise<string> {
  if (!poolConfig) throw new Error('Pool not initialized');

  const openId = user.spec.feishuOpenId;
  const sanitizedOpenId = openId.replace(/\//g, '_');
  const containerName = `${USER_CONTAINER_PREFIX}${sanitizedOpenId}`;
  const userDataDir = `${poolConfig.dataDir}/${sanitizedOpenId}`;
  const actualPort = port || getNextGatewayPort();

  const fs = await import('fs');
  fs.mkdirSync(`${userDataDir}/.openclaw`, { recursive: true });

  const args = [
    'run', '-d',
    '--name', containerName,
    '-p', `${actualPort}:18789`,
    '--network', 'openclaw-net',
    '-v', `${userDataDir}/.openclaw:/home/node/.openclaw`,
    '-v', `${SKILL_SOURCE_DIR}:${CONFIG_SKILLS_DIR}:ro`,
    '-v', `${BRIDGE_PLUGIN_HOST_DIR}:${BRIDGE_PLUGIN_MOUNT_PATH}:ro`,
    '--add-host', 'host.docker.internal:host-gateway',
    '--user', 'root',
    imageName,
    'sleep', 'infinity',
  ];

  const containerId = runDocker(args).trim();
  console.log(`✅ Created from user image: ${containerId}`);

  // 配置并启动 Gateway
  await configureAndStartGateway(containerId, gatewayToken, port, sanitizedOpenId);

  // Apply network ACL rules (best-effort)
  try {
    const containerIp = await getContainerIp(containerId);
    if (containerIp) {
      allocateContainerIp(openId);
      const profile = await getNetworkProfile(openId);
      if (profile) applyIptablesRules(containerIp, profile);
      console.log(`🔒 Network ACL applied for ${openId} at ${containerIp}`);
    }
  } catch (error) {
    console.warn('⚠️ Network ACL setup failed (non-blocking):', error);
  }

  return containerId;
}

/**
 * 从基础镜像创建
 * 支持端口冲突重试
 * 注意：创建后需要调用 configureAndStartGateway 来配置和启动 Gateway
 */
async function createFromBaseImage(
  user: FeishuUserRecord,
  gatewayToken: string,
  port: number,
  maxRetries: number = 10
): Promise<string> {
  if (!poolConfig) throw new Error('Pool not initialized');

  const openId = user.spec.feishuOpenId;
  let attempt = 0;
  let lastError: Error | null = null;

  while (attempt < maxRetries) {
    // 如果是重试，先等待一下让 Docker 释放端口
    if (attempt > 0) {
      console.log(`⏳ Waiting for Docker to release port...`);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }

    const sanitizedOpenId = sanitizeOpenId(openId);
    const containerName = `${USER_CONTAINER_PREFIX}${sanitizedOpenId}`;
    const userDataDir = `${poolConfig.dataDir}/${sanitizedOpenId}`;
    const actualPort = port || getNextGatewayPort();

    const fs = await import('fs');
    fs.mkdirSync(`${userDataDir}/.openclaw`, { recursive: true });

    // 删除可能存在的旧容器
    try {
      runDocker(['rm', '-f', containerName]);
      console.log(`🗑️ Removed existing container: ${containerName}`);
    } catch {
      // 可能不存在
    }

    // 共享目录（存放 auth-profiles.json 等模板）
    const sharedDir = `${poolConfig.dataDir}/shared`;

    // 先创建容器，使用 sleep infinity，不启动 gateway；
    // - 挂载用户数据目录到 ~/.openclaw
    // - 挂载 shared 目录到 ~/.openclaw/shared:ro
    // - 仅当设置了 SKILL_DIR 时挂载额外公共 skills 到 ~/.openclaw/skills（飞书 skills 已随 Bridge 插件安装在插件目录）
    // - 挂载 Bridge 插件代码到 /connector/bridge-plugin:ro（插件内含 skills/，安装时一并复制）
    const args = [
      'run', '-d',
      '--name', containerName,
      '-p', `${actualPort}:18789`,
      '--network', 'openclaw-net',
      '-v', `${userDataDir}/.openclaw:/home/node/.openclaw`,
      '-v', `${sharedDir}:/home/node/.openclaw/shared:ro`,
      ...(process.env.SKILL_DIR ? ['-v', `${SKILL_SOURCE_DIR}:${CONFIG_SKILLS_DIR}:ro`] : []),
      '-v', `${BRIDGE_PLUGIN_HOST_DIR}:${BRIDGE_PLUGIN_MOUNT_PATH}:ro`,
      '--add-host', 'host.docker.internal:host-gateway',
      '--user', 'root',
      poolConfig.openclawImage,
      'sleep', 'infinity',
    ];

    try {
      const containerId = runDocker(args).trim();
      console.log(`✅ Created from base image: ${containerId} (port ${actualPort})`);

      // 等待容器完全启动
      console.log(`⏳ Waiting for container to start...`);
      await new Promise(resolve => setTimeout(resolve, 3000));

      // 确保目录存在（不 chmod 整树，避免对只读挂载 shared/skills 报错）
      try {
        runDocker(['exec', containerId, 'sh', '-c', 'mkdir -p /home/node/.openclaw']);
      } catch (e) {
        console.warn(`⚠️ Failed to create .openclaw dir:`, e);
      }

      // 配置、用 Core 安装 Bridge 插件并启动 Gateway
      await configureAndStartGateway(containerId, gatewayToken, actualPort, openId);

      // Apply network ACL rules (best-effort)
      try {
        const containerIp = await getContainerIp(containerId);
        if (containerIp) {
          allocateContainerIp(openId);
          const profile = await getNetworkProfile(openId);
          if (profile) applyIptablesRules(containerIp, profile);
          console.log(`🔒 Network ACL applied for ${openId} at ${containerIp}`);
        }
      } catch (error) {
        console.warn('⚠️ Network ACL setup failed (non-blocking):', error);
      }

      return containerId;
    } catch (error: any) {
      lastError = error;

      // 检查是否是端口冲突错误 (包括 Docker 残留端点问题)
      const isPortConflict = error.message && (
        error.message.includes('address already in use') ||
        error.message.includes('port is already allocated') ||
        error.message.includes('failed to bind host port') ||
        error.message.includes('container networking')
      );

      if (isPortConflict) {
        console.warn(`⚠️ Port conflict detected, will retry with new port...`);
        attempt++;
        port = 0; // 强制获取新端口
        continue;
      }

      // 其他错误直接抛出
      throw error;
    }
  }

  throw lastError || new Error('Failed to create container after max retries');
}

/**
 * 配置并启动 Gateway
 */
async function configureAndStartGateway(
  containerId: string,
  gatewayToken: string,
  port: number,
  sanitizedOpenId?: string
): Promise<void> {
  // 等待容器完全启动
  await new Promise(resolve => setTimeout(resolve, 3000));

  // 检查容器内的 .openclaw 目录
  const checkOpenclaw = runDocker(['exec', containerId, 'ls', '-la', '/home/node/.openclaw']);
  console.log(`📂 Container .openclaw: ${checkOpenclaw}`);

  // 配置 OpenClaw - 直接写入配置文件
  const minimaxApiKey = process.env.MINIMAX_API_KEY || '';
  const minimaxBaseUrl = process.env.MINIMAX_BASE_URL || 'https://api.minimaxi.com/anthropic';
  const defaultModel = process.env.DEFAULT_MODEL || 'MiniMax-M2.5';

  const configJson = {
    gateway: {
      mode: 'local',
      bind: 'lan',
      http: {
        endpoints: {
          chatCompletions: {
            enabled: true,
          },
        },
      },
      auth: {
        mode: 'token',
      },
      controlUi: {
        dangerouslyAllowHostHeaderOriginFallback: true,
      },
    },
    hooks: {
      enabled: true,
      token: gatewayToken,
      allowRequestSessionKey: true,
    },
    agents: {
      defaults: {
        model: `minimax/${defaultModel}`,
      },
    },
    models: {
      mode: 'merge',
      providers: {
        minimax: {
          baseUrl: minimaxBaseUrl,
          apiKey: minimaxApiKey,
          auth: 'api-key',
          api: 'anthropic-messages',
          headers: {
            'X-API-Key': minimaxApiKey,
            'Content-Type': 'application/json',
          },
          models: [
            { id: defaultModel, name: defaultModel, api: 'anthropic-messages', reasoning: false, input: ['text'] },
          ],
        },
      },
    },
    plugins: {
      entries: {
        feishu: {
          enabled: false,
        },
        'neoway-feishu-bridge': {
          enabled: true,
          // 先只写 schema 允许的字段，否则 install 时旧 manifest 校验会报 additional properties
          config: {
            connectorBaseUrl: CONNECTOR_URL,
            connectorToken: BRIDGE_TOKEN,
          },
        },
      },
      // installs 由 Core 的 openclaw plugins install 写入，不在此手写
    },
  };

  // 总是写入最新配置（因为 MINIMAX_API_KEY 等环境变量可能已更新）
  try {
    runDocker(['exec', containerId, 'sh', '-c', 'mkdir -p /home/node/.openclaw']);
  } catch (error) {
    console.warn(`⚠️ Failed to create .openclaw dir:`, error);
  }

  const configBase64 = Buffer.from(JSON.stringify(configJson, null, 2)).toString('base64');
  try {
    runDocker(['exec', containerId, 'sh', '-c', `echo '${configBase64}' | base64 -d > /home/node/.openclaw/openclaw.json`]);
    console.log(`✅ Config written to container`);
  } catch (error) {
    console.warn(`⚠️ Failed to write config:`, error);
  }

  // 复制 auth-profiles.json 从共享目录
  try {
    runDocker(['exec', containerId, 'sh', '-c',
      'cp /home/node/.openclaw/shared/auth-profiles.json /home/node/.openclaw/agents/main/agent/auth-profiles.json 2>/dev/null || echo "No shared auth-profiles.json"'
    ]);
    console.log(`✅ Copied auth-profiles.json from shared directory`);
  } catch (error) {
    console.warn(`⚠️ Failed to copy auth-profiles.json:`, error);
  }

  // 用 Core 安装 Bridge 插件（写 plugins.installs）
  try {
    runDocker(['exec', containerId, 'rm', '-rf', '/home/node/.openclaw/extensions/neoway-feishu-bridge']);
  } catch {
    // 不存在则忽略
  }
  await installBridgePlugin(containerId);
  // install 通过后再写入 feishu_open_id（install 时容器内可能仍是旧 manifest，会拒掉额外字段）
  if (sanitizedOpenId) {
    try {
      const openIdB64 = Buffer.from(sanitizedOpenId, 'utf8').toString('base64');
      // Write the base64-encoded open_id to a temp file via stdin (no shell injection risk)
      runDocker(['exec', '-i', containerId, 'tee', '/tmp/open_id.b64'], openIdB64 + '\n');
      runDocker([
        'exec',
        containerId,
        'node',
        '-e',
        `const fs=require('fs');const openId=Buffer.from((fs.readFileSync('/tmp/open_id.b64','utf8')||'').trim(),'base64').toString('utf8');const p='/home/node/.openclaw/openclaw.json';const c=JSON.parse(fs.readFileSync(p,'utf8'));if(!c.plugins)c.plugins={};if(!c.plugins.entries)c.plugins.entries={};if(!c.plugins.entries['neoway-feishu-bridge'])c.plugins.entries['neoway-feishu-bridge']={};if(!c.plugins.entries['neoway-feishu-bridge'].config)c.plugins.entries['neoway-feishu-bridge'].config={};c.plugins.entries['neoway-feishu-bridge'].config.feishu_open_id=openId||undefined;fs.writeFileSync(p,JSON.stringify(c,null,2));`,
      ]);
      console.log(`✅ Patched feishu_open_id into plugin config`);
    } catch (patchErr) {
      console.warn(`⚠️ Failed to patch feishu_open_id:`, patchErr);
    }
  }

  // 启动 Gateway - 设置 OPENCLAW_HOME 确保读取正确的配置
  try {
    // 先检查是否已有 gateway 进程在运行
    try {
      const existing = runDocker(['exec', containerId, 'pgrep', '-f', 'openclaw-gateway']);
      if (existing.trim()) {
        console.log(`⚠️ Gateway already running in container ${containerId}`);
        return;
      }
    } catch {
      // 没有现有进程，继续启动
    }

    // 启动 gateway，stdout/stderr 重定向到文件便于排查 500（openclaw 会打 logWarn("chat completion failed: ...")）
    runDocker(['exec', '-d', containerId, '/bin/sh', '-c',
      'cd /home/node && OPENCLAW_HOME=/home/node /usr/local/bin/openclaw gateway run --bind lan --port 18789 >> /home/node/.openclaw/gateway-stdout.log 2>&1 &'
    ]);
    console.log(`🚀 Gateway start command sent (logs: .openclaw/gateway-stdout.log)`);

    // 等待 Gateway 就绪
    console.log(`⏳ Waiting for gateway to be ready...`);
    const isHealthy = await waitForHealthy(containerId, 120000);
    if (!isHealthy) {
      // 超时但继续，不要阻塞流程
      console.warn(`⚠️ Gateway health check timeout, but continuing anyway`);
    } else {
      console.log(`✅ Gateway is ready`);
    }
  } catch (error) {
    console.error(`❌ Failed to start gateway:`, error);
    // 不要抛出错误，让流程继续
  }
}

/**
 * 归还容器：保存用户状态到镜像并删除容器，不创建池容器。
 * 下次该用户来时由 acquireFromPool 走 createFromUserImage 从该镜像起新容器即可。
 * 若还池时再起一个 openclaw-pool-*（用户镜像 + sleep），acquire 有用户镜像时不会从池取，
 * 会导致池里堆满永不复用的孤儿容器，逻辑不闭合，故此处只做 commit + rm。
 *
 * @param containerId 容器 ID
 * @param userOpenId 用户 open_id
 */
export async function returnToPool(
  containerId: string,
  userOpenId: string
): Promise<void> {
  if (!poolConfig) return;

  // Remove network ACL rules (best-effort)
  try {
    const containerIp = getContainerIpByOpenId(userOpenId);
    if (containerIp) {
      removeIptablesRules(containerIp);
      console.log(`🔓 Network ACL removed for ${userOpenId}`);
    }
    releaseContainerIp(userOpenId);
  } catch (error) {
    console.warn('⚠️ Network ACL cleanup failed (non-blocking):', error);
  }

  const userContainerName = `${USER_CONTAINER_PREFIX}${sanitizeOpenId(userOpenId)}`;
  const userImageName = getUserImageName(userOpenId);

  try {
    // 1. 停止正在运行的 Gateway
    try {
      execDocker(containerId, ['pkill', '-f', 'openclaw gateway']);
    } catch {
      // 可能没有运行
    }

    // 2. 停止容器
    runDocker(['stop', containerId]);

    // 3. docker commit 保存用户镜像（下次 acquire 时 createFromUserImage 会用）
    console.log(`📦 Committing container to image: ${userImageName}`);
    runDocker(['commit', containerId, userImageName]);
    console.log(`✅ Created user image: ${userImageName}`);

    // 4. 删除用户容器；不创建 openclaw-pool-*，避免孤儿池容器
    try { runDocker(['rm', '-f', userContainerName]); } catch {}
    try { runDocker(['rm', '-f', containerId]); } catch {}

    console.log(`🏊 User container released (image saved for next acquire)`);
  } catch (error) {
    console.error(`❌ Failed to return container to pool:`, error);
  }
}

/**
 * 检查容器是否属于池
 */
export function isPoolContainer(containerName: string): boolean {
  return containerName.startsWith(POOL_CONTAINER_PREFIX);
}

/**
 * 检查容器是否属于用户
 */
export function isUserContainer(containerName: string): boolean {
  return containerName.startsWith(USER_CONTAINER_PREFIX);
}

/**
 * Docker 容器管理模块 - 使用 docker CLI
 * 支持容器镜像缓存优化
 */
import { execSync, exec, spawnSync } from 'child_process';
import fs from 'fs/promises';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import type { ContainerConfig, FeishuUserRecord } from './types.js';
import { getNextGatewayPort, deleteUser } from './user-map.js';
import {
  BUILTIN_START,
  BUILTIN_START_COMMENT,
  BUILTIN_END,
  mergeBuiltinContent,
} from './lib/builtin-merge.js';

export interface DockerConfig {
  host: string;
  port: number;
  openclawImage: string;
  dataDir: string;
  gatewayBasePort: number;
}

let config: DockerConfig;

// Docker 健康状态 (Task 11: Graceful Degradation)
let dockerAvailable = true;
let dockerLastHealthCheck = 0;
const DOCKER_HEALTH_CHECK_INTERVAL = 30000; // 30s

/**
 * 检查 Docker 是否可用 (Task 11)
 */
export function checkDockerHealth(): boolean {
  const now = Date.now();
  if (dockerAvailable && now - dockerLastHealthCheck < DOCKER_HEALTH_CHECK_INTERVAL) {
    return dockerAvailable;
  }
  try {
    execSync('docker info', { encoding: 'utf-8', stdio: 'pipe' });
    dockerAvailable = true;
    dockerLastHealthCheck = now;
    return true;
  } catch {
    dockerAvailable = false;
    dockerLastHealthCheck = now;
    console.warn('[Docker] Health check failed — Docker daemon unavailable');
    return false;
  }
}

/**
 * 确保 Docker 可用，失败则抛出错误 (Task 11)
 */
function ensureDockerAvailable(): void {
  if (!checkDockerHealth()) {
    throw new Error('Docker daemon unavailable');
  }
}

// 用户镜像前缀
const USER_IMAGE_PREFIX = 'openclaw-user-';

/**
 * 检查用户镜像是否存在
 */
export function userImageExists(openId: string): boolean {
  const imageName = `${USER_IMAGE_PREFIX}${openId}`;
  try {
    runDocker(['image', 'inspect', imageName]);
    return true;
  } catch {
    return false;
  }
}

/**
 * 从用户镜像创建容器（如果有镜像）
 * 返回 true 表示使用了用户镜像，false 表示使用基础镜像
 */
export async function createUserContainerFromImage(
  user: FeishuUserRecord,
  gatewayToken: string,
  port?: number
): Promise<{ containerId: string; usedUserImage: boolean }> {
  const openId = user.spec.feishuOpenId;
  const userImage = `${USER_IMAGE_PREFIX}${openId}`;
  const containerName = `openclaw-gateway-${openId}`;
  const actualPort = port || getNextGatewayPort();

  // 用户数据目录
  const userDataDir = `${config.dataDir}/${openId}`;

  // 检查镜像是否存在
  const useUserImage = userImageExists(openId);

  // 构建 docker run 命令
  const envVars = [
    // OPENCLAW_PROFILE is deprecated
    // `OPENCLAW_PROFILE=user-${openId}`,
    `OPENCLAW_HOOKS_ENABLED=true`,
    `OPENCLAW_HOOKS_TOKEN=${gatewayToken}`,
    `OPENCLAW_HOME=/home/node`,
    `OPENCLAW_USER_OPEN_ID=${openId}`,
  ];

  // 启动命令：设置配置并运行 Gateway
  // 禁用内置飞书插件，避免重复响应
  const startupCmd = `sh -c "openclaw config set gateway.mode local && openclaw config set gateway.bind lan && openclaw config set hooks.enabled true && openclaw config set hooks.token ${gatewayToken} && openclaw config set hooks.allowRequestSessionKey true && openclaw config set agents.defaults.model 'minimax-cn/MiniMax-M2.5-hightspeed' && openclaw config set gateway.http.endpoints.chatCompletions.enabled true && openclaw config set gateway.auth.mode token && openclaw config set plugins.entries.feishu.enabled false && openclaw gateway run --bind lan --port 18789"`;

  // 挂载技能目录：挂到全局管理目录 ~/.openclaw/skills，供所有 agent 使用
  const skillSourceDir = process.env.SKILL_DIR || path.join(process.cwd(), 'skills');
  const workspaceSkillsMount = '/home/node/.openclaw/skills';

  // 确定使用的镜像
  const imageToUse = useUserImage ? userImage : config.openclawImage;

  console.log(`📦 Using image: ${imageToUse} for user ${openId}`);

  const args = [
    'run',
    '-d',
    '--name', containerName,
    '-p', `${actualPort}:18789`,
    '-v', `${userDataDir}/.openclaw:/home/node/.openclaw`,
    '-v', `${skillSourceDir}:${workspaceSkillsMount}:ro`,
    '--add-host', 'host.docker.internal:host-gateway',
    '--user', 'root',
    ...envVars.flatMap(e => ['-e', e]),
    imageToUse,
    ...startupCmd.split(' '),
  ];

  const containerId = runDocker(args).trim();
  console.log('✅ Container created:', containerId);

  // 如果使用基础镜像，需要注入 API key
  if (!useUserImage) {
    const apiKey = process.env.MINIMAX_API_KEY;
    if (apiKey) {
      const authProfiles = {
        version: 1,
        profiles: {
          'minimax-cn:default': {
            type: 'api_key',
            provider: 'minimax-cn',
            key: apiKey,
          },
        },
        lastGood: {
          'minimax-cn': 'minimax-cn:default',
        },
        usageStats: {},
      };

      const authJson = JSON.stringify(authProfiles);

      // 先在主机创建临时文件
      const tempFile = `/tmp/auth-profiles-${Date.now()}.json`;
      await fs.writeFile(tempFile, authJson);

      // 复制到容器
      runDocker(['cp', tempFile, `${containerId}:/home/node/.openclaw/agents/main/agent/auth-profiles.json`]);
      runDocker(['exec', containerId, 'chown', 'node:node', '/home/node/.openclaw/agents/main/agent/auth-profiles.json']);

      // 删除临时文件
      await fs.unlink(tempFile);

      console.log('✅ Injected MiniMax API key to container');
    }
  }

  return { containerId, usedUserImage: useUserImage };
}

/**
 * 将用户容器 commit 成镜像
 */
export function commitContainerToImage(openId: string, containerId: string): string {
  const imageName = `${USER_IMAGE_PREFIX}${openId}`;
  console.log(`📸 Committing container ${containerId} to image ${imageName}...`);

  try {
    // 停止容器
    runDocker(['stop', containerId]);
    console.log('✅ Container stopped');

    // commit 容器为镜像
    runDocker(['commit', '-c', 'ENTRYPOINT []', containerId, imageName]);
    console.log('✅ Image created:', imageName);

    return imageName;
  } catch (error) {
    console.error('❌ Failed to commit container:', error);
    throw error;
  }
}

/**
 * 删除容器
 */
export function removeContainer(containerId: string): void {
  try {
    runDocker(['stop', containerId]);
  } catch {
    // 可能已经停止
  }
  runDocker(['rm', '-f', containerId]);
  console.log('🗑️ Container removed:', containerId);
}

/**
 * 获取容器最后活跃时间
 */
export function getContainerLastActiveTime(containerId: string): number | null {
  try {
    const output = runDocker(['inspect', '--format', "'{{.State.FinishedAt}}'", containerId]);
    const finishedAt = output.trim();
    if (finishedAt && finishedAt !== '0001-01-01T00:00:00Z') {
      return new Date(finishedAt).getTime();
    }
    // 如果容器还在运行，获取StartedAt
    const startedAt = runDocker(['inspect', '--format', "'{{.State.StartedAt}}'", containerId]).trim();
    return startedAt ? new Date(startedAt).getTime() : null;
  } catch {
    return null;
  }
}

/**
 * 获取容器是否正在运行任务
 */
export function isContainerRunningTasks(containerId: string): boolean {
  try {
    // 检查容器是否在运行
    const status = runDocker(['inspect', '--format', "'{{.State.Running}}'", containerId]).trim();
    if (status !== 'true') {
      return false;
    }

    // 检查是否有活跃的 agent 会话
    // 通过检查 memory 目录中的活跃会话
    const output = runDocker(['exec', containerId, 'ls', '-t', '/home/node/.openclaw/agents/main/sessions/', '2>/dev/null | head -1']).trim();
    return !!output;
  } catch {
    return false;
  }
}

/**
 * 初始化 Docker 客户端
 */
export function initDocker(cfg: DockerConfig): void {
  config = cfg;
}

/**
 * 执行 docker 命令 (Task 11: Graceful Degradation)
 */
export function runDocker(args: string[], stdinInput?: string): string {
  ensureDockerAvailable();
  const result = spawnSync('docker', args, { encoding: 'utf-8', input: stdinInput });
  if (result.error) {
    // Docker 连接失败，标记为不可用
    if (result.error.message?.includes('ENOENT') || result.error.message?.includes('spawn docker')) {
      dockerAvailable = false;
    }
    throw result.error;
  }
  if (result.status !== 0) {
    const err = new Error(`Command failed: docker ${args.join(' ')}`);
    (err as any).status = result.status;
    (err as any).stdout = result.stdout;
    (err as any).stderr = result.stderr;
    throw err;
  }
  console.log('🔧 Running:', ['docker', ...args].join(' '));
  return result.stdout;
}

/**
 * 在容器中执行命令 (Task 11: Graceful Degradation)
 */
export function execDocker(containerId: string, cmd: string[]): string {
  ensureDockerAvailable();
  const fullCmd = ['docker', 'exec', containerId, ...cmd].join(' ');
  return execSync(fullCmd, { encoding: 'utf-8' });
}

/**
 * 列出容器
 */
export async function listContainers(opts: { all?: boolean } = {}): Promise<Array<{ ID: string; Names: string; State: string }>> {
  const args = ['ps', ...(opts.all ? ['-a'] : []), '--format', "'{{.ID}}|{{.Names}}|{{.State}}'"];
  const output = runDocker(args);
  return output.trim().split('\n').filter(Boolean).map(line => {
    const [ID, Names, State] = line.split('|');
    return { ID, Names, State };
  });
}

/**
 * 获取当前所有容器已占用的宿主机端口（用于池容器端口动态分配，避免与 planB 等已有容器冲突）
 */
export function getUsedHostPorts(): Set<number> {
  const used = new Set<number>();
  try {
    const output = runDocker(['ps', '-a', '--format', '{{.Ports}}']);
    for (const line of output.split('\n').filter(Boolean)) {
      for (const part of line.split(',').map(p => p.trim())) {
        const m = part.match(/:(\d+)->/);
        if (m) used.add(parseInt(m[1], 10));
      }
    }
  } catch {
    // 无容器或命令失败时返回空集合
  }
  return used;
}

/**
 * 获取容器 IP
 */
export async function getContainerIp(containerId: string): Promise<string> {
  try {
    const output = runDocker(['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', containerId]);
    return output.trim();
  } catch {
    return '';
  }
}

/**
 * 为用户创建 Gateway 容器
 * @param user - 用户映射
 * @param gatewayToken - Hooks API token
 * @param gatewayAuthToken - Gateway auth token (用于 OpenAI 兼容 API)
 */
export async function createUserContainer(
  user: FeishuUserRecord,
  gatewayToken: string,
  gatewayAuthToken: string,
  port?: number
): Promise<string> {
  const openId = user.spec.feishuOpenId;
  const actualPort = port || getNextGatewayPort();
  const containerName = `openclaw-gateway-${openId}`;

  // 用户数据目录
  const userDataDir = `${config.dataDir}/${openId}`;

  console.log('🔧 Creating container for user:', openId);
  console.log('🔧 User data dir:', userDataDir);
  console.log('🔧 Using image:', config.openclawImage);

  // 检查镜像是否存在
  try {
    const out = runDocker(['image', 'inspect', config.openclawImage]);
    console.log('🔧 Image found, output length:', out?.length);
  } catch (err: any) {
    console.error('❌ Image inspect failed:', err?.message, 'stderr:', err?.stderr, 'status:', err?.status);
    throw new Error(`Image ${config.openclawImage} not found`);
  }

  // 创建用户数据目录
  try {
    mkdirSync(`${userDataDir}/.openclaw`, { recursive: true });
  } catch {
    // 目录可能已存在
  }

  // 注入 hooks 和 gateway 配置到 openclaw.json
  const minimaxApiKey = process.env.MINIMAX_API_KEY || '';
  const minimaxBaseUrl = process.env.MINIMAX_BASE_URL || 'https://api.minimaxi.com/anthropic';
  const defaultModel = process.env.DEFAULT_MODEL || 'MiniMax-M2.5';

  const minimalConfig = {
    meta: {
      lastTouchedVersion: '2026.3.12',
      lastTouchedAt: new Date().toISOString(),
    },
    hooks: {
      enabled: true,
      token: gatewayToken,
      allowRequestSessionKey: true,
    },
    gateway: {
      mode: 'local',
      bind: 'lan',
      http: {
        endpoints: {
          chatCompletions: { enabled: true },
        },
      },
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
            {
              id: defaultModel,
              name: defaultModel,
              api: 'anthropic-messages',
              reasoning: false,
              input: ['text'],
            },
          ],
        },
      },
    },
    plugins: {
      entries: {
        feishu: { enabled: false },
      },
    },
  };

  try {
    writeFileSync(`${userDataDir}/.openclaw/openclaw.json`, JSON.stringify(minimalConfig, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to write openclaw.json:', err);
  }

  // 构建 docker run 命令
  const envVars = [
    `OPENCLAW_HOOKS_ENABLED=true`,
    `OPENCLAW_HOOKS_TOKEN=${gatewayToken}`,
    `OPENCLAW_HOME=/home/node`,
    `OPENCLAW_USER_OPEN_ID=${openId}`,
  ];

  // 简化启动命令：直接运行 Gateway（配置已在文件中预设）
  const startupCmd = `openclaw gateway run --bind lan --port 18789`;

  // 挂载技能目录：挂到全局管理目录 ~/.openclaw/skills，供所有 agent 使用
  const skillSourceDir = process.env.SKILL_DIR || path.join(process.cwd(), 'skills');
  const workspaceSkillsMount = '/home/node/.openclaw/skills';

  const args = [
    'run',
    '-d',
    '--name', containerName,
    '-p', `${actualPort}:18789`,
    '--network', 'openclaw-net',
    '-v', `${userDataDir}/.openclaw:/home/node/.openclaw`,
    '-v', `${skillSourceDir}:${workspaceSkillsMount}:ro`,
    '--add-host', 'host.docker.internal:host-gateway',
    '--user', 'root',
    // Resource limits
    '--memory', process.env.CONTAINER_MEMORY_LIMIT || '2g',
    '--memory-swap', '-1',  // allow swap
    '--cpus', process.env.CONTAINER_CPU_LIMIT || '1',
    '--restart', 'on-failure:3',
    '--entrypoint', 'sh',
    ...envVars.flatMap(e => ['-e', e]),
    config.openclawImage,
    '-c', startupCmd,
  ];

  console.log('🔧 Docker command:', 'docker', args.join(' '));

  try {
    const containerId = runDocker(args).trim();
    console.log('✅ Container created:', containerId);

    // Wait briefly for Docker to assign the network IP
    await new Promise(resolve => setTimeout(resolve, 2000));
    const containerIp = await getContainerIp(containerId);
    console.log(`🌐 Container IP on openclaw-net: ${containerIp}`);

    return containerId;
  } catch (err) {
    console.error('❌ Error creating container:', err);
    throw err;
  }
}

/**
 * 级联回滚：如果容器创建失败，自动删除已创建的容器和用户记录 (Task 12)
 */
export async function createUserContainerWithRollback(
  user: FeishuUserRecord,
  token: string,
  authToken: string,
  port: number
): Promise<string> {
  let containerId: string | null = null;
  try {
    containerId = await createUserContainer(user, token, authToken, port);
    return containerId;
  } catch (err) {
    // 回滚：删除已创建的容器
    if (containerId) {
      try {
        await removeContainer(containerId);
        console.log(`[Rollback] Container ${containerId} removed after create failure`);
      } catch (rollbackErr) {
        console.error(`[Rollback] Failed to remove container ${containerId}:`, rollbackErr);
      }
    }
    // 回滚：删除用户记录
    try {
      await deleteUser(user.spec.feishuOpenId);
    } catch { /* ignore */ }
    throw err;
  }
}

/**
 * 启动用户容器
 */
export async function startUserContainer(containerId: string): Promise<void> {
  runDocker(['start', containerId]);
}

/**
 * 停止用户容器
 */
export async function stopUserContainer(containerId: string): Promise<void> {
  runDocker(['stop', containerId]);
}

/**
 * 重启用户容器
 */
export async function restartUserContainer(containerId: string): Promise<void> {
  runDocker(['restart', containerId]);
}

/**
 * 删除用户容器
 */
export async function removeUserContainer(containerId: string): Promise<void> {
  try {
    runDocker(['stop', containerId]);
  } catch {
    // 可能已经停止
  }
  runDocker(['rm', '-f', containerId]);
}

/**
 * 获取容器状态
 */
export async function getContainerStatus(containerId: string): Promise<{
  status: string;
  running: boolean;
}> {
  const output = runDocker(['inspect', '--format', "'{{.State.Status}}'", containerId]);
  return {
    status: output.trim(),
    running: output.trim() === 'running',
  };
}

/**
 * 获取容器日志
 */
export async function getContainerLogs(
  containerId: string,
  tail: number = 100
): Promise<string> {
  return runDocker(['logs', '--tail', String(tail), containerId]);
}

/**
 * 从容器获取 Gateway auth token（带重试）
 * Gateway 启动后会生成 auth token，需要轮询等待
 */
export async function getGatewayAuthToken(containerId: string, maxWaitMs = 60000): Promise<string> {
  const baseIntervalMs = 3000;
  let attempt = 0;
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const output = runDocker(['exec', containerId, 'cat', '/home/node/.openclaw/openclaw.json']);
      const config = JSON.parse(output);
      const token = config.gateway?.auth?.token;
      if (token && token.trim()) {
        if (attempt > 0) console.log(`[GatewayAuth] Token received after ${attempt} retries`);
        return token;
      }
    } catch {
      // still starting
    }
    await new Promise(r => setTimeout(r, Math.min(baseIntervalMs * Math.pow(1.5, attempt), 15000)));
    attempt++;
  }
  throw new Error('Gateway auth token not ready in time');
}

/**
 * 检查容器是否存在
 */
export async function containerExists(containerName: string): Promise<boolean> {
  try {
    runDocker(['inspect', containerName]);
    return true;
  } catch {
    return false;
  }
}

/**
 * 获取用户 Gateway URL
 * 注意：在 Docker 容器内运行时，使用 host.docker.internal 访问宿主机
 */
export function getUserGatewayUrl(openId: string, port: number): string {
  const isLocalhost = config.host === 'localhost' || config.host === '127.0.0.1';

  let host: string;
  if (isLocalhost) {
    // 在 Docker 内运行时，使用 host.docker.internal 访问宿主机
    // 在宿主机上运行时，使用 localhost
    host = process.env.DOCKER_CONTAINER ? 'host.docker.internal' : 'localhost';
  } else {
    host = config.host;
  }
  return `http://${host}:${port}`;
}

/**
 * 获取所有运行中的 OpenClaw 容器
 */
export async function listOpenclawContainers(): Promise<
  Array<{
    id: string;
    name: string;
    status: string;
    image: string;
    ports: string[];
    created: number;
  }>
> {
  // Task 11: Graceful Degradation — wrap direct execSync
  if (!checkDockerHealth()) {
    console.warn('[Docker] listOpenclawContainers: Docker unavailable, returning empty list');
    return [];
  }
  const output = execSync('docker ps --format "{{.ID}}|{{.Names}}|{{.Status}}|{{.Image}}|{{.Ports}}|{{.CreatedAt}}"', { encoding: 'utf-8' });

  return output.trim().split('\n')
    .filter(line => line.includes('openclaw'))
    .map(line => {
      const [id, name, status, image, ports, createdAt] = line.split('|');
      // Parse created timestamp (format: 2026-03-15 12:34:56 +0800 CST)
      let created = Date.now();
      try {
        const parsed = new Date(createdAt);
        if (!isNaN(parsed.getTime())) {
          created = parsed.getTime() / 1000;
        }
      } catch (e) {
        // Use current time as fallback
      }
      return {
        id,
        name,
        status,
        image: image || '',
        ports: ports ? ports.split(', ') : [],
        created,
      };
    });
}

/**
 * 技能目录路径
 */
const SKILL_DIR = process.env.SKILL_DIR || path.join(process.cwd(), 'skills');

/**
 * 将 skill 广播到所有用户容器
 */
export async function broadcastSkillToContainers(skill: {
  name: string;
  content: string;
}): Promise<void> {
  const skillPath = `${SKILL_DIR}/${skill.name}`;
  await fs.mkdir(skillPath, { recursive: true });

  // 解析 content，写入文件
  // content 应该是 JSON 格式 { "SKILL.md": "...", "index.js": "..." }
  const files = JSON.parse(skill.content);
  for (const [filename, fileContent] of Object.entries(files)) {
    const filePath = path.join(skillPath, filename);
    let finalContent = fileContent as string;

    // Wrap .md skill files with builtin markers to preserve user edits
    if (filename.endsWith('.md')) {
      // Format: <!-- builtin-start --> / comment / content / <!-- builtin-end --> / user content
      const builtinBlock =
        `${BUILTIN_START}\n${BUILTIN_START_COMMENT}\n${(fileContent as string).trim()}\n${BUILTIN_END}`;
      try {
        const existing = await fs.readFile(filePath, 'utf-8');
        const { merged } = mergeBuiltinContent(builtinBlock, existing);
        finalContent = merged;
      } catch {
        // File doesn't exist yet — use builtin-wrapped content directly
        finalContent = builtinBlock;
      }
    }

    await fs.writeFile(filePath, finalContent);
  }

  console.log(`📦 Skill ${skill.name} broadcasted to local skills directory`);
}

/**
 * 重启所有用户 Gateway 容器
 */
export async function restartAllUserGateways(): Promise<void> {
  const containers = await listOpenclawContainers();
  console.log(`🔄 Restarting ${containers.length} user gateways...`);

  for (const container of containers) {
    try {
      runDocker(['restart', container.id]);
      console.log(`  ✅ Restarted ${container.name}`);
    } catch (error) {
      console.error(`  ❌ Failed to restart ${container.name}:`, error);
    }
  }
}

// ========== 容器管理 API ==========

/**
 * 启动容器
 */
export async function startContainer(containerIdOrName: string): Promise<void> {
  runDocker(['start', containerIdOrName]);
}

/**
 * 停止容器
 */
export async function stopContainer(containerIdOrName: string): Promise<void> {
  runDocker(['stop', containerIdOrName]);
}

/**
 * 重启容器
 */
export async function restartContainer(containerIdOrName: string): Promise<void> {
  runDocker(['restart', containerIdOrName]);
}

/**
 * 获取用户容器配置（通过 exec cat）
 */
export async function getUserContainerConfig(openId: string): Promise<any> {
  const containerName = `openclaw-gateway-${openId}`;
  try {
    const output = runDocker(['exec', containerName, 'cat', '/home/node/.openclaw/openclaw.json']);
    return JSON.parse(output);
  } catch (error) {
    console.error(`Failed to get config for ${openId}:`, error);
    throw error;
  }
}

/**
 * 更新用户容器配置
 */
export async function updateUserContainerConfig(openId: string, config: any): Promise<void> {
  const containerName = `openclaw-gateway-${openId}`;
  const configJson = JSON.stringify(config, null, 2);

  // 使用 base64 编码来避免特殊字符问题
  const base64Config = Buffer.from(configJson).toString('base64');

  try {
    // 先把配置写入临时文件
    runDocker(['exec', containerName, 'sh', '-c', `echo '${base64Config}' | base64 -d > /home/node/.openclaw/openclaw.json`]);
  } catch (error) {
    console.error(`Failed to update config for ${openId}:`, error);
    throw error;
  }
}

/**
 * 获取容器配置（通过 inspect）- 通用版本
 */
export async function getContainerConfig(containerName: string): Promise<any> {
  const output = runDocker(['inspect', containerName]);
  return JSON.parse(output);
}

/**
 * 更新容器配置（通过 exec）- 通用版本
 */
export async function updateContainerConfig(containerName: string, config: any): Promise<void> {
  const configJson = JSON.stringify(config, null, 2);
  const base64Config = Buffer.from(configJson).toString('base64');

  try {
    // 获取容器的挂载点信息
    const mountOutput = runDocker(['inspect', '--format', "'{{.Mounts}}'", containerName]);
    // 尝试写入到第一个挂载的 .openclaw 目录
    runDocker(['exec', containerName, 'sh', '-c', `echo '${base64Config}' | base64 -d > /tmp/openclaw.json && cp /tmp/openclaw.json /home/node/.openclaw/openclaw.json`]);
  } catch (error) {
    console.error(`Failed to update config for ${containerName}:`, error);
    throw error;
  }
}


/**
 * Gateway 客户端 - 使用 OpenAI 兼容 API 直接获取响应
 * 优点：不需要配置 channel，响应直接在 HTTP body 中返回
 */
import axios, { AxiosError } from 'axios';
import type { GatewayHookResponse } from './types.js';
import { CircuitBreaker } from './lib/circuit-breaker.js';

export interface GatewayClientConfig {
  timeout?: number;
  retryAttempts?: number;
}

/** Per-gateway-url circuit breakers to isolate failures per user */
const cbRegistry = new Map<string, CircuitBreaker>();

function getCb(gatewayUrl: string): CircuitBreaker {
  if (!cbRegistry.has(gatewayUrl)) {
    cbRegistry.set(gatewayUrl, new CircuitBreaker({
      name: gatewayUrl,
      timeout: 60_000,     // Gateway cold-start can take 6+ seconds
      errorThreshold: 5,   // be more tolerant
      resetTimeout: 60_000,
    }));
  }
  return cbRegistry.get(gatewayUrl)!;
}

/** Check if a gateway is healthy */
export async function checkGatewayHealth(
  gatewayUrl: string,
  token: string,
): Promise<boolean> {
  try {
    const res = await axios.get(`${gatewayUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 5000,
    });
    return res.status < 400;
  } catch {
    return false;
  }
}

const DEFAULT_TIMEOUT = 120000; // 2 分钟
const DEFAULT_RETRY = 2;

/**
 * OpenAI 兼容的聊天请求
 */
interface ChatCompletionRequest {
  model?: string;
  messages: Array<{
    role: 'user' | 'assistant' | 'system';
    content: string;
  }>;
  stream?: boolean;
}

/**
 * OpenAI 兼容的聊天响应
 */
interface ChatCompletionResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * 创建 Gateway 客户端
 */
export function createGatewayClient(baseUrl: string, token: string, config: GatewayClientConfig = {}) {
  const timeout = config.timeout || DEFAULT_TIMEOUT;
  const retryAttempts = config.retryAttempts || DEFAULT_RETRY;

  const client = axios.create({
    baseURL: baseUrl,
    timeout,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  /**
   * 使用 OpenAI 兼容 API 发送消息并获取直接响应
   */
  async function sendMessage(message: string, options: {
    sessionKey?: string;
    model?: string;
    timeoutSeconds?: number;
  } = {}): Promise<GatewayHookResponse> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= retryAttempts; attempt++) {
      try {
        const request: ChatCompletionRequest = {
          model: options.model || process.env.DEFAULT_MODEL || 'minimax/MiniMax-M2.5',
          messages: [
            {
              role: 'user',
              content: message,
            },
          ],
          stream: false,
        };

        const response = await client.post<ChatCompletionResponse>('/v1/chat/completions', request);

        const choice = response.data.choices[0];
        if (!choice) {
          return {
            ok: false,
            error: 'No response from Gateway',
          };
        }

        return {
          ok: true,
          text: choice.message.content,
          runId: response.data.id,
        };
      } catch (error) {
        lastError = error as Error;

        // 如果是客户端错误（4xx），不重试
        if (error instanceof AxiosError) {
          if (error.response?.status && error.response.status < 500) {
            const errorData = error.response.data as Record<string, unknown>;
            return {
              ok: false,
              error: `Gateway error: ${error.response.status} ${error.response.statusText} - ${(errorData.error as { message?: string })?.message || error.message}`,
            };
          }
          // 5xx：记录响应体便于排查，再决定是否重试
          const status = error.response?.status;
          const body = error.response?.data;
          const detail = typeof body === 'object' && body && 'error' in body
            ? String((body as { error?: { message?: string } }).error?.message ?? JSON.stringify(body))
            : typeof body === 'string' ? body : JSON.stringify(body ?? '');
          console.error(`❌ Gateway /v1/chat/completions returned ${status}:`, detail);
        }

        // 等待后重试
        if (attempt < retryAttempts) {
          await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        }
      }
    }

    // 最后一次失败：尽量带上 Gateway 返回的 body
    let errMsg = lastError?.message || 'Unknown error';
    if (lastError instanceof AxiosError && lastError.response?.data != null) {
      const body = lastError.response.data as Record<string, unknown>;
      const msg = (body?.error as { message?: string })?.message ?? (body?.message as string);
      if (msg) errMsg = msg;
    }
    return {
      ok: false,
      error: errMsg,
    };
  }

  /**
   * 检查 Gateway 是否可用
   */
  async function ping(): Promise<boolean> {
    try {
      // 使用 /v1/models 端点检测服务是否可用
      await client.get('/v1/models').catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 获取 Gateway 状态
   */
  async function getStatus(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      await client.get('/v1/models');
      return { ok: true };
    } catch (error) {
      if (error instanceof AxiosError) {
        return { ok: false, error: error.message };
      }
      return { ok: false, error: 'Unknown error' };
    }
  }

  return {
    sendMessage,
    ping,
    getStatus,
  };
}

/**
 * 便捷函数：直接发送消息到用户 Gateway
 * @param gatewayUrl - Gateway URL
 * @param token - Gateway auth token (用于 OpenAI 兼容 API)
 * @param message - 消息内容
 * @param options - 可选参数
 */
export async function sendToGateway(
  gatewayUrl: string,
  token: string,
  message: string,
  options: {
    sessionKey?: string;
    name?: string;
    model?: string;
    thinking?: 'low' | 'medium' | 'high';
    timeoutSeconds?: number;
  } = {}
): Promise<GatewayHookResponse> {
  const cb = getCb(gatewayUrl);
  console.log(`[GatewayClient] Calling ${gatewayUrl}, CB state=${cb.getState()}, failures=${cb.getFailureCount()}`);
  try {
    const result = await cb.execute(() => {
      const client = createGatewayClient(gatewayUrl, token);
      return client.sendMessage(message, {
        sessionKey: options.sessionKey,
        model: options.model,
        timeoutSeconds: options.timeoutSeconds,
      });
    });
    console.log(`[GatewayClient] Gateway responded successfully`);
    return result;
  } catch (err) {
    console.log(`[GatewayClient] Gateway call failed: ${err instanceof Error ? err.message : err}`);
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Circuit breaker error',
    };
  }
}

/**
 * 使用 Hooks API 发送消息到用户 Gateway
 * @param gatewayUrl - Gateway URL
 * @param hooksToken - Gateway hooks token
 * @param message - 消息内容
 * @param options - 可选参数
 */
export async function sendToGatewayViaHooks(
  gatewayUrl: string,
  hooksToken: string,
  message: string,
  options: {
    sessionKey?: string;
    name?: string;
    model?: string;
    thinking?: 'low' | 'medium' | 'high';
    timeoutSeconds?: number;
  } = {}
): Promise<GatewayHookResponse> {
  const timeout = (options.timeoutSeconds || 120) * 1000;
  const cb = getCb(gatewayUrl);

  try {
    return await cb.execute(async () => {
      const response = await axios.post<GatewayHookResponse>(
        `${gatewayUrl}/hooks/agent`,
        {
          message,
          sessionKey: options.sessionKey,
          name: options.name,
          model: options.model,
          thinking: options.thinking,
        },
        {
          headers: {
            'Authorization': `Bearer ${hooksToken}`,
            'Content-Type': 'application/json',
          },
          timeout,
        }
      );
      return response.data;
    });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Circuit breaker error',
    };
  }
}

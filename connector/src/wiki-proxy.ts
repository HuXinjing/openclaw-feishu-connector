/**
 * 飞书 Wiki 代理 API - 让用户容器可以访问飞书知识库
 * 使用 Connector 的飞书凭证
 */
import axios from 'axios';

const FEISHU_APP_ID = process.env.FEISHU_APP_ID;
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET;
if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
  throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET environment variables are required');
}

let accessToken: string | null = null;
let tokenExpireTime = 0;

/**
 * 获取飞书 tenant_access_token（app 级）
 */
export async function getTenantAccessToken(): Promise<string> {
  const now = Date.now();
  if (accessToken && now < tokenExpireTime) {
    return accessToken;
  }

  const response = await axios.post(
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    {
      app_id: FEISHU_APP_ID,
      app_secret: FEISHU_APP_SECRET,
    }
  );

  if (response.data.code !== 0) {
    throw new Error(`Failed to get access token: ${response.data.msg}`);
  }

  accessToken = response.data.tenant_access_token;
  tokenExpireTime = now + response.data.expire * 1000 - 60000; // 提前1分钟过期
  return accessToken;
}

/**
 * 列出知识空间
 */
export async function listWikiSpaces(): Promise<any> {
  const token = await getTenantAccessToken();
  const response = await axios.get(
    'https://open.feishu.cn/open-apis/wiki/v2/spaces',
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  if (response.data.code !== 0) {
    throw new Error(`Failed to list spaces: ${response.data.msg}`);
  }

  return response.data.data;
}

/**
 * 列出知识库节点
 */
export async function listWikiNodes(spaceId: string, parentNodeToken?: string): Promise<any> {
  const token = await getTenantAccessToken();
  const response = await axios.get(
    'https://open.feishu.cn/open-apis/wiki/v2/spaces/' + spaceId + '/nodes',
    {
      headers: { Authorization: `Bearer ${token}` },
      params: parentNodeToken ? { parent_node_token: parentNodeToken } : {},
    }
  );

  if (response.data.code !== 0) {
    throw new Error(`Failed to list nodes: ${response.data.msg}`);
  }

  return response.data.data;
}

/**
 * 获取节点详情
 */
export async function getWikiNode(token: string): Promise<any> {
  const accessToken = await getTenantAccessToken();
  const response = await axios.get(
    'https://open.feishu.cn/open-apis/wiki/v2/nodes/' + token,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  if (response.data.code !== 0) {
    throw new Error(`Failed to get node: ${response.data.msg}`);
  }

  return response.data.data;
}

/**
 * 使用 user_access_token 搜索知识库（需用户 OAuth 授权）
 * 飞书接口：POST wiki/v2/nodes/search，凭证要求 user_access_token
 */
export async function searchWikiWithUserToken(
  userAccessToken: string,
  params: { query: string; space_id?: string; limit?: number }
): Promise<{ items: Array<{ node_id: string; title: string; url: string; space_id: string; obj_type?: number }>; has_more?: boolean; page_token?: string }> {
  const { query, space_id, limit = 20 } = params;
  const pageSize = Math.min(Math.max(1, limit), 50);
  const response = await axios.post(
    'https://open.feishu.cn/open-apis/wiki/v2/nodes/search',
    { query: query.slice(0, 50), space_id: space_id || undefined },
    {
      headers: { Authorization: `Bearer ${userAccessToken}` },
      params: { page_size: pageSize },
    }
  );

  if (response.data.code !== 0) {
    throw new Error(`Wiki search failed: ${response.data.msg}`);
  }

  const data = response.data.data || {};
  return {
    items: data.items || [],
    has_more: data.has_more,
    page_token: data.page_token,
  };
}

/**
 * 处理 Wiki API 请求
 */
export async function handleWikiRequest(action: string, params: Record<string, any>): Promise<any> {
  switch (action) {
    case 'spaces':
      return await listWikiSpaces();

    case 'nodes':
      return await listWikiNodes(params.space_id, params.parent_node_token);

    case 'get':
      return await getWikiNode(params.token);

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

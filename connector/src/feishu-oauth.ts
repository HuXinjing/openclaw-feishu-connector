/**
 * 飞书 OAuth：获取授权链接、用 code 换 user_access_token
 * 用于知识库搜索等需要用户凭证的 API
 */
import axios from 'axios';
import { getTenantAccessToken } from './wiki-proxy.js';
import { setUserAccessToken } from './user-token-store.js';

const FEISHU_APP_ID = process.env.FEISHU_APP_ID || '';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || '';

/** 重定向 URI 需在飞书后台配置；本地开发可用 CONNECTOR_PUBLIC_URL=http://localhost:3000 */
const CONNECTOR_PUBLIC_URL = (process.env.CONNECTOR_PUBLIC_URL || process.env.CONNECTOR_URL || 'http://localhost:3000').replace(/\/$/, '');

/** 知识库搜索所需 scope，需在飞书应用后台开通「查看知识库」等权限 */
const WIKI_SCOPE = 'wiki:wiki:readonly';

/**
 * 生成授权链接，state 传 open_id 以便回调时关联用户
 */
/** 实际发给飞书的 redirect_uri（未编码），必须与飞书后台「安全设置 → 重定向 URL」中配置的完全一致 */
export function getRedirectUri(): string {
  return `${CONNECTOR_PUBLIC_URL}/api/feishu/oauth/callback`;
}

export function buildAuthUrl(openId: string): string {
  const redirectUriRaw = getRedirectUri();
  console.log(`[OAuth] redirect_uri（请在飞书后台添加与此完全一致）: ${redirectUriRaw}`);
  const redirectUri = encodeURIComponent(redirectUriRaw);
  const scope = encodeURIComponent(WIKI_SCOPE);
  const state = encodeURIComponent(openId);
  return `https://accounts.feishu.cn/open-apis/authen/v1/authorize?client_id=${FEISHU_APP_ID}&response_type=code&redirect_uri=${redirectUri}&scope=${scope}&state=${state}`;
}

/**
 * 用授权码换取 user_access_token 并写入 store
 */
export async function exchangeCodeForUserToken(code: string, stateOpenId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const tenantToken = await getTenantAccessToken();
    const res = await axios.post<{
      code: number;
      msg?: string;
      data?: { access_token: string; expire?: number; expires_in?: number };
    }>(
      'https://open.feishu.cn/open-apis/authen/v1/access_token',
      { grant_type: 'authorization_code', code },
      { headers: { Authorization: `Bearer ${tenantToken}` } }
    );
    if (res.data.code !== 0 || !res.data.data?.access_token) {
      console.log('[OAuth] exchange failed: code=', res.data.code, 'msg=', res.data.msg);
      return { ok: false, error: res.data.msg || 'Failed to get user token' };
    }
    const d = res.data.data;
    const expiresIn = d.expire ?? d.expires_in ?? 7200;
    await setUserAccessToken(stateOpenId, d.access_token, expiresIn);
    console.log('[OAuth] token saved for open_id=', stateOpenId, 'expires_in=', expiresIn);
    return { ok: true };
  } catch (e: any) {
    console.log('[OAuth] exchange error:', e?.response?.data ?? e?.message ?? e);
    return { ok: false, error: e?.response?.data?.msg || e?.message || String(e) };
  }
}

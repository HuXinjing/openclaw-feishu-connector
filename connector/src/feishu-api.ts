/**
 * 飞书 API 统一封装 - 供 Skill 调用
 */
import axios from 'axios';

const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';

// 从环境变量获取凭证
const FEISHU_APP_ID = process.env.FEISHU_APP_ID || '';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || '';

// Token 缓存
let tenantToken: string | null = null;
let tokenExpireTime = 0;

/**
 * 获取 tenant_access_token
 */
async function getTenantAccessToken(): Promise<string> {
  const now = Date.now();
  if (tenantToken && now < tokenExpireTime - 60000) {
    return tenantToken;
  }

  const response = await axios.post(
    `${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal`,
    {
      app_id: FEISHU_APP_ID,
      app_secret: FEISHU_APP_SECRET,
    }
  );

  if (response.data.code !== 0) {
    throw new Error(`Failed to get tenant token: ${response.data.msg}`);
  }

  tenantToken = response.data.tenant_access_token;
  tokenExpireTime = now + response.data.expire * 1000;

  return tenantToken!;
}

/**
 * 通用请求方法
 */
async function feishuRequest(method: string, path: string, data?: any, params?: any): Promise<any> {
  const token = await getTenantAccessToken();

  console.log(`[Feishu API] ${method} ${path}`);

  const response = await axios({
    method,
    url: `${FEISHU_API_BASE}${path}`,
    data,
    params,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (response.data.code !== 0) {
    console.error(`[Feishu API] Error ${response.data.code}: ${response.data.msg}`);
    // 把飞书的错误 code + msg 一起抛出，方便 Bridge / Agent 在会话中展示更完整的信息
    throw new Error(`Feishu API error (code: ${response.data.code}): ${response.data.msg}`);
  }

  console.log(`[Feishu API] ${method} ${path} - OK`);
  return response.data.data;
}

// ========== IM 消息 API ==========

/**
 * 获取用户消息列表
 */
export async function getMessages(params: {
  receive_id: string;
  receive_id_type: 'open_id' | 'chat_id';
  container_id_type?: 'open_id' | 'chat_id';
  start_time?: string;
  end_time?: string;
  page_size?: number;
  page_token?: string;
}): Promise<any> {
  return feishuRequest('GET', '/im/v1/messages', undefined, {
    receive_id: params.receive_id,
    receive_id_type: params.receive_id_type,
    container_id_type: params.container_id_type,
    start_time: params.start_time,
    end_time: params.end_time,
    page_size: params.page_size || 50,
    page_token: params.page_token,
  });
}

/**
 * 获取话题消息
 */
export async function getThreadMessages(params: {
  container_id_type: 'chat_id' | 'thread_id';
  container_id: string;
  page_size?: number;
  page_token?: string;
}): Promise<any> {
  return feishuRequest('GET', '/im/v1/messages', undefined, {
    container_id_type: params.container_id_type,
    container_id: params.container_id,
    page_size: params.page_size || 50,
    page_token: params.page_token,
  });
}

/**
 * 搜索消息
 */
export async function searchMessages(params: {
  query?: string;
  page_size?: number;
  page_token?: string;
}): Promise<any> {
  return feishuRequest('POST', '/im/v1/messages/search', {
    query: params.query,
    page_size: params.page_size || 20,
    page_token: params.page_token,
  });
}

/**
 * 下载资源
 */
/**
 * 下载消息中的资源（图片/文件/音频/视频）
 * 与官方飞书插件保持一致：type 只支持 'image' 和 'file'
 * file 适用于：普通文件、音频、视频
 */
export async function fetchResource(params: {
  message_id: string;
  file_key: string;
  type: 'image' | 'file';
}): Promise<any> {
  return feishuRequest('GET', `/im/v1/messages/${params.message_id}/resources/${params.file_key}`, undefined, {
    type: params.type,
  });
}

// ========== 文档 API ==========

/**
 * 创建文档
 */
export async function createDoc(params: {
  obj_type: 'doc' | 'sheet' | 'bitable' | 'mindmap';
  title?: string;
  content?: string;
}): Promise<any> {
  return feishuRequest('POST', '/drive/explorer/v2/files', {
    obj_type: params.obj_type,
    name: params.title || 'Untitled',
    parent_node: 'root',
  });
}

/**
 * 获取文档内容
 */
export async function fetchDoc(params: {
  token: string;
  obj_type?: 'doc' | 'sheet' | 'bitable';
}): Promise<any> {
  return feishuRequest('GET', `/drive/explorer/v2/files/${params.token}`, {
    obj_type: params.obj_type || 'doc',
  });
}

/**
 * 获取文档块内容
 */
export async function getDocBlocks(params: {
  token: string;
  page_size?: number;
  page_token?: string;
}): Promise<any> {
  return feishuRequest('GET', `/doc/v1/documents/${params.token}/blocks`, undefined, {
    page_size: params.page_size || 100,
    page_token: params.page_token,
  });
}

/**
 * 更新文档
 */
export async function updateDoc(params: {
  token: string;
  requests: any[];
}): Promise<any> {
  return feishuRequest('PATCH', `/doc/v1/documents/${params.token}/blocks/batch_update`, {
    requests: params.requests,
  });
}

// ========== 日历 API ==========

/**
 * 获取日历列表
 */
export async function listCalendars(): Promise<any> {
  return feishuRequest('GET', '/calendar/v4/calendars');
}

/**
 * 获取日历事件
 */
export async function getCalendarEvents(params: {
  calendar_id: string;
  start_time: string;
  end_time?: string;
  page_size?: number;
}): Promise<any> {
  return feishuRequest('GET', `/calendar/v4/calendars/${params.calendar_id}/events`, undefined, {
    start_time: params.start_time,
    end_time: params.end_time,
    page_size: params.page_size || 50,
  });
}

/**
 * 创建日历事件
 */
export async function createCalendarEvent(params: {
  calendar_id: string;
  summary?: string;
  description?: string;
  start_time: { timestamp: string; timezone?: string };
  end_time?: { timestamp: string; timezone?: string };
}): Promise<any> {
  return feishuRequest('POST', `/calendar/v4/calendars/${params.calendar_id}/events`, {
    summary: params.summary,
    description: params.description,
    start: params.start_time,
    end: params.end_time,
  });
}

// ========== 云空间 API ==========

/**
 * 获取云空间列表
 */
export async function listBitables(): Promise<any> {
  return feishuRequest('GET', '/bitable/v1/apps');
}

/**
 * 获取云空间数据
 */
export async function getBitableData(params: {
  app_token: string;
  table_id?: string;
  record_ids?: string[];
}): Promise<any> {
  if (params.record_ids) {
    return feishuRequest('POST', `/bitable/v1/apps/${params.app_token}/records/batch_get`, {
      record_ids: params.record_ids,
    });
  }
  return feishuRequest('GET', `/bitable/v1/apps/${params.app_token}/tables`);
}

// ========== 任务 API ==========

/**
 * 获取任务列表
 */
export async function listTasks(params: {
  completed?: boolean;
  page_size?: number;
}): Promise<any> {
  return feishuRequest('GET', '/task/v1/tasks', undefined, {
    completed: params.completed,
    page_size: params.page_size || 20,
  });
}

/**
 * 创建任务
 */
export async function createTask(params: {
  summary: string;
  description?: string;
  due?: { timestamp: string };
}): Promise<any> {
  return feishuRequest('POST', '/task/v1/tasks', {
    summary: params.summary,
    description: params.description,
    due: params.due,
  });
}

// ========== 消息发送 API ==========

/**
 * 发送消息
 */
export async function sendMessage(params: {
  receive_id: string;
  receive_id_type: 'open_id' | 'chat_id';
  msg_type: 'text' | 'post' | 'interactive' | 'image';
  content: any;
}): Promise<any> {
  return feishuRequest('POST', '/im/v1/messages', {
    receive_id: params.receive_id,
    receive_id_type: params.receive_id_type,
    msg_type: params.msg_type,
    content: typeof params.content === 'string' ? params.content : JSON.stringify(params.content),
  }, { receive_id_type: params.receive_id_type });
}

/**
 * 回复消息
 */
export async function replyMessage(params: {
  message_id: string;
  msg_type: 'text' | 'post' | 'interactive';
  content: any;
}): Promise<any> {
  return feishuRequest('POST', `/im/v1/messages/${params.message_id}/reply`, {
    msg_type: params.msg_type,
    content: typeof params.content === 'string' ? params.content : JSON.stringify(params.content),
  });
}

/**
 * 发送文本消息
 */
export async function sendTextMessage(receiveId: string, receiveIdType: 'open_id' | 'chat_id', text: string): Promise<any> {
  return sendMessage({
    receive_id: receiveId,
    receive_id_type: receiveIdType,
    msg_type: 'text',
    content: { text },
  });
}

// ========== 用户 API ==========

/**
 * 获取用户信息
 */
export async function getUserInfo(openId: string): Promise<any> {
  return feishuRequest('GET', `/contact/v3/users/${openId}`);
}

/**
 * 批量获取员工花名册信息（EHR）
 * 参考文档：https://open.feishu.cn/document/server-docs/ehr-v1/list
 * 这里仅封装最常用的分页字段，并返回原始 data，调用方自行解析 employment_status 等字段。
 */
export async function listEmployees(params: {
  page_size?: number;
  page_token?: string;
} = {}): Promise<any> {
  return feishuRequest('POST', '/ehr/v1/employees/list', {
    page_size: params.page_size || 200,
    page_token: params.page_token,
  });
}

/**
 * 获取用户列表
 * - 如果有 query 参数，使用搜索接口 /search/v1/user
 * - 否则使用部门列表接口 /contact/v3/users
 * 返回格式统一为 { users: [...] }
 */
export async function listUsers(params: {
  query?: string;
  page_size?: number;
}): Promise<any> {
  const pageSize = params.page_size || 20;
  let data: any;

  if (params.query) {
    // 使用飞书搜索接口，返回格式可能是 data.users
    const result = await feishuRequest('GET', '/search/v1/user', undefined, {
      query: params.query,
      page_size: pageSize,
    });
    // 统一返回 users 字段
    return { users: result.users || result.items || [] };
  }

  // 没有 query 时，按部门拉列表，返回格式可能是 data.items
  const result = await feishuRequest('GET', '/contact/v3/users', undefined, {
    department_id: '0',
    page_size: pageSize,
  });
  // 统一返回 users 字段
  return { users: result.items || result.user_list || [] };
}

/**
 * 获取群聊信息
 */
export async function getChatInfo(chatId: string): Promise<any> {
  return feishuRequest('GET', `/im/v1/chats/${chatId}`);
}

/**
 * 获取群聊列表
 */
/**
 * 获取群聊列表
 * - 如果有 query 参数，使用搜索接口 /im/v1/chats/search
 * - 否则使用列表接口 /im/v1/chats
 * 返回格式统一为 { groups: [...] }
 */
export async function listChats(params: {
  query?: string;
  page_size?: number;
}): Promise<any> {
  const pageSize = params.page_size || 20;

  if (params.query) {
    // 使用飞书群聊搜索接口
    const result = await feishuRequest('GET', '/im/v1/chats/search', undefined, {
      query: params.query,
      page_size: pageSize,
    });
    // 统一返回 groups 字段
    return { groups: result.items || [] };
  }

  // 没有 query 时，返回群聊列表
  const result = await feishuRequest('GET', '/im/v1/chats', undefined, {
    page_size: pageSize,
  });
  // 统一返回 groups 字段
  return { groups: result.items || result.chats || [] };
}

/**
 * 获取群聊成员
 */
export async function getChatMembers(chatId: string): Promise<any> {
  return feishuRequest('GET', `/im/v1/chats/${chatId}/members`, undefined, { page_size: 100 });
}

// ========== 统一入口 ==========

/**
 * 处理 Feishu API 请求
 */
export async function handleFeishuRequest(action: string, params: Record<string, any>): Promise<any> {
  switch (action) {
    // IM 消息
    case 'get_messages':
      return getMessages(params as any);
    case 'get_thread_messages':
      return getThreadMessages(params as any);
    case 'search_messages':
      return searchMessages(params as any);
    case 'fetch_resource':
      return fetchResource(params as any);

    // 文档
    case 'create_doc':
      return createDoc(params as any);
    case 'fetch_doc':
      return fetchDoc(params as any);
    case 'get_doc_blocks':
      return getDocBlocks(params as any);
    case 'update_doc':
      return updateDoc(params as any);

    // 日历
    case 'list_calendars':
      return listCalendars();
    case 'get_calendar_events':
      return getCalendarEvents(params as any);
    case 'create_calendar_event':
      return createCalendarEvent(params as any);

    // 云空间
    case 'list_bitables':
      return listBitables();
    case 'get_bitable_data':
      return getBitableData(params as any);

    // 任务
    case 'list_tasks':
      return listTasks(params as any);
    case 'create_task':
      return createTask(params as any);

    // 消息发送
    case 'send_message':
      return sendMessage(params as any);
    case 'send_text':
      return sendTextMessage(params.receive_id, params.receive_id_type, params.text);
    case 'reply_message':
      return replyMessage(params as any);

    // 用户
    case 'get_user_info':
      return getUserInfo(params.open_id);
    case 'list_users':
      return listUsers(params as any);
    case 'list_employees':
      return listEmployees(params as any);
    case 'get_chat_info':
      return getChatInfo(params.chat_id);
    case 'list_chats':
      return listChats(params as any);
    case 'get_chat_members':
      return getChatMembers(params.chat_id);

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

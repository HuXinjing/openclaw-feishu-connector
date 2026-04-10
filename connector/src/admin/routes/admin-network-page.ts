/**
 * Admin Network ACL Dashboard Page
 * Serves the network ACL management UI at /admin/network
 */
import type { FastifyRequest, FastifyReply } from 'fastify';

const NETWORK_PAGE_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>网络 ACL 管理</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; }
    .container { max-width: 1400px; margin: 0 auto; padding: 20px; }
    h1 { color: #333; margin-bottom: 20px; }
    .card { background: white; border-radius: 8px; padding: 20px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .btn { padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; }
    .btn-primary { background: #007AFF; color: white; }
    .btn-success { background: #34C759; color: white; }
    .btn-danger { background: #FF3B30; color: white; }
    .btn-secondary { background: #8E8E93; color: white; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #eee; }
    th { background: #f9f9f9; font-weight: 600; }
    .badge { display: inline-block; padding: 3px 8px; border-radius: 4px; font-size: 12px; font-weight: 500; }
    .badge-allow { background: #E8F5E9; color: #2E7D32; }
    .badge-deny { background: #FFEBEE; color: #C62828; }
    .modal { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); align-items: center; justify-content: center; z-index: 1000; }
    .modal.active { display: flex; }
    .modal-content { background: white; padding: 24px; border-radius: 8px; width: 500px; max-height: 90vh; overflow-y: auto; }
    .modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .modal-close { background: none; border: none; font-size: 24px; cursor: pointer; }
    .form-group { margin-bottom: 16px; }
    label { display: block; margin-bottom: 4px; font-weight: 500; color: #555; }
    textarea, input[type="text"] { width: 100%; padding: 8px 12px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; font-family: monospace; }
    textarea { min-height: 100px; resize: vertical; }
    .toggle-row { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
    .toggle { position: relative; width: 44px; height: 24px; }
    .toggle input { opacity: 0; width: 0; height: 0; }
    .toggle-slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #ccc; transition: 0.3s; border-radius: 24px; }
    .toggle-slider:before { position: absolute; content: ""; height: 18px; width: 18px; left: 3px; bottom: 3px; background-color: white; transition: 0.3s; border-radius: 50%; }
    .toggle input:checked + .toggle-slider { background-color: #34C759; }
    .toggle input:checked + .toggle-slider:before { transform: translateX(20px); }
    .tabs { display: flex; border-bottom: 2px solid #eee; margin-bottom: 20px; }
    .tab { padding: 10px 20px; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -2px; color: #666; font-weight: 500; }
    .tab.active { border-bottom-color: #007AFF; color: #007AFF; }
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    .batch-actions { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
    .result-box { padding: 12px; border-radius: 4px; margin-top: 12px; font-size: 14px; }
    .result-success { background: #E8F5E9; color: #2E7D32; border: 1px solid #A5D6A7; }
    .result-error { background: #FFEBEE; color: #C62828; border: 1px solid #FFCDD2; }
    .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid #fff; border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .ip-hint { font-size: 12px; color: #888; margin-top: 4px; }
    .back-link { color: #007AFF; text-decoration: none; margin-bottom: 16px; display: inline-block; }
    .back-link:hover { text-decoration: underline; }
    .user-info { font-size: 13px; color: #888; margin-bottom: 16px; }
    .tooltip { position: relative; cursor: help; border-bottom: 1px dashed #888; }
    .tooltip:hover .tooltip-text { display: block; }
    .tooltip .tooltip-text { display: none; position: absolute; background: #333; color: white; padding: 6px 10px; border-radius: 4px; font-size: 12px; white-space: pre-wrap; z-index: 100; max-width: 300px; bottom: 125%; left: 50%; transform: translateX(-50%); font-family: monospace; }
    tr:hover { background: #fafafa; }
    .loading { color: #888; font-style: italic; }
    /* Login form */
    .login-wrap { display: flex; align-items: center; justify-content: center; min-height: 80vh; }
    .login-card { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.12); width: 360px; }
    .login-card h2 { text-align: center; margin-bottom: 24px; color: #333; }
    .login-card .form-group { margin-bottom: 16px; }
    .login-card input { width: 100%; padding: 10px 12px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; }
    .login-card .btn { width: 100%; padding: 10px; font-size: 15px; margin-top: 8px; }
    .login-error { color: #C62828; font-size: 13px; margin-top: 8px; text-align: center; display: none; }
  </style>
</head>
<body>

<!-- Login overlay -->
<div id="loginOverlay" class="login-wrap" style="display:none">
  <div class="login-card">
    <h2>网络 ACL 管理</h2>
    <div class="form-group">
      <input type="text" id="loginUsername" placeholder="用户名" autocomplete="username">
    </div>
    <div class="form-group">
      <input type="password" id="loginPassword" placeholder="密码" autocomplete="current-password">
    </div>
    <button class="btn btn-primary" onclick="doLogin()">登录</button>
    <div id="loginError" class="login-error"></div>
  </div>
</div>

<!-- Main content (hidden until logged in) -->
<div id="mainContent" class="container" style="display:none">
  <a href="/admin" class="back-link">← 返回管理后台</a>
  <h1>网络 ACL 管理</h1>

  <div class="tabs">
    <div class="tab active" onclick="switchTab('list')">网络列表</div>
    <div class="tab" onclick="switchTab('batch')">批量管理</div>
  </div>

  <!-- Tab 1: List -->
  <div id="tab-list" class="tab-content active">
    <div class="card">
      <table>
        <thead>
          <tr>
            <th>用户名</th>
            <th>部门</th>
            <th>允许 IP</th>
            <th>外网访问</th>
            <th>最后修改</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody id="profileTable">
          <tr><td colspan="6" class="loading">加载中...</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- Tab 2: Batch -->
  <div id="tab-batch" class="tab-content">
    <div class="card">
      <h2>批量操作</h2>
      <div class="batch-actions">
        <button class="btn btn-primary" id="syncBtn" onclick="syncNetwork()">全量同步</button>
        <button class="btn btn-secondary" onclick="downloadTemplate()">下载模板</button>
        <button class="btn btn-secondary" onclick="document.getElementById('importFile').click()">导入 CSV</button>
        <input type="file" id="importFile" accept=".csv" style="display:none" onchange="handleFileSelect(event)">
        <button class="btn btn-secondary" onclick="exportCsv()">导出 CSV</button>
      </div>
      <div id="batchResult"></div>
    </div>
  </div>
</div>

<!-- Edit Modal -->
<div class="modal" id="editModal">
  <div class="modal-content">
    <div class="modal-header">
      <h3>编辑网络规则</h3>
      <button class="modal-close" onclick="closeEditModal()">&times;</button>
    </div>
    <div class="user-info" id="editUserInfo"></div>
    <div class="form-group">
      <label>允许访问的 IP/CIDR（每行一个）</label>
      <textarea id="editAllowedIps" placeholder="10.0.1.0/24&#10;10.0.3.50&#10;0.0.0.0/0 = 允许所有内网"></textarea>
      <div class="ip-hint">输入 IP 地址或 CIDR，每行一个。留空则不允许任何内网访问。</div>
    </div>
    <div class="toggle-row">
      <label class="toggle">
        <input type="checkbox" id="editAllowExternal">
        <span class="toggle-slider"></span>
      </label>
      <label>允许访问外网（互联网）</label>
    </div>
    <div style="display:flex;gap:10px;justify-content:flex-end">
      <button class="btn btn-secondary" onclick="closeEditModal()">取消</button>
      <button class="btn btn-primary" id="saveBtn" onclick="saveAcl()">保存</button>
    </div>
  </div>
</div>

<script>
let currentEditOpenId = null;

function authHeaders() {
  const token = localStorage.getItem('admin_token');
  return token ? { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
}

function escHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.querySelector('.tab:nth-child(' + (name === 'list' ? 1 : 2) + ')').classList.add('active');
  document.getElementById('tab-' + name).classList.add('active');
}

async function loadProfiles() {
  const res = await fetch('/api/admin/network/profiles', { headers: authHeaders() });
  if (!res.ok) { document.getElementById('profileTable').innerHTML = '<tr><td colspan="6">加载失败</td></tr>'; return; }
  const profiles = await res.json();
  const tbody = document.getElementById('profileTable');
  if (profiles.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6">暂无数据，请先点击"全量同步"从飞书拉取用户</td></tr>';
    return;
  }
  tbody.innerHTML = profiles.map(p => {
    const ips = Array.isArray(p.allowed_ips) ? p.allowed_ips : [];
    const displayIps = ips.length > 2 ? ips.slice(0,2).join(', ') + '...' : ips.join(', ');
    const fullIps = ips.join('\\n');
    const extBadge = p.allow_external
      ? '<span class="badge badge-allow">允许</span>'
      : '<span class="badge badge-deny">禁止</span>';
    const updated = p.updated_at ? new Date(p.updated_at * 1000).toLocaleString('zh-CN') : '-';
    return '<tr>' +
      '<td>' + escHtml(p.user_name || p.open_id) + '</td>' +
      '<td>' + escHtml(p.department_name || '-') + '</td>' +
      '<td><span class="tooltip">' + escHtml(displayIps || '(无)') + '<span class="tooltip-text">' + escHtml(fullIps || '(无)') + '</span></span></td>' +
      '<td>' + extBadge + '</td>' +
      '<td>' + escHtml(updated) + '</td>' +
      '<td><button class="btn btn-primary" onclick="openEditModal(\\'' + escAttr(p.open_id) + '\\')">编辑</button></td>' +
    '</tr>';
  }).join('');
}

function escAttr(s) {
  return String(s).replace(/'/g, "\\'").replace(/"/g, '');
}

async function openEditModal(openId) {
  currentEditOpenId = openId;
  const res = await fetch('/api/admin/network/profiles/' + openId, { headers: authHeaders() });
  if (!res.ok) { alert('加载失败'); return; }
  const p = await res.json();
  document.getElementById('editUserInfo').textContent = '用户: ' + (p.user_name || openId) + ' | ' + openId;
  document.getElementById('editAllowedIps').value = (p.allowed_ips || []).join('\\n');
  document.getElementById('editAllowExternal').checked = !!p.allow_external;
  document.getElementById('editModal').classList.add('active');
}

function closeEditModal() {
  document.getElementById('editModal').classList.remove('active');
  currentEditOpenId = null;
}

async function saveAcl() {
  if (!currentEditOpenId) return;
  const btn = document.getElementById('saveBtn');
  btn.disabled = true;
  btn.textContent = '保存中...';
  const ipText = document.getElementById('editAllowedIps').value;
  const ips = ipText.split(/[\\n,]+/).map(s => s.trim()).filter(Boolean);
  const allowExternal = document.getElementById('editAllowExternal').checked;
  try {
    const res = await fetch('/api/admin/network/profiles/' + currentEditOpenId, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ allowed_ips: ips, allow_external: allowExternal }),
    });
    if (!res.ok) throw new Error('保存失败');
    closeEditModal();
    loadProfiles();
  } catch(e) {
    alert('保存失败: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '保存';
  }
}

async function syncNetwork() {
  const btn = document.getElementById('syncBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 同步中...';
  try {
    const token = localStorage.getItem('admin_token') || '';
    const res = await fetch('/api/admin/network/sync', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token },
    });
    const data = await res.json().catch(() => ({}));
    const html = '同步完成: 全部 ' + (data.synced || 0) + ' | 新增 ' + (data.created || 0) + ' | 更新 ' + (data.updated || 0) +
      (data.errors && data.errors.length ? '<br>错误: ' + data.errors.slice(0,3).join(', ') : '');
    document.getElementById('batchResult').innerHTML = '<div class="result-box result-success">' + html + '</div>';
    loadProfiles();
  } catch(e) {
    document.getElementById('batchResult').innerHTML = '<div class="result-box result-error">同步失败: ' + escHtml(e.message) + '</div>';
  } finally {
    btn.disabled = false;
    btn.textContent = '全量同步';
  }
}

function downloadTemplate() {
  const csv = 'open_id,allowed_ips,allow_external\\nou_xxx,"10.0.1.0/24;10.0.2.0/24",1\\n';
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'network-acl-template.csv'; a.click();
  URL.revokeObjectURL(url);
}

function handleFileSelect(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(ev) {
    const csv = ev.target.result;
    fetch('/api/admin/network/import', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ csv }),
    }).then(res => res.json()).then(data => {
      const html = '导入完成: ' + (data.imported || 0) + ' 条' +
        (data.errors && data.errors.length ? '<br>错误: ' + data.errors.slice(0,5).join('<br>') : '');
      document.getElementById('batchResult').innerHTML = '<div class="result-box ' + (data.errors && data.errors.length ? 'result-error' : 'result-success') + '">' + html + '</div>';
      loadProfiles();
    }).catch(err => {
      document.getElementById('batchResult').innerHTML = '<div class="result-box result-error">导入失败: ' + escHtml(err.message) + '</div>';
    });
  };
  reader.readAsText(file);
  e.target.value = '';
}

function exportCsv() {
  fetch('/api/admin/network/export', { headers: authHeaders() })
    .then(res => res.blob())
    .then(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'network-profiles.csv'; a.click();
      URL.revokeObjectURL(url);
    })
    .catch(err => { alert('导出失败: ' + err.message); });
}

// Auth check on load
function doLogin() {
  const username = document.getElementById('loginUsername').value;
  const password = document.getElementById('loginPassword').value;
  document.getElementById('loginError').textContent = '';
  fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }).then(r => {
    if (!r.ok) throw new Error('用户名或密码错误');
    return r.json();
  }).then(data => {
    localStorage.setItem('admin_token', data.token);
    document.getElementById('loginOverlay').style.display = 'none';
    document.getElementById('mainContent').style.display = 'block';
    loadProfiles();
  }).catch(err => {
    const el = document.getElementById('loginError');
    el.textContent = err.message;
    el.style.display = 'block';
  });
}

document.getElementById('loginPassword').addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});

if (localStorage.getItem('admin_token')) {
  document.getElementById('loginOverlay').style.display = 'none';
  document.getElementById('mainContent').style.display = 'block';
  loadProfiles();
} else {
  document.getElementById('loginOverlay').style.display = 'flex';
  document.getElementById('mainContent').style.display = 'none';
}
</script>
</div>
</body>
</html>`;

export function registerNetworkPageRoute(fastify: any) {
  fastify.get('/admin/network', async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.header('Content-Type', 'text/html');
    return NETWORK_PAGE_HTML;
  });
}

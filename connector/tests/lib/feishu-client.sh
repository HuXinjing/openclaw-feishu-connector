#!/usr/bin/env bash
# Feishu API client helpers for testing

FEISHU_APP_ID="${FEISHU_APP_ID:-}"
FEISHU_APP_SECRET="${FEISHU_APP_SECRET:-}"
FEISHU_API_BASE="${FEISHU_API_BASE:-https://open.feishu.cn/open-apis}"

gettenantaccesstoken() {
  curl -s -X POST "${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal" \
    -H "Content-Type: application/json" \
    -d "{\"app_id\":\"${FEISHU_APP_ID}\",\"app_secret\":\"${FEISHU_APP_SECRET}\"}" \
    | grep -o '"tenant_access_token":"[^"]*"' | cut -d'"' -f4
}

send_feishu_message() {
  local receive_id=$1 receive_id_type=${2:-open_id} content=$3
  local token
  token=$(gettenantaccesstoken)
  curl -s -X POST "${FEISHU_API_BASE}/im/v1/messages?receive_id_type=${receive_id_type}" \
    -H "Authorization: Bearer ${token}" \
    -H "Content-Type: application/json" \
    -d "{\"receive_id\":\"${receive_id}\",\"msg_type\":\"text\",\"content\":\"{\\\"text\\\":\\\"${content}\\\"}\"}"
}

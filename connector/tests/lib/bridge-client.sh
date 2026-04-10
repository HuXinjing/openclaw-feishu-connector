#!/usr/bin/env bash
# Connector API client helpers for testing

CONNECTOR_URL="${CONNECTOR_URL:-http://localhost:3000}"
CONNECTOR_TOKEN="${CONNECTOR_TOKEN:-test-token}"

bridge_get() {
  local path=$1
  curl -s -H "Authorization: Bearer ${CONNECTOR_TOKEN}" "${CONNECTOR_URL}${path}"
}

bridge_post() {
  local path=$1 data=$2
  curl -s -X POST -H "Authorization: Bearer ${CONNECTOR_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "${data}" "${CONNECTOR_URL}${path}"
}

bridge_health() {
  bridge_get "/health" | grep -q '"ok":true'
}

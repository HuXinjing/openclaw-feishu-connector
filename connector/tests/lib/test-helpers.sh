#!/usr/bin/env bash
# Test helper utilities

wait_until() {
  local max_wait=$1; local condition=$2; local cmd=$3
  local waited=0
  while (( waited < max_wait )); do
    if eval "$cmd"; then return 0; fi
    sleep 1; (( waited++ )) || true
  done
  echo "TIMEOUT after ${max_wait}s waiting for: $condition"
  return 1
}

log_pass() { echo "  ✓ $1"; }
log_fail() { echo "  ✗ $1"; }
log_info() { echo "  ℹ $1"; }

run_test() {
  local name=$1
  echo "TEST: $name"
  if eval "$name"; then
    log_pass "$name"
    return 0
  else
    log_fail "$name"
    return 1
  fi
}

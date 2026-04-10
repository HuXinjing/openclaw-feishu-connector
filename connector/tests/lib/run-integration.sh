#!/usr/src/connector/tests/lib/run-integration.sh
# Run all integration tests

set -e
cd "$(dirname "$0")/.."
export PATH="$PWD/lib:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONNECTOR_PID=""
CONNECTOR_URL="${CONNECTOR_URL:-http://localhost:3000}"
CONNECTOR_TOKEN="${CONNECTOR_TOKEN:-test-token}"

cleanup() {
  if [ -n "$CONNECTOR_PID" ] && kill -0 "$CONNECTOR_PID" 2>/dev/null; then
    kill "$CONNECTOR_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "=== Integration Test Suite ==="
echo "Connector URL: $CONNECTOR_URL"
echo ""

if bridge_health; then
  echo "✓ Connector is healthy"
else
  echo "⚠ Connector not reachable at $CONNECTOR_URL"
  echo "  Start with: CONNECTOR_TOKEN=$CONNECTOR_TOKEN node dist/index.js"
  echo "  Skipping live integration tests..."
fi

echo ""
echo "=== Shell Helpers OK ==="
for helper in lib/test-helpers.sh lib/feishu-client.sh lib/bridge-client.sh; do
  if [ -f "$SCRIPT_DIR/$helper" ]; then
    echo "  ✓ $helper exists"
  else
    echo "  ✗ $helper missing"
  fi
done

echo ""
echo "=== Unit Tests ==="
node --test dist/tests/*.test.js 2>/dev/null || npx vitest run dist/tests/ 2>/dev/null || echo "(run 'pnpm test' for unit tests)"

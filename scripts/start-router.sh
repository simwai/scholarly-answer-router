# Start the Scholarly Answer Router. Idempotent: does nothing if the port is
# already healthy.
#
# Usage:  ./scripts/start-router.sh [port]     (default 3000)

set -euo pipefail

PORT="${1:-3000}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HEALTH="http://127.0.0.1:${PORT}/healthz"

if curl -fsS --max-time 3 "$HEALTH" > /dev/null 2>&1; then
    echo "router already running on port ${PORT}"
    exit 0
fi

cd "$REPO_ROOT"

if [ ! -f dist/index.js ]; then
    npm install
    npm run build
fi

echo "starting router on port ${PORT}"
ROUTER_PORT="${PORT}" nohup node dist/index.js > /dev/null 2>&1 &

for _ in $(seq 1 40); do
    sleep 0.5
    if curl -fsS --max-time 3 "$HEALTH" > /dev/null 2>&1; then
        echo "router is up on http://127.0.0.1:${PORT}"
        exit 0
    fi
done

echo "router did not become healthy on port ${PORT}" >&2
exit 1

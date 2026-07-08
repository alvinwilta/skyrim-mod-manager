#!/usr/bin/env bash
# Launch the mod manager: start the backend if needed, then open the UI.
# Usage: modman.sh [start|stop|status]   (default: start)
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
URL="http://127.0.0.1:7788"
LOG="$DIR/webapp.log"

case "${1:-start}" in
    stop)
        if ! pkill -f "python webapp.py"; then
            echo "Not running."
            exit 0
        fi
        # Graceful shutdown takes ~3s (timeout_graceful_shutdown drains open
        # SSE streams); give it 5s before escalating to SIGKILL.
        for _ in $(seq 1 10); do
            sleep 0.5
            pgrep -f "python webapp.py" >/dev/null || { echo "Stopped."; exit 0; }
        done
        pkill -9 -f "python webapp.py" || true
        echo "Stopped (forced)."
        exit 0
        ;;
    status)
        if curl -sf -o /dev/null --max-time 2 "$URL/api/state" 2>/dev/null; then
            echo "Running at $URL"
        else
            echo "Not running."
        fi
        exit 0
        ;;
    start) ;;
    *)
        echo "Usage: $(basename "$0") [start|stop|status]" >&2
        exit 1
        ;;
esac

# Already running? Just open the UI.
if curl -sf -o /dev/null --max-time 2 "$URL/api/state" 2>/dev/null; then
    xdg-open "$URL"
    exit 0
fi

# Build the frontend once if it has never been built.
if [ ! -f "$DIR/frontend/dist/index.html" ]; then
    (cd "$DIR/frontend" && npm run build)
fi

cd "$DIR"
nohup .venv/bin/python webapp.py >>"$LOG" 2>&1 &

# Wait for the server to come up (max ~15s), then open the UI.
for _ in $(seq 1 30); do
    if curl -sf -o /dev/null --max-time 1 "$URL/api/state" 2>/dev/null; then
        xdg-open "$URL"
        exit 0
    fi
    sleep 0.5
done

echo "Server did not start — check $LOG" >&2
exit 1

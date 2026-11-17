#!/usr/bin/env bash
# Runs the desktop server from this folder's code, in the foreground with its log here, and starts it again whenever a
# .py file or .env changes (the pages in static/ are read on every request: they need no restart). Ctrl+C stops it.
#
# The service (fedora-remote, which starts at boot: README.md) uses the same port, so it is stopped while this runs
# and started again afterwards: the phone can still reach the computer when you're done.
cd "$(dirname "$0")"

if [[ ! -f .env ]]; then
    echo "There is no .env yet: cp .env.example .env (and change what you need)."
    exit 1
fi
PORT=$(grep '^DESKTOP_PORT=' .env | cut -d= -f2)

SERVICE_WAS_RUNNING=no
if systemctl --user is-active --quiet fedora-remote; then
    SERVICE_WAS_RUNNING=yes
    echo "Stopping the service (fedora-remote) while this runs."
    systemctl --user stop fedora-remote
fi

# An earlier ./run.sh still on the port. Only processes started from this folder: anything else there is left alone.
for PID in $(lsof -t -iTCP:"${PORT:-8020}" -sTCP:LISTEN); do
    if [[ "$(readlink /proc/"$PID"/cwd)" == "$PWD"* ]]; then
        echo "Closing the last run, still on port $PORT: $PID"
        kill "$PID"
        sleep 1
    fi
done

SERVER=""
finish() {
    if [[ -n "$SERVER" ]]; then
        kill "$SERVER" 2>/dev/null
        wait "$SERVER" 2>/dev/null
    fi
    if [[ "$SERVICE_WAS_RUNNING" == yes ]]; then
        systemctl --user start fedora-remote
        echo "The service (fedora-remote) runs again."
    fi
}
trap finish EXIT
trap 'exit' INT TERM

# When the files that need a restart last changed.
changed() {
    stat -c %Y ./*.py .env | sort -n | tail -1
}

while true; do
    python3 server.py &
    SERVER=$!
    STAMP=$(changed)
    while kill -0 "$SERVER" 2>/dev/null && [[ "$(changed)" == "$STAMP" ]]; do
        sleep 1
    done
    if kill -0 "$SERVER" 2>/dev/null; then
        echo "A file changed: starting again."
        kill "$SERVER"
        wait "$SERVER" 2>/dev/null
    else
        # It ended by itself (an error, say): it starts again once the code changes.
        echo "The server stopped. It starts again when a .py file or .env changes."
        while [[ "$(changed)" == "$STAMP" ]]; do
            sleep 1
        done
    fi
done

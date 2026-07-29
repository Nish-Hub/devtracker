#!/bin/bash
# Launch DevTracker from source with the agent-accessible live store.
#
# Use this during development instead of the packaged DevTracker.app:
#   - runs current source, so you never hit a stale build
#   - points DEVTRACKER_STORE at ./workspace.json, the same file the MCP server
#     (and the agent) reads and writes
#
# Double-click in Finder, or run: ./start-devtracker.command
set -e
cd "$(dirname "$0")"
export DEVTRACKER_STORE="$PWD/workspace.json"
echo "DevTracker store: $DEVTRACKER_STORE"
exec npm run start:local

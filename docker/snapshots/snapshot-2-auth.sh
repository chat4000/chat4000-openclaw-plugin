#!/bin/bash
# Snapshot 2: Run openclaw setup interactively — configures and authenticates
# You'll be prompted to answer questions and open a URL to log in.
set -e

echo "=== Snapshot 2: OpenClaw Setup & Authentication ==="

# Start from snapshot 1
docker rm -f chat4000-openclaw 2>/dev/null || true
docker run -it --name chat4000-openclaw \
  -p 18789:18789 \
  chat4000/openclaw:snapshot-1-base \
  openclaw setup

echo ""
echo "Setup complete. Taking snapshot..."
docker commit chat4000-openclaw chat4000/openclaw:snapshot-2-authed

echo "=== Snapshot 2 saved: chat4000/openclaw:snapshot-2-authed ==="
echo "Next: run snapshot-3-plugin.sh to install the Chat4000 plugin"
echo "After snapshot 3, pair with the current Matrix/registrar flow:"
echo "  Use the Chat4000 setup subcommand inside the container."

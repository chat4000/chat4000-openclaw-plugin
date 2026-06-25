#!/bin/bash
# Snapshot 3: Install Chat4000 plugin into OpenClaw.
#
# The current plugin is Matrix-backed. Do not synthesize a legacy relay config
# here: credentials must come from `openclaw chat4000 setup` so the registrar can
# mint gatewayUrl/userId/accessToken/deviceId and persist the real Matrix session.
set -e

echo "=== Snapshot 3: Install Chat4000 Plugin ==="

cd "$(dirname "$0")/.."

# Make sure OpenClaw is running from authed snapshot
if ! docker ps | grep -q chat4000-openclaw; then
  echo "Starting OpenClaw from snapshot-2..."
  docker run -d --name chat4000-openclaw \
    -p 18789:18789 \
    chat4000/openclaw:snapshot-2-authed \
    openclaw gateway --port 18789
  sleep 3
fi

# Copy plugin source into container
echo "Copying plugin into container..."
docker cp ../../ chat4000-openclaw:/tmp/chat4000-plugin

# Install the plugin
echo "Installing plugin..."
docker exec chat4000-openclaw openclaw plugins install /tmp/chat4000-plugin

# Restart to pick up plugin
echo "Restarting gateway with plugin..."
docker exec chat4000-openclaw openclaw gateway restart 2>/dev/null || true

# Snapshot
docker commit chat4000-openclaw chat4000/openclaw:snapshot-3-plugin
echo "=== Snapshot 3 saved: chat4000/openclaw:snapshot-3-plugin ==="
echo "Next: run the real Matrix pairing flow inside the container:"
echo "  Use the Chat4000 setup subcommand; do not hand-write channel credentials."

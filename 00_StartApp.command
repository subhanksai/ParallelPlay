#!/bin/bash

# CHANGE THESE:
MASTER_IP="192.168.127.177"         # Local machine (you)
SLAVE_IPS=("192.168.127.141")       # Add as needed - using array format
SSH_USER="playout"      # e.g., "admin" or "john"

# Both master and slave use the same path now (without space)
APP_DIR="/Volumes/DATA/02_ParallelPlay"
MASTER_NPM_COMMAND="cd \"$APP_DIR\" && npm start"
SLAVE_NPM_COMMAND="cd \"$APP_DIR\" && npm start"
VLC_COMMAND="open -a VLC"

# Kill any existing processes on port 3000
echo "🔧 Checking for existing processes on port 3000..."
lsof -ti:3000 | xargs kill -9 2>/dev/null || true

echo "✅ Starting on master..."
echo "🎬 Starting VLC..."
eval "$VLC_COMMAND" &
echo "🚀 Starting npm app..."
eval "$MASTER_NPM_COMMAND" &

for IP in "${SLAVE_IPS[@]}"; do
  echo "🚀 Starting on slave: $IP..."
  echo "  🎬 Starting VLC..."
  ssh "$SSH_USER@$IP" "$VLC_COMMAND" &
  echo "  ⚠️  Skipping npm app (Node.js not installed on slave)"
done

wait
echo "🎉 All systems started successfully."

#!/bin/bash

# ====================
# CONFIGURATION
# ====================

MASTER_IP="192.168.127.177"           # Your local machine
SLAVE_IPS=("192.168.127.141")         # Add more IPs as needed
SSH_USER="playout"                      # Remote user on slave machine

APP_DIR="/Volumes/DATA/02_ParallelPlay"

# Commands to run
MASTER_NPM_COMMAND="cd \"$APP_DIR\" && npm start"
MASTER_VLC_COMMAND="open -a VLC"

# Assuming Linux on the slave (use `vlc` or `cvlc`)
SLAVE_VLC_COMMAND="cvlc --fullscreen"   # Use 'vlc' instead if you want GUI

# ====================
# START MASTER
# ====================

echo "🔧 Checking for existing processes on port 3000..."
lsof -ti:3000 | xargs kill -9 2>/dev/null || true

echo "✅ Starting on master..."
echo "🎬 Starting VLC..."
eval "$MASTER_VLC_COMMAND" &

echo "🚀 Starting npm app..."
eval "$MASTER_NPM_COMMAND" &

# ====================
# START SLAVES
# ====================

for IP in "${SLAVE_IPS[@]}"; do
  echo "🚀 Starting on slave: $IP..."
  
  echo "  🎬 Starting VLC..."
  ssh "$SSH_USER@$IP" "$SLAVE_VLC_COMMAND" &
  
  echo "  ⚠️  Skipping npm app (Node.js not installed on slave)"
done

# ====================
# WAIT FOR ALL BACKGROUND TASKS
# ====================
wait
echo "🎉 All systems started successfully."

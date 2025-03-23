#!/bin/bash

# Script to stop a stream on a specific screen
# Usage: ./stopstream.sh <screen_number>

if [ -z "$1" ]; then
  echo "Usage: ./stopstream.sh <screen_number>"
  echo "Example: ./stopstream.sh 1"
  exit 1
fi

SCREEN=$1

# Execute the stop command
echo "Stopping stream on screen $SCREEN..."
node ./dist/cli/livelink.js stream stop $SCREEN 
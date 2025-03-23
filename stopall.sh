#!/bin/bash

# Script to stop all streams and the LiveLink server
# Usage: ./stopall.sh

echo "Stopping all streams and the LiveLink server..."
node ./dist/cli/livelink.js server stop-all 
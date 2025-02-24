#!/bin/bash

# Function to make API calls
make_api_call() {
    local endpoint=$1
    local data=$2
    curl -s -X POST "http://localhost:3001/api/$endpoint" \
        -H "Content-Type: application/json" \
        -d "$data"
}

# Handle command line arguments
case "$1" in
    "autostart-1")
        make_api_call "streams/autostart" '{"screen": 1}'
        ;;
    "autostart-2")
        make_api_call "streams/autostart" '{"screen": 2}'
        ;;
    "close-all")
        make_api_call "streams/close-all" '{}'
        ;;
    *)
        echo "Unknown command: $1"
        exit 1
        ;;
esac 
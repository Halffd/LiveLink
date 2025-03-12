#!/bin/bash

# This script positions MPV windows on the correct monitors
# It should be run after MPV windows are opened

# Wait for windows to initialize
sleep 2

# Find all MPV windows
mpv_windows=$(xdotool search --class mpv)

# Loop through each window
for window_id in $mpv_windows; do
  # Get window title
  title=$(xdotool getwindowname $window_id)
  
  # Position based on title
  if [[ "$title" == *"LiveLink-1"* ]]; then
    # Screen 1 - Position on primary monitor
    xdotool windowmove $window_id 1366 0
    xdotool windowsize $window_id 1920 1080
    xdotool windowmaximize $window_id
    echo "Positioned window $window_id (LiveLink-1) on primary monitor"
  elif [[ "$title" == *"LiveLink-2"* ]]; then
    # Screen 2 - Position on secondary monitor
    xdotool windowmove $window_id 0 312
    xdotool windowsize $window_id 1366 768
    xdotool windowmaximize $window_id
    echo "Positioned window $window_id (LiveLink-2) on secondary monitor"
  fi
done

exit 0 
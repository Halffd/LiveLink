#!/bin/bash

# LiveLink Setup Script

echo "LiveLink Setup Script"
echo "====================="
echo ""

# Check if .env file exists
if [ -f .env ]; then
  echo "Found existing .env file."
  read -p "Do you want to update it? (y/n): " update_env
  if [[ $update_env != "y" ]]; then
    echo "Skipping .env update."
  else
    update_env="y"
  fi
else
  echo "No .env file found. Creating one..."
  touch .env
  update_env="y"
fi

# Update .env file if needed
if [[ $update_env == "y" ]]; then
  echo ""
  echo "Setting up API keys..."
  echo ""
  
  # Get Holodex API key
  read -p "Enter your Holodex API key (get from https://holodex.net/api): " holodex_key
  if [[ -n $holodex_key ]]; then
    grep -v "HOLODEX_API_KEY" .env > .env.tmp
    echo "HOLODEX_API_KEY=$holodex_key" >> .env.tmp
    mv .env.tmp .env
    echo "Holodex API key set."
  else
    echo "Holodex API key not set. Streams from Holodex will not be available."
  fi
  
  # Get Twitch API keys
  read -p "Enter your Twitch Client ID (get from https://dev.twitch.tv/console/apps): " twitch_id
  read -p "Enter your Twitch Client Secret: " twitch_secret
  
  if [[ -n $twitch_id && -n $twitch_secret ]]; then
    grep -v "TWITCH_CLIENT_ID" .env > .env.tmp
    echo "TWITCH_CLIENT_ID=$twitch_id" >> .env.tmp
    mv .env.tmp .env
    
    grep -v "TWITCH_CLIENT_SECRET" .env > .env.tmp
    echo "TWITCH_CLIENT_SECRET=$twitch_secret" >> .env.tmp
    mv .env.tmp .env
    
    echo "Twitch API keys set."
  else
    echo "Twitch API keys not set. Streams from Twitch will not be available."
  fi
fi

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
  echo ""
  echo "Installing dependencies..."
  npm install
else
  echo ""
  echo "Dependencies already installed."
fi

# Build the server
echo ""
echo "Building the server..."
npm run build:server

echo ""
echo "Setup complete!"
echo ""
echo "To start the server, run: npm start"
echo "To start the development server, run: npm run dev"
echo ""
echo "If you encounter any issues with streams not loading, check the logs for error messages."
echo "Make sure your API keys are correctly set in the .env file."
echo "" 
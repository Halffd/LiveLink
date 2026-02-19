# Setting Stream Titles via IPC

The application now supports setting stream titles via IPC after the player has started, which avoids shell injection issues that can occur when passing complex Unicode titles as command-line arguments.

## How it Works

1. When a stream starts, if a title is provided in the options, the system will:
   - Wait for the player process to be ready
   - Send an IPC command to set the title property: `['set_property', 'title', 'sanitized-title']`
   - The title is sanitized to prevent shell injection

2. You can also update the title of a running stream dynamically using the new API

## Usage Examples

### Setting Title When Starting a Stream
```typescript
// Title will be automatically set when the stream starts
const streamOptions = {
  url: 'https://twitch.tv/example',
  screen: 1,
  title: 'Example Stream Title',
  viewerCount: 1234,
  startTime: Date.now()
};

await streamManager.startStream(streamOptions);
```

### Updating Title of a Running Stream
```typescript
// Update the title of a stream that's already running
streamManager.updateStreamTitle(1, 'New Title for Screen 1');

// Or with a more complex title
streamManager.updateStreamTitle(2, 'Updated Title with Special Characters: こんにちは世界!');
```

## Security Features

- All titles are sanitized to prevent shell injection
- Potentially problematic characters are replaced: backslashes `\`, quotes `"`, newlines, tabs, etc.
- Title length is limited to 100 characters to prevent issues
- Uses MPV's `set_property` command via IPC instead of command-line arguments

## Benefits

- **Security**: Prevents shell injection attacks from malicious or complex titles
- **Flexibility**: Allows dynamic title updates for running streams
- **Reliability**: Uses proper IPC communication instead of command-line arguments
- **Compatibility**: Works with Unicode and special characters safely
# LiveLink Architecture

## Core Components
- Server (Node.js/Koa)
  - /src/server/
    - api.ts - Main server entry point
    - routes/ - API routes
    - services/ - Core services
    - db/ - Database interactions

## Key Services
1. PlayerService
   - Manages video player instances
   - Handles IPC communication with MPV
   - Manages stream lifecycle

2. StreamManager
   - Orchestrates multiple streams
   - Manages screen configurations
   - Handles queue management

3. QueueService
   - Manages stream queues per screen
   - Tracks watched streams
   - Handles queue updates

## Communication Flow
1. API Request → Koa Router → StreamManager → PlayerService
2. PlayerService ↔ MPV Player (via IPC)
3. StreamManager ↔ QueueService (via EventEmitter)

# Naming Conventions

## Files
- Services: `camelCase.ts` (e.g., playerService.ts)
- Types: `camelCase.ts` (e.g., streamTypes.ts)
- Components: `PascalCase.svelte`

## Variables/Functions
- Services: camelCase
- Event handlers: handleEventName
- Callbacks: onEventName
- Private methods: _methodName
- Constants: UPPER_SNAKE_CASE

## Types/Interfaces
- Base types: PascalCase (e.g., StreamOptions)
- Service interfaces: IPascalCase (e.g., IPlayerService)
- Event types: EventPascalCase (e.g., StreamEvent)

# Dependencies

## Core Dependencies
- koa - Web framework
- winston - Logging
- node-fetch - HTTP client
- @twurple - Twitch API client
- holodex.js - Holodex API client

## Import Order
1. Node.js built-ins
2. External packages
3. Project types
4. Project services
5. Project utilities

## Example
```typescript
import { EventEmitter } from 'events';  // Node.js built-in
import Koa from 'koa';                  // External package
import type { StreamOptions } from '../types/stream';  // Project types
import { logger } from './services/logger';  // Project services
import { formatTime } from './utils';        // Project utilities
```
```

4. **Design Patterns**
```markdown
# Design Patterns

## Service Pattern
- Services are singletons
- Services extend EventEmitter for pub/sub
- Services handle one specific domain

## Event-Driven Architecture
- Use EventEmitter for cross-service communication
- Define strict event types
- Document event payloads

## Error Handling
- Use typed errors
- Log errors with context
- Propagate errors to appropriate handlers

## Example Service Pattern
```typescript
export class ServiceName extends EventEmitter {
  private static instance: ServiceName;

  private constructor() {
    super();
    // initialization
  }

  public static getInstance(): ServiceName {
    if (!ServiceName.instance) {
      ServiceName.instance = new ServiceName();
    }
    return ServiceName.instance;
  }
}
```
```

5. **API Structure**
```markdown
# API Structure

## RESTful Endpoints
Base URL: /api

### Streams
- GET /streams/active - List active streams
- POST /streams/start - Start a stream
- DELETE /streams/:screen - Stop stream on screen
- GET /streams/queue/:screen - Get queue for screen

### Screens
- POST /screens/:screen/enable - Enable screen
- POST /screens/:screen/disable - Disable screen
- GET /screens/:screen - Get screen info

### Player
- POST /player/command/:screen - Send command to player
- POST /player/volume/:target - Set volume
- POST /player/seek/:target - Seek in stream

## Response Format
```typescript
interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}
```
```

6. **Configuration**
```markdown
# Configuration

## Environment Variables
- HOLODEX_API_KEY - Holodex API key
- TWITCH_CLIENT_ID - Twitch client ID
- TWITCH_CLIENT_SECRET - Twitch client secret
- PORT - Server port (default: 3001)

## Config Files
- config/
  - player.json - Player settings
  - streams.json - Stream configurations
  - favorites.json - Favorite channels
  - mpv.json - MPV player settings
  - streamlink.json - Streamlink settings

## Example Config
```json
{
  "player": {
    "preferStreamlink": false,
    "defaultQuality": "best",
    "defaultVolume": 0,
    "maxStreams": 2,
    "screens": []
  }
}
```
```

7. **Tiling Window Manager & Wayland Support**
```markdown
# Tiling Window Manager & Wayland Support

LiveLink automatically detects your display server (X11/Wayland) and window manager type to optimize MPV player behavior.

## Automatic Detection

The PlayerService detects:
- **Display Server**: X11 or Wayland
- **Window Manager Type**: Tiling (i3, sway, hyprland, etc.) or Floating
- **GPU Context**: Automatically sets `--gpu-api` and `--gpu-context` based on display server

## Behavior on Different WMs

### Tiling Window Managers (i3, sway, hyprland, bspwm, etc.)

On tiling WMs, LiveLink:
- Uses `--class=livelink-screen-{N}` instead of geometry positioning
- Sets `--title=LiveLink-Screen-{N}` for window identification
- Applies window size hints (may be respected by some WMs)
- **Does not use** `--geometry=+x+y` positioning (ignored by tiling WMs)

#### i3/i3-gaps Configuration

Add to your `~/.config/i3/config`:

```bash
# Float LiveLink windows
for_window [class="livelink-screen-*"] floating enable

# Set specific geometry for each screen
for_window [class="livelink-screen-1"] resize set 1280 720, move position 0 0
for_window [class="livelink-screen-2"] resize set 1280 720, move position 1280 0
```

#### Sway Configuration

Add to your `~/.config/sway/config`:

```bash
# Float LiveLink windows
for_window [app_id="livelink-screen-*"] floating enable

# Set specific geometry for each screen
for_window [app_id="livelink-screen-1"] resize set 1280 720, move position 0 0
for_window [app_id="livelink-screen-2"] resize set 1280 720, move position 1280 0
```

#### Hyprland Configuration (v0.45+)

Add to your `~/.config/hypr/hyprland.conf`:

```bash
# LiveLink Auto-Generated Configuration
# Float and position LiveLink windows

# Screen 1
windowrule {
  name = livelink-screen-1
  match:class = livelink-screen-1
  float = on
  size = 1920 1080
  move = 1366 0
}

# Screen 2
windowrule {
  name = livelink-screen-2
  match:class = livelink-screen-2
  float = on
  size = 1366 768
  move = 0 312
}

# Or use anonymous rule syntax for all screens:
# windowrule = float on, match:class livelink-screen-.*
# windowrule = size 1280 720, match:class livelink-screen-.*
# windowrule = move 0 0, match:class livelink-screen-1
# windowrule = move 1280 0, match:class livelink-screen-2
```

**Note:** For Hyprland versions < 0.45, use the legacy `windowrulev2` syntax:

```bash
windowrulev2 = float, class:livelink-screen-1
windowrulev2 = size 1920 1080, class:livelink-screen-1
windowrulev2 = move 1366 0, class:livelink-screen-1
```

**Tips:**
- Use `hyprctl clients` to see window class/title information
- Rules are evaluated top to bottom
- Named rules take precedence over anonymous rules
- Use `match:class` for RegEx matching

#### BSPWM Configuration

Add to your `~/.config/bspwm/bspwmrc`:

```bash
# Float LiveLink windows
bspc rule -a livelink-screen-* state=floating

# Set specific geometry for each screen
bspc rule -a livelink-screen-1 state=floating rectangle=1280x720+0+0
bspc rule -a livelink-screen-2 state=floating rectangle=1280x720+1280+0
```

#### Xmonad Configuration

Add to your `~/.xmonad/xmonad.hs`:

```haskell
-- Float LiveLink windows
manageHook = composeAll
    [ className =? "livelink-screen-1" --> doFloat (W.RationalRect l t w h)
    , className =? "livelink-screen-2" --> doFloat (W.RationalRect l t w h)
    ]
  where
    l = 0        -- left (0 = 0% from left)
    t = 0        -- top (0 = 0% from top)
    w = 1280     -- width in pixels
    h = 720      -- height in pixels
```

#### AwesomeWM Configuration

Add to your `~/.config/awesome/rc.lua`:

```lua
-- Float LiveLink windows and set geometry
awful.rules.rules = {
  {
    rule = { class = "livelink-screen-.*" },
    properties = { floating = true },
    callback = function(c)
      if c.class == "livelink-screen-1" then
        c:geometry({ x = 0, y = 0, width = 1280, height = 720 })
      elseif c.class == "livelink-screen-2" then
        c:geometry({ x = 1280, y = 0, width = 1280, height = 720 })
      end
    end
  }
}
```

#### Qtile Configuration

Add to your `~/.config/qtile/config.py`:

```python
from libqtile import hook
from libqtile.backend.x11 import window

@hook.subscribe.client_new
def float_livelink(client):
    if "livelink-screen-" in client.name or "livelink-screen-" in client.get_wm_class():
        client.floating = True
        if "livelink-screen-1" in client.name:
            client.cmd_set_position(0, 0)
            client.cmd_set_size(1280, 720)
        elif "livelink-screen-2" in client.name:
            client.cmd_set_position(1280, 0)
            client.cmd_set_size(1280, 720)
```

#### DWM Configuration

Add to your `config.h` and recompile:

```c
static const Rule rules[] = {
    // class                      instance  title  tag mask  isfloating  monitor
    { "livelink-screen-1",        NULL,     NULL,  0,        True,       -1 },
    { "livelink-screen-2",        NULL,     NULL,  0,        True,       -1 },
};

// Then use xdotool or similar to position windows after they appear
```

#### Openbox Configuration

Add to your `~/.config/openbox/rc.xml`:

```xml
<applications>
  <application class="livelink-screen-1">
    <position force="yes">
      <x>0</x>
      <y>0</y>
    </position>
    <size>
      <width>1280</width>
      <height>720</height>
    </size>
  </application>
  <application class="livelink-screen-2">
    <position force="yes">
      <x>1280</x>
      <y>0</y>
    </position>
    <size>
      <width>1280</width>
      <height>720</height>
    </size>
  </application>
</applications>
```

#### KWin (KDE) Script

Create a KWin script at `~/.local/share/kwin/scripts/livelink-float/metadata.desktop`:

```ini
[Desktop Entry]
Name=LiveLink Float
Comment=Float LiveLink windows
Type=Service
X-KDE-ServiceTypes=KWin/Script
X-KDE-PluginInfo-Author=YourName
X-KDE-PluginInfo-Name=livelink-float
X-KDE-PluginInfo-Version=1.0
X-KDE-PluginInfo-EnabledByDefault=true
```

And `~/.local/share/kwin/scripts/livelink-float/code/main.js`:

```javascript
function init() {
    workspace.clientAdded.connect(function(client) {
        if (client.resourceClass.includes("livelink-screen-")) {
            client.keepAbove = true;
            // Note: KWin doesn't support geometry setting via script
            // Use window rules instead
        }
    });
}
```

Or use KDE Window Rules (System Settings → Window Management → Window Rules):
- Add rule for class `livelink-screen-*`
- Set "Size & Position" → "Force" → specify geometry

### Auto-Generate WM Configuration

Instead of manually writing WM rules, use the included config generator:

```bash
# Using npm scripts (recommended)
npm run wm:config hyprland           # Generate for specific WM
npm run wm:config:all                # Generate for all WMs
npm run wm:config i3 -- --dry-run    # Preview without saving

# Or run the script directly
node scripts/generate-wm-config.js hyprland
node scripts/generate-wm-config.js --all
```

The script reads your `config/player.json` and generates appropriate WM rules.
Generated configs are saved to `generated-wm-configs/` directory.

**Supported Window Managers:**
- i3 / i3-gaps
- Sway
- Hyprland (v0.45+ with `windowrule`, older versions use `windowrulev2`)
- BSPWM
- Xmonad
- AwesomeWM
- Qtile
- Openbox
- KWin (KDE)
- Wayfire

See `generated-wm-configs/README.md` for detailed usage instructions.

### Wayland (Non-Tiling Compositors)
- Uses `--gpu-api=wayland --gpu-context=wayland`
- Applies full geometry positioning
- Uses `--class=livelink-screen-{N}` for identification

### X11 (Traditional/Compositing WMs)

On X11 with compositing WMs (GNOME, KDE, XFCE, etc.):
- Uses `--gpu-api=x11 --gpu-context=x11`
- Applies full geometry positioning with `--geometry=WxH+x+y`

## Configuration File Structure

LiveLink reads configuration from JSON files in the `config/` directory:

### `config/mpv.json` - MPV Player Configuration

This file contains global MPV player settings. All MPV options can be specified here.

```json
{
  "vo": "gpu",
  "hwdec": "auto-copy-safe",
  "priority": "high",
  "cache": true,
  "cache-secs": 60,
  "demuxer-max-bytes": "800M",
  "ytdl-format": "bestvideo[height<=?1080]+bestaudio/best"
}
```

**Important:** `gpu-context` is set automatically based on your display server:
- On **Wayland**: Always uses `--gpu-context=wayland`
- On **X11**: Always uses `--gpu-context=x11`
- If `vo=gpu` is set with X11 context on Wayland, it's automatically changed to `vo=gpu-next`
- Note: `gpu-api` option is not used for better MPV version compatibility

### `config/streamlink.json` - Streamlink Configuration

This file contains Streamlink settings and can also override MPV settings when using streamlink.

```json
{
  "path": "streamlink",
  "options": {
    "twitch-disable-hosting": true,
    "twitch-disable-ads": true,
    "stream-timeout": 60,
    "hls-live-edge": 3
  },
  "http_header": {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "Accept-Language": "en-US,en;q=0.9"
  },
  "mpv": {
    "vo": "gpu",
    "hwdec": "auto"
  },
  "args": ["--low-latency"]
}
```

**Structure:**
- `path`: Path to streamlink executable
- `options`: Streamlink configuration options (key-value pairs)
- `http_header`: HTTP headers to send with requests
- `mpv`: MPV-specific settings when launched by streamlink (merged with mpv.json)
- `args`: Additional command-line arguments for streamlink

### Config Priority

When both `mpv.json` and `streamlink.json` have MPV settings:
1. `mpv.json` settings take precedence (global config)
2. `streamlink.json mpv` settings are applied only if not in mpv.json
3. Display server overrides (`gpu-api`, `gpu-context`) always take final precedence

## Manual Configuration

If automatic detection doesn't work, you can override settings in `config/mpv.json`:

```json
{
  "gpu-api": "wayland",
  "gpu-context": "wayland",
  "vo": "gpu",
  "hwdec": "auto-copy-safe"
}
```

Or for X11:

```json
{
  "gpu-api": "x11",
  "gpu-context": "x11",
  "vo": "gpu",
  "hwdec": "auto-copy-safe"
}
```

## Troubleshooting

### Windows not appearing in correct position

1. **Tiling WM**: Configure your WM rules as shown above
2. **Wayland**: Some compositors may ignore positioning - check compositor settings
3. **X11**: Ensure your WM supports geometry hints

### MPV crashes on Wayland

1. Ensure you have `mpv` built with Wayland support
2. Check that `WAYLAND_DISPLAY` environment variable is set
3. Try setting `SDL_VIDEODRIVER=wayland` in your environment
4. If using `vo=gpu` with X11 context in mpv.json, it will be automatically changed to `vo=gpu-next`

### Windows not floating on tiling WM

1. Verify WM class with `xprop` (X11) or `wayland-info` (Wayland)
2. Check your WM configuration syntax
3. Reload WM configuration after changes

### Screen tearing on Wayland

1. Enable VSync in your compositor settings
2. For Hyprland: `general:gaps_in = 0` can help
3. Consider using `vo=gpu` with `gpu-context=wayland`

### MPV settings from config not being applied

1. Check that mpv.json is in the `config/` directory
2. Verify JSON syntax is valid (use a JSON validator)
3. Note that `gpu-api` and `gpu-context` are always overridden for compatibility
4. Check logs for "MPV args" to see what arguments are actually being used

### Streamlink settings not being applied

1. Ensure streamlink.json is in the `config/` directory
2. Check that options are in the correct format (boolean vs string)
3. HTTP headers should be in the `http_header` object
4. Additional CLI args go in the `args` array

### Config Priority Issues

If settings from mpv.json and streamlink.json conflict:
- mpv.json takes precedence for global MPV settings
- streamlink.json mpv settings only apply when not in mpv.json
- Display server detection always overrides gpu-api/gpu-context

## Environment Variables

LiveLink sets these automatically based on detection:

- `DISPLAY` - X11 display (X11 only)
- `XAUTHORITY` - X11 authentication (X11 only)
- `WAYLAND_DISPLAY` - Wayland display (Wayland only)
- `DBUS_SESSION_BUS_ADDRESS` - D-Bus session (both)
- `SDL_VIDEODRIVER` - `x11` or `wayland` based on detection

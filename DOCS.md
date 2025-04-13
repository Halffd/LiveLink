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

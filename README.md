# LiveLink

LiveLink is a powerful streaming management application that allows you to watch and manage multiple streams simultaneously. It supports Twitch, YouTube, and other streaming platforms through a unified interface.

## Features

- **Multi-Stream Support**: Watch multiple streams simultaneously
- **Stream Queue**: Queue up streams to watch later
- **API Explorer**: Test and explore the available API endpoints
- **Configuration Management**: Easily configure player settings and screen layouts
- **Responsive UI**: Modern Bootstrap-based interface that works on various devices

## Getting Started

### Prerequisites

- Node.js (v16 or higher)
- npm (v7 or higher)

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/LiveLink.git
   cd LiveLink
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure your environment:
   - Copy `.env.example` to `.env` and fill in your API keys
   - Update configuration files in the `config` directory as needed

4. Start the development server:
   ```bash
   npm run dev:all
   ```

5. Open your browser and navigate to:
   ```
   http://localhost:5173
   ```

### Production Deployment

To build for production:

```bash
npm run build:all
npm run start:all
```

## Usage

### Stream Management

1. Navigate to the Streams page
2. Enter a stream URL and select a screen
3. Click "Add Stream" to start watching
4. Use the player controls to adjust volume, seek, or pause

### Configuration

1. Navigate to the Settings page
2. Adjust global player settings or screen-specific settings
3. Click "Save" to apply changes

### API Explorer

1. Navigate to the API Explorer tab on the home page
2. Browse available endpoints by category
3. Click "Test" on GET endpoints to see responses

## Development

### Project Structure

- `/src`: Source code
  - `/components`: Reusable UI components
  - `/lib`: Utility functions and API client
  - `/routes`: SvelteKit routes
  - `/types`: TypeScript type definitions
- `/config`: Configuration files
- `/dist`: Build output

### Available Scripts

- `npm run dev`: Start the frontend development server
- `npm run dev:server`: Start the backend server
- `npm run dev:all`: Start both frontend and backend in development mode
- `npm run build`: Build the frontend
- `npm run build:server`: Build the backend
- `npm run build:all`: Build both frontend and backend
- `npm run start`: Start the production server
- `npm run start:all`: Start both frontend and backend in production mode

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Acknowledgments

- Built with [SvelteKit](https://kit.svelte.dev/)
- UI powered by [Bootstrap](https://getbootstrap.com/)
- Icons from [Bootstrap Icons](https://icons.getbootstrap.com/)

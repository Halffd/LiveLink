import { WebSocket, WebSocketServer } from 'ws';
import { Server } from 'http';
import type { Stream, StreamSource } from '../types/stream.js';
import { StreamManager } from './stream-manager.js';

export class WebSocketService {
  private wss: WebSocketServer;
  private clients: Set<WebSocket> = new Set();

  constructor(server: Server, private streamManager: StreamManager) {
    this.wss = new WebSocketServer({ server });
    this.setupWebSocketServer();
    this.setupStreamManagerListeners();
  }

  private setupWebSocketServer() {
    this.wss.on('connection', (ws: WebSocket) => {
      this.clients.add(ws);

      ws.addEventListener('close', () => {
        this.clients.delete(ws);
      });

      // Send initial state
      this.sendToClient(ws, {
        type: 'init',
        data: {
          streams: this.streamManager.getActiveStreams(),
          queues: this.streamManager.getQueueForScreen,
          screens: this.streamManager.getScreenConfigs()
        }
      });
    });
  }

  private setupStreamManagerListeners() {
    // Listen for stream updates
    this.streamManager.on('streamUpdate', (stream: Stream) => {
      this.broadcast({
        type: 'streamUpdate',
        data: { stream }
      });
    });

    // Listen for queue updates
    this.streamManager.on('queueUpdate', (screen: number, queue: StreamSource[]) => {
      this.broadcast({
        type: 'queueUpdate',
        data: { screen, queue }
      });
    });

    // Listen for screen config updates
    this.streamManager.on('screenUpdate', (screen: number, config: any) => {
      this.broadcast({
        type: 'screenUpdate',
        data: { screen, config }
      });
    });

    // Listen for player settings updates
    this.streamManager.on('settingsUpdate', (settings: any) => {
      this.broadcast({
        type: 'settingsUpdate',
        data: { settings }
      });
    });

    // Listen for errors
    this.streamManager.on('error', (error: Error) => {
      this.broadcast({
        type: 'error',
        data: { message: error.message }
      });
    });
  }

  private broadcast(message: any) {
    const data = JSON.stringify(message);
    this.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    });
  }

  private sendToClient(client: WebSocket, message: any) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  }
} 
import Koa from 'koa';
import Router from 'koa-router';
import bodyParser from 'koa-bodyparser';
import cors from '@koa/cors';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';

const app = new Koa();
const router = new Router();
const streamManager = new EventEmitter();

let streams = {}; // Store streams and their MPV instances

// Middleware
app.use(cors()); // Enable CORS
app.use(bodyParser());

// Start a new MPV instance for a stream
const startMpvInstance = (url, quality) => {
    const mpv = spawn('mpv', [url, '--fs', '--quality=' + quality]);
    mpv.stdout.on('data', (data) => {
        console.log(`MPV: ${data}`);
    });
    mpv.stderr.on('data', (data) => {
        console.error(`MPV Error: ${data}`);
    });
    return mpv;
};

// API to add a stream
router.post('/api/streams', (ctx) => {
    const { url, quality } = ctx.request.body;
    if (!url || !quality) {
        ctx.status = 400;
        ctx.body = { error: 'URL and quality are required' };
        return;
    }
    const mpvInstance = startMpvInstance(url, quality);
    streams[url] = mpvInstance;
    ctx.body = { message: 'Stream started', url };
});

// API to get the current streams
router.get('/api/streams', (ctx) => {
    ctx.body = streams;
});

// API to stop a stream
router.delete('/api/streams/:url', (ctx) => {
    const { url } = ctx.params;
    if (streams[url]) {
        streams[url].kill();
        delete streams[url];
        ctx.body = { message: 'Stream stopped', url };
    } else {
        ctx.status = 404;
        ctx.body = { error: 'Stream not found' };
    }
});

app.use(router.routes()).use(router.allowedMethods());

const PORT = 3001; // Make sure this is different from SvelteKit's port
app.listen(PORT, () => {
    console.log(`Koa server running on http://localhost:${PORT}`);
}); 
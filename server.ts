// server.mjs
import Koa from 'koa';
import Router from 'koa-router';
import bodyParser from 'koa-bodyparser';
import cors from '@koa/cors';

const app = new Koa();
const router = new Router();

// Middleware
app.use(cors()); // Enable CORS
app.use(bodyParser());

// Sample route
router.get('/api', (ctx) => {
  ctx.body = 'Hello from Koa!';
});

app.use(router.routes()).use(router.allowedMethods());

const PORT = 3001; // Make sure this is different from SvelteKit's port
app.listen(PORT, () => {
  console.log(`Koa server running on http://localhost:${PORT}`);
});
import Router from 'koa-router';
import send from 'koa-send';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = new Router();

// Serve static files from the build directory
router.get('/assets/*', async (ctx) => {
  await send(ctx, ctx.path, { 
    root: path.resolve(__dirname, '../../build') 
  });
});

// Handle SvelteKit app routes
router.get(['/', '/manager'], async (ctx) => {
  await send(ctx, 'index.html', { 
    root: path.resolve(__dirname, '../../build') 
  });
});

export default router; 
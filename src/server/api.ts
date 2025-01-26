import Koa from 'koa';
import bodyParser from 'koa-bodyparser';
import cors from '@koa/cors';
import serve from 'koa-static';
import path from 'path';
import { fileURLToPath } from 'url';
import apiRouter from './routes/api';
import appRouter from './router';
import { db } from './db/database';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = new Koa();

// Initialize database
await db.initialize();

// Middleware
app.use(cors());
app.use(bodyParser());

// Serve static files
app.use(serve(path.resolve(__dirname, '../../build')));

// Use routers
app.use(apiRouter.routes());
app.use(apiRouter.allowedMethods());
app.use(appRouter.routes());
app.use(appRouter.allowedMethods());

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
}); 
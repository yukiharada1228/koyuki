import { Hono } from 'hono';
import { runScenario } from './scenario.js';
const app = new Hono();
app.get('/check', async c => c.json(await runScenario()));
export default app;

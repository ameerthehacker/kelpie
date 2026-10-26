import { Hono, type Context } from 'hono';
import { ConnectError, type ConnectionStatus, type Connections } from './connector.js';

/**
 * `/api/connections`: the services Kelpie is connected to. Each answer is a `ConnectionStatus`
 * (or a list of them), which never carries a secret.
 *
 *   GET    /                 every connector's status (checked again when it is a few minutes old)
 *   POST   /:id  {token}     connects with a token, once the service accepts it
 *   POST   /:id/check        checks again now
 *   DELETE /:id              forgets the stored token
 */
export function connectionRoutes(connections: Connections): Hono {
  const app = new Hono();

  app.get('/', async (c) => c.json(await connections.list()));

  app.post('/:id/check', (c) => answer(c, connections, (id) => connections.check(id)));

  app.post('/:id', async (c) => {
    const body = await c.req.json<{ token?: unknown }>().catch(() => ({}) as { token?: unknown });
    return answer(c, connections, (id) => connections.connect(id, { token: body.token }));
  });

  app.delete('/:id', (c) => answer(c, connections, (id) => connections.disconnect(id)));

  return app;
}

async function answer(c: Context, connections: Connections, fn: (id: string) => Promise<ConnectionStatus>): Promise<Response> {
  const id = c.req.param('id')!;
  if (!connections.get(id)) return c.json({ error: `no connector "${id}"` }, 404);
  try {
    return c.json(await fn(id));
  } catch (err) {
    if (err instanceof ConnectError) return c.json({ error: err.message }, 400);
    throw err;
  }
}

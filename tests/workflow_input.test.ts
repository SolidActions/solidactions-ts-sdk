import { SolidActions } from '../src';
import { createServer, Server } from 'http';

describe('SolidActions.getInput', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.WORKFLOW_INPUT;
    delete process.env.WORKFLOW_INPUT_URL;
    delete process.env.SOLIDACTIONS_API_KEY;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns parsed JSON from WORKFLOW_INPUT', () => {
    process.env.WORKFLOW_INPUT = JSON.stringify({ key: 'value' });
    expect(SolidActions.getInput()).toEqual({ key: 'value' });
  });

  it('returns empty object when WORKFLOW_INPUT is missing', () => {
    expect(SolidActions.getInput()).toEqual({});
  });

  it('returns empty object when WORKFLOW_INPUT is invalid JSON', () => {
    process.env.WORKFLOW_INPUT = 'not-json';
    expect(SolidActions.getInput()).toEqual({});
  });
});

describe('SolidActions.getInputAsync', () => {
  const originalEnv = process.env;
  let server: Server;
  let serverPort: number;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.WORKFLOW_INPUT;
    delete process.env.WORKFLOW_INPUT_URL;
    delete process.env.SOLIDACTIONS_API_KEY;
  });

  afterEach((done) => {
    if (server?.listening) {
      server.close(done);
    } else {
      done();
    }
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  function startServer(
    handler: (req: import('http').IncomingMessage, res: import('http').ServerResponse) => void,
  ): Promise<number> {
    return new Promise((resolve) => {
      server = createServer(handler);
      server.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          serverPort = addr.port;
          resolve(serverPort);
        }
      });
    });
  }

  it('returns parsed JSON from WORKFLOW_INPUT (same as sync)', async () => {
    process.env.WORKFLOW_INPUT = JSON.stringify({ key: 'value' });
    const result = await SolidActions.getInputAsync();
    expect(result).toEqual({ key: 'value' });
  });

  it('returns empty object when both env vars are missing', async () => {
    const result = await SolidActions.getInputAsync();
    expect(result).toEqual({});
  });

  it('prefers WORKFLOW_INPUT over WORKFLOW_INPUT_URL', async () => {
    const port = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ from: 'url' }));
    });
    process.env.WORKFLOW_INPUT = JSON.stringify({ from: 'env' });
    process.env.WORKFLOW_INPUT_URL = `http://127.0.0.1:${port}/input`;

    const result = await SolidActions.getInputAsync();
    expect(result).toEqual({ from: 'env' });
  });

  it('fetches from WORKFLOW_INPUT_URL when WORKFLOW_INPUT is absent', async () => {
    const port = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{ trigger: 'push', data: { ref: 'main' } }]));
    });
    process.env.WORKFLOW_INPUT_URL = `http://127.0.0.1:${port}/input`;

    const result = await SolidActions.getInputAsync();
    expect(result).toEqual([{ trigger: 'push', data: { ref: 'main' } }]);
  });

  it('sends Authorization header with SOLIDACTIONS_API_KEY', async () => {
    let receivedAuth: string | undefined;
    const port = await startServer((req, res) => {
      receivedAuth = req.headers['authorization'] as string;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    process.env.WORKFLOW_INPUT_URL = `http://127.0.0.1:${port}/input`;
    process.env.SOLIDACTIONS_API_KEY = 'test-api-key-123';

    await SolidActions.getInputAsync();
    expect(receivedAuth).toBe('Bearer test-api-key-123');
  });

  it('does not send Authorization header when API key is absent', async () => {
    let receivedAuth: string | undefined;
    const port = await startServer((req, res) => {
      receivedAuth = req.headers['authorization'] as string;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    process.env.WORKFLOW_INPUT_URL = `http://127.0.0.1:${port}/input`;

    await SolidActions.getInputAsync();
    expect(receivedAuth).toBeUndefined();
  });

  it('throws on non-OK HTTP response', async () => {
    const port = await startServer((_req, res) => {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
    });
    process.env.WORKFLOW_INPUT_URL = `http://127.0.0.1:${port}/input`;

    await expect(SolidActions.getInputAsync()).rejects.toThrow(
      /Failed to fetch workflow input from WORKFLOW_INPUT_URL: 403/,
    );
  });

  it('returns empty object when URL response is invalid JSON', async () => {
    const port = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('not-json');
    });
    process.env.WORKFLOW_INPUT_URL = `http://127.0.0.1:${port}/input`;

    const result = await SolidActions.getInputAsync();
    expect(result).toEqual({});
  });
});

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { createCli } from '../src/cli/program.js';
import type { JsonObject } from '../src/result.js';
import { capture, context, temporary } from './helpers.js';

export const pageUrl = 'https://example.org/文档?q=a#安装';
export const pageText = '# Guide\n\n正文。\n';
export const initializeResult = {
  protocolVersion: '2025-11-25',
  serverInfo: { name: 'fixture', version: '1' },
  capabilities: { tools: {} },
};
export type Call = {
  path: string;
  body: JsonObject;
  headers: IncomingHttpHeaders;
  method?: string;
};
export function rpc(
  res: ServerResponse,
  id: unknown,
  result: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(200, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
}
export async function fixture(t: TestContext) {
  const root = temporary(t);
  const file = join(root, 'config.json');
  const save = (value: unknown) => writeFileSync(file, JSON.stringify(value));
  save({ providers: { jina: { enabled: false }, anysearch: { enabled: false } } });
  const calls: Call[] = [];
  let handler: (call: Call, res: ServerResponse) => void = (call, res) =>
    rpc(res, call.body.id, { content: [{ type: 'text', text: pageText }] });
  let handshake: ((call: Call, res: ServerResponse) => void) | undefined;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const call = {
      path: new URL(req.url!, 'http://localhost').pathname,
      body: raw ? JSON.parse(raw) : {},
      headers: req.headers,
      method: req.method,
    };
    calls.push(call);
    if (call.body.method === 'initialize') {
      if (handshake) handshake(call, res);
      else
        rpc(res, call.body.id, initializeResult, {
          'mcp-session-id': 'fixture-session',
          'x-request-id': 'init-request',
        });
    } else if (
      call.body.method === 'notifications/initialized' ||
      (call.body.jsonrpc === '2.0' && !call.body.method)
    ) {
      res.writeHead(202);
      res.end();
    } else handler(call, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const env: NodeJS.ProcessEnv = {
    UNISEARCH_CONFIG_PATH: file,
    UNISEARCH_LANG: 'en',
    UNISEARCH_RETRIES: '0',
    UNISEARCH_ZHIPU_MCP_BASE_URL: `${base}/gateway///`,
    UNISEARCH_ZHIPU_MCP_API_KEY: 'fixture-mcp-key',
  };
  return {
    root,
    file,
    base,
    env,
    calls,
    save,
    handle(value: typeof handler) {
      handler = value;
    },
    initialize(value: typeof handshake) {
      handshake = value;
    },
    result(value: unknown) {
      handler = (call, res) => rpc(res, call.body.id, value);
    },
    async run(args: string[], overrides: NodeJS.ProcessEnv = {}) {
      const channels = capture();
      const exit = await createCli('test', {
        config: context(root, { ...env, ...overrides }),
        channels,
      }).run(args);
      return { exit, channels, json: () => JSON.parse(channels.out) };
    },
  };
}

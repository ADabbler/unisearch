import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import type { TestContext } from 'node:test';
import { createCli } from '../src/cli/program.js';
import type { JsonObject } from '../src/result.js';
import { capture, context, temporary } from './helpers.js';

export const pageUrl = 'https://example.org/guide?q=中文&part=1#code';
export const page = { url: pageUrl, title: 'Guide', content: '# Guide\n\n```js\nrun();\n```' };
export const hit = { url: pageUrl, title: 'Guide', snippet: 'Summary', content: page.content };
export const envelope = (data: unknown) => ({ code: 0, message: 'success', data });
export const payloads: Record<string, unknown> = {
  '/gateway/v1/search': envelope({ results: [hit] }),
  '/gateway/v1/extract': envelope(page),
  '/gateway/v1/sub-domains': envelope({ domains: [{ domain: 'code', sub_domains: [] }] }),
  '/exa/search': { results: [{ url: pageUrl, title: 'Exa' }] },
  '/exa/contents': { results: [{ url: pageUrl, title: 'Exa', text: page.content }] },
  '/model/responses': {
    model: 'fixture-model',
    status: 'completed',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Model answer' }],
      },
    ],
  },
};
export type Call = {
  path: string;
  url: URL;
  method: string;
  body?: JsonObject;
  raw: Buffer;
  headers: IncomingHttpHeaders;
};
export async function fixture(t: TestContext) {
  const root = temporary(t);
  const file = join(root, 'config.json');
  writeFileSync(file, JSON.stringify({ providers: { jina: { enabled: false } } }));
  const calls: Call[] = [];
  let handler: (call: Call, res: ServerResponse) => void = (call, res) =>
    res.end(JSON.stringify(payloads[call.path]));
  const server = createServer({ maxHeaderSize: 65536 }, async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url!, 'http://localhost');
    const call = {
      path: url.pathname,
      url,
      method: req.method!,
      raw,
      headers: req.headers,
      ...(raw.length ? { body: JSON.parse(raw.toString('utf8')) } : {}),
    };
    calls.push(call);
    handler(call, res);
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
    UNISEARCH_ANYSEARCH_BASE_URL: `${base}/gateway/`,
    UNISEARCH_EXA_BASE_URL: `${base}/exa`,
    UNISEARCH_MODEL_BASE_URL: `${base}/model`,
    UNISEARCH_MODEL_ID: 'fixture-model',
  };
  return {
    root,
    file,
    base,
    env,
    calls,
    save(value: unknown) {
      writeFileSync(file, JSON.stringify(value));
    },
    handle(value: typeof handler) {
      handler = value;
    },
    reply(body: unknown, status = 200, headers: Record<string, string> = {}) {
      handler = (_call, res) => {
        res.writeHead(status, headers);
        res.end(JSON.stringify(body));
      };
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

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

export const url = 'https://example.org/文档?q=a,b#安装';
export const page = { url, title: 'Guide', content: '# Guide\n\nInstall the CLI.' };
export const envelope = (data: unknown, tokens?: unknown) => ({
  code: 200,
  status: 20000,
  data,
  ...(tokens === undefined ? {} : { meta: { usage: { tokens } } }),
});
export type Call = {
  path: string;
  body: JsonObject;
  headers: IncomingHttpHeaders;
  method?: string;
};
export async function fixture(t: TestContext) {
  const root = temporary(t);
  const file = join(root, 'config.json');
  const save = (value: unknown) => writeFileSync(file, JSON.stringify(value));
  save({ providers: { anysearch: { enabled: false } } });
  const calls: Call[] = [];
  let handler: (call: Call, res: ServerResponse) => void = (call, res) =>
    res.end(JSON.stringify(envelope(call.path.endsWith('/search') ? [page] : page)));
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const call: Call = {
      path: req.url!,
      body: JSON.parse(Buffer.concat(chunks).toString()),
      headers: req.headers,
      method: req.method,
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
    UNISEARCH_JINA_READER_URL: `${base}/reader///`,
    UNISEARCH_JINA_SEARCH_URL: `${base}/searcher/`,
  };
  return {
    root,
    file,
    base,
    env,
    calls,
    save,
    handle(value: (call: Call, res: ServerResponse) => void) {
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

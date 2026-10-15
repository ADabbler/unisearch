import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fixture, initializeResult, pageText, pageUrl, rpc } from './zhipu-mcp-fixture.js';
import { fieldAt } from '../src/config/fields.js';
import { resolveField } from '../src/config/resolve.js';
import { toolResult } from '../src/providers/zhipu-mcp-response.js';
import { renderMcp } from '../src/output/zhipu-mcp.js';
import { render } from '../src/output/render.js';
import type { JsonObject } from '../src/result.js';

test('Zhipu MCP config CRUD resolves platforms, environment precedence and explicit gateway independently', async (t) => {
  const f = await fixture(t);
  const field = fieldAt('providers.zhipu-mcp.base_url');
  assert.equal(resolveField({}, {}, field).value, 'https://open.bigmodel.cn/api/mcp');
  assert.equal(
    resolveField({}, { UNISEARCH_ZHIPU_MCP_PLATFORM: 'zai' }, field).value,
    'https://api.z.ai/api/mcp',
  );
  assert.equal(
    resolveField({}, { UNISEARCH_ZHIPU_MCP_PLATFORM: '' }, field).problems[0].field,
    'providers.zhipu-mcp.platform',
  );
  assert.equal((await f.run(['config', 'set', 'providers.zhipu-mcp.platform', 'zai'])).exit, 0);
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')), {
    providers: {
      jina: { enabled: false },
      anysearch: { enabled: false },
      'zhipu-mcp': { platform: 'zai' },
    },
  });
  assert.equal(
    (await f.run(['config', 'get', field.path], { UNISEARCH_ZHIPU_MCP_BASE_URL: undefined })).json()
      .data.value,
    'https://api.z.ai/api/mcp',
  );
  assert.equal((await f.run(['config', 'set', field.path, `${f.base}/saved`])).exit, 0);
  assert.equal(
    (await f.run(['config', 'set', 'providers.zhipu-mcp.platform', 'bigmodel'])).exit,
    0,
  );
  assert.equal(
    (await f.run(['config', 'get', field.path], { UNISEARCH_ZHIPU_MCP_BASE_URL: undefined })).json()
      .data.value,
    `${f.base}/saved`,
  );
  assert.equal(
    (await f.run(['config', 'get', field.path])).json().data.value,
    `${f.base}/gateway///`,
  );
  assert.equal((await f.run(['config', 'unset', field.path])).exit, 0);
  for (const [env, expected] of [
    [{}, 'ready'],
    [
      { UNISEARCH_ZHIPU_MCP_API_KEY: undefined, UNISEARCH_ZHIPU_API_KEY: 'rest-only-key' },
      'missing',
    ],
    [{ UNISEARCH_ZHIPU_MCP_PLATFORM: '' }, 'invalid'],
    [{ UNISEARCH_ZHIPU_MCP_PLATFORM: 'unknown' }, 'invalid'],
  ] as const) {
    const status = (await f.run(['status', '--json'], env))
      .json()
      .data.services.find((entry: JsonObject) => entry.provider === 'zhipu-mcp');
    assert.equal(status.state, expected);
    assert.equal(status.operations, undefined);
  }
  assert.equal(f.calls.length, 0);
});

test('Five Zhipu MCP CLI operations preserve arguments and use three endpoints with a single handshake', async (t) => {
  const f = await fixture(t);
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
  for (const [args, tool, params, endpoint] of [
    [
      ['search', ' query  中文 '],
      'webSearchPrime',
      { search_query: ' query  中文 ' },
      'web_search_prime',
    ],
    [['fetch', pageUrl], 'webReader', { url: pageUrl }, 'web_reader'],
    [
      ['docs', 'owner/repo', ' install '],
      'search_doc',
      { repo_name: 'owner/repo', query: ' install ' },
      'zread',
    ],
    [['tree', 'owner/repo'], 'get_repo_structure', { repo_name: 'owner/repo' }, 'zread'],
    [
      ['tree', 'owner/repo', '--path', '/'],
      'get_repo_structure',
      { repo_name: 'owner/repo', dir_path: '/' },
      'zread',
    ],
    [
      ['read-file', 'owner/repo', 'src/中文 文件.ts'],
      'read_file',
      { repo_name: 'owner/repo', file_path: 'src/中文 文件.ts' },
      'zread',
    ],
  ] as const) {
    f.calls.length = 0;
    const result = await f.run(['zhipu-mcp', ...args, '--format=json', '--verbose']);
    assert.equal(result.exit, 0, result.channels.out);
    assert.equal(f.calls.length, 3);
    assert.deepEqual(
      f.calls.map((call) => call.path),
      Array(3).fill(`/gateway/${endpoint}/mcp`),
    );
    assert.deepEqual(f.calls[2].body.params, { name: tool, arguments: params });
    assert.equal(f.calls[0].body.id, 1);
    assert.deepEqual((f.calls[0].body.params as JsonObject).clientInfo, {
      name: 'unisearch',
      version,
    });
    assert.equal(f.calls[2].body.id, 2);
    assert.equal(f.calls[1].body.method, 'notifications/initialized');
    for (const [index, call] of f.calls.entries()) {
      assert.equal(call.method, 'POST');
      assert.equal(call.headers.authorization, 'Bearer fixture-mcp-key');
      assert.equal(call.headers.accept, 'application/json, text/event-stream');
      assert.equal(call.headers['mcp-session-id'], index ? 'fixture-session' : undefined);
      assert.equal(call.headers['mcp-protocol-version'], index ? '2025-11-25' : undefined);
    }
    assert.equal(result.json().meta.attempts.length, 1);
    assert.equal(result.json().meta.attempts[0].request_id, undefined);
  }
});

test('Zhipu MCP validates parameters, configuration and output paths before initialization', async (t) => {
  const f = await fixture(t);
  for (const args of [
    ['search', ' '],
    ['docs', 'bad', 'query'],
    ['docs', 'a/b#x', 'query'],
    ['tree', 'a/b', '--path', ' '],
    ['read-file', 'a/b', 'a\nb'],
    ['fetch', 'file:///tmp/a'],
    ['fetch', pageUrl, pageUrl],
    ['search', 'q', '--limit', '1'],
  ])
    assert.equal((await f.run(['zhipu-mcp', ...args])).exit, 2);
  assert.equal(
    (await f.run(['zhipu-mcp', 'search', 'q'], { UNISEARCH_ZHIPU_MCP_PLATFORM: 'bad' })).exit,
    3,
  );
  assert.equal((await f.run(['zhipu-mcp', 'search', 'q', '--output', f.root])).exit, 5);
  assert.equal(f.calls.length, 0);
  f.save({ providers: { exa: { base_url: 'bad' } } });
  assert.equal((await f.run(['zhipu-mcp', 'search', 'q'])).exit, 0);
  for (const operation of ['search', 'fetch', 'docs', 'tree', 'read-file']) {
    const help = await f.run(['zhipu-mcp', operation, '--help'], {
      UNISEARCH_ZHIPU_MCP_PLATFORM: 'bad',
    });
    assert.equal(help.exit, 0);
    assert.match(help.channels.out, /--format/);
    assert.match(help.channels.out, /--timeout/);
  }
});

test('Zhipu MCP accepts supported negotiated versions and stateless servers, and rejects invalid initialization', async (t) => {
  const f = await fixture(t);
  for (const version of ['2025-11-25', '2025-06-18', '2025-03-26']) {
    f.initialize((call, res) =>
      rpc(res, call.body.id, { ...initializeResult, protocolVersion: version }),
    );
    f.calls.length = 0;
    assert.equal((await f.run(['zhipu-mcp', 'search', 'q'])).exit, 0);
    assert.equal(f.calls[2].headers['mcp-session-id'], undefined);
    assert.equal(f.calls[2].headers['mcp-protocol-version'], version);
  }
  for (const change of [
    { protocolVersion: '2024-11-05' },
    { capabilities: {} },
    { serverInfo: null },
  ]) {
    f.initialize((call, res) => rpc(res, call.body.id, { ...initializeResult, ...change }));
    f.calls.length = 0;
    const result = await f.run(['zhipu-mcp', 'search', 'q', '--format=json']);
    assert.equal(result.json().error.code, 'INVALID_RESPONSE');
    assert.equal(result.json().error.details.operation, 'initialize');
    assert.equal(f.calls.length, 1);
  }
});

test('Zhipu MCP rich content retains ordered blocks, structured data, metadata and exact JSON mirror rules', () => {
  const structured = {
    total: 0,
    more: false,
    next: null,
    hits: [],
    usage: { scope: 'repository' },
  };
  const plain = { type: 'text', text: JSON.stringify(structured) };
  const annotated = { type: 'text', text: 'explanation', annotations: { audience: ['assistant'] } };
  const resources = [
    {
      type: 'resource_link',
      uri: 'repo://README',
      name: 'readme',
      title: 'README title',
      custom: false,
    },
    {
      type: 'resource',
      resource: {
        uri: 'repo://file',
        mimeType: 'text/plain',
        text: 'const x = `a`;\n',
        unknown: null,
      },
    },
    { type: 'image', mimeType: 'image/png', data: 'abc' },
    { type: 'audio', mimeType: 'audio/wav', data: 'def' },
  ];
  const result = toolResult(
    {
      content: [plain, annotated, ...resources],
      structuredContent: structured,
      _meta: { scope: 'public', usage: { unknown: 0 } },
    },
    { operation: 'docs', target: 'a/b' },
    'en',
  );
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.result.data?.content, [annotated, ...resources]);
  assert.deepEqual(result.result.data?.structured_content, structured);
  assert.deepEqual(result.result.data?.metadata, { scope: 'public', usage: { unknown: 0 } });
  const markdown = renderMcp(result.result.data!, 'en');
  for (const retained of [
    'explanation',
    'README title',
    'repo://README',
    'unknown',
    'const x',
    'abc',
    'def',
    '"next": null',
  ])
    assert.ok(markdown.includes(retained));
  assert.doesNotMatch(markdown, /\]\(repo:/);
  const file = toolResult(
    { content: [plain], structuredContent: structured },
    { operation: 'read-file', target: 'a/b', path: 'config.json' },
    'en',
  );
  assert.equal(file.result.data?.text, plain.text);
  assert.deepEqual(file.result.data?.structured_content, structured);
});

test('Zhipu MCP empty results, file links and Reader unknown envelopes never manufacture body content', async (t) => {
  const f = await fixture(t);
  for (const operation of ['search', 'docs', 'tree', 'read-file'] as const) {
    const outcome = toolResult(
      { content: [{ type: 'text', text: '' }] },
      { operation, target: 'a/b', path: 'file' },
      'en',
    );
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.result.data?.text, '');
    assert.match(
      renderMcp(outcome.result.data!, 'en', operation),
      operation === 'read-file' ? /file content is empty/ : /no content/,
    );
  }
  const link = { type: 'resource_link', uri: 'https://example.org/file', name: 'file' };
  assert.equal(
    toolResult({ content: [link] }, { operation: 'read-file', target: 'a/b', path: 'x' }, 'en')
      .result.error?.code,
    'CONTENT_UNAVAILABLE',
  );
  for (const response of [
    { content: [] },
    { content: [{ type: 'text', text: ' ' }] },
    { content: [{ type: 'text', text: '{"error":"blocked"}' }] },
    {
      content: [],
      structuredContent: { reader_result: { content: 'unverified body', title: 'Title' } },
    },
  ]) {
    f.result(response);
    const outcome = await f.run(['zhipu-mcp', 'fetch', pageUrl, '--format=json']);
    assert.equal(outcome.json().error.code, 'CONTENT_UNAVAILABLE');
    assert.equal(outcome.json().data?.results[0].text, undefined);
  }
  f.result({ content: [{ type: 'text', text: pageText }] });
  const outcome = await f.run(['zhipu-mcp', 'fetch', pageUrl, '--format=json']);
  assert.deepEqual(outcome.json().data, {
    provider: 'zhipu-mcp',
    results: [{ url: pageUrl, text: pageText }],
  });
});

test('Zhipu MCP malformed blocks retain independent evidence and isError preserves diagnostics once', async (t) => {
  const f = await fixture(t);
  f.result({
    content: [
      { type: 'text', text: 'useful evidence' },
      { type: 'text', text: null },
      { type: 'audio', data: 3 },
    ],
    structuredContent: { total: 0 },
  });
  const broken = await f.run(['zhipu-mcp', 'search', 'q', '--format=json']);
  assert.equal(broken.json().error.code, 'INVALID_RESPONSE');
  assert.equal(broken.json().data.text, 'useful evidence');
  assert.deepEqual(
    broken
      .json()
      .error.details.causes.map((item: { details: JsonObject }) => item.details.upstream_index),
    [1, 2],
  );
  const evidence = {
    type: 'resource',
    resource: { uri: 'repo://README', text: 'independent evidence' },
  };
  f.result({
    isError: true,
    content: [{ type: 'text', text: 'repository not indexed' }, evidence],
    structuredContent: { indexed: false, indexed_files: 0 },
  });
  const failure = await f.run(['zhipu-mcp', 'docs', 'a/b', 'q', '--format=json']);
  assert.equal(failure.json().error.code, 'UPSTREAM_ERROR');
  assert.deepEqual(failure.json().data.content, [evidence]);
  assert.equal(failure.json().error.details.upstream_message, 'repository not indexed');
  assert.deepEqual(failure.json().error.details.upstream_data, {
    indexed: false,
    indexed_files: 0,
  });
  const md = await f.run(['zhipu-mcp', 'docs', 'a/b', 'q']);
  assert.match(md.channels.out, /indexed_files/);
  assert.equal(md.channels.out.match(/repository not indexed/g)?.length, 1);
  f.result({ isError: true, content: [{ type: 'text', text: 'only error' }] });
  assert.equal((await f.run(['zhipu-mcp', 'search', 'q', '--format=json'])).json().data, undefined);
});

test('Zhipu MCP output redacts known credentials and sessions even in upstream keys, code and provider', async (t) => {
  const f = await fixture(t);
  f.save({ providers: { exa: { api_key: 'other-secret' } } });
  f.result({
    content: [
      {
        type: 'text',
        text: 'Authorization: Bearer EXAMPLE\nfixture-mcp-key fixture-session other-secret',
      },
    ],
    structuredContent: {
      code: 'fixture-mcp-key',
      provider: 'fixture-session',
      'other-secret': false,
    },
  });
  for (const format of ['json', 'markdown']) {
    const result = await f.run(['zhipu-mcp', 'search', 'q', '--verbose', '--format', format]);
    assert.doesNotMatch(
      result.channels.out + result.channels.err,
      /fixture-mcp-key|fixture-session|other-secret/,
    );
    assert.match(result.channels.out, /Authorization: Bearer EXAMPLE/);
    assert.match(result.channels.out, /REDACTED/);
  }
});

test('Zhipu MCP invalid error flags and metadata cannot create successful evidence or hide malformed values', () => {
  for (const isError of ['false', null, 1]) {
    const result = toolResult(
      { isError, content: [{ type: 'text', text: 'untrusted status' }] },
      { operation: 'search', target: 'q' },
      'en',
    );
    assert.equal(result.result.error?.code, 'INVALID_RESPONSE');
    assert.equal(result.result.data, undefined);
    assert.equal(result.result.error?.details?.upstream_message, 'untrusted status');
  }
  const result = toolResult(
    { isError: true, content: [], _meta: { retry: false } },
    { operation: 'search', target: 'q' },
    'en',
  );
  assert.equal(result.result.data, undefined);
  assert.deepEqual(result.result.error?.details?.upstream_metadata, { retry: false });
  const invalid = toolResult(
    { content: [{ type: 'text', text: 'valid' }], structuredContent: { score: Infinity } },
    { operation: 'search', target: 'q' },
    'en',
  );
  assert.equal(invalid.result.error?.code, 'INVALID_RESPONSE');
  assert.equal(invalid.result.data?.text, 'valid');
  assert.equal(invalid.result.data?.structured_content, undefined);
});

test('Zhipu MCP opaque session IDs cannot rename public fields or protocol tags during redaction', async (t) => {
  const f = await fixture(t);
  for (const session of [
    'provider',
    'status',
    'text',
    'type',
    'content',
    'UPSTREAM_ERROR',
    'zhipu-mcp',
  ]) {
    f.initialize((call, res) =>
      rpc(res, call.body.id, initializeResult, { 'mcp-session-id': session }),
    );
    f.result({
      content: [
        { type: 'text', text: `body ${session}`, annotations: { audience: ['assistant'] } },
        { type: 'resource', resource: { uri: 'repo://file', text: `file ${session}` } },
      ],
      structuredContent: { code: session, provider: session },
    });
    const result = await f.run(['zhipu-mcp', 'search', 'q', '--format=json']);
    assert.equal(result.exit, 0, result.channels.out);
    const data = result.json().data;
    assert.equal(result.json().status, 'success');
    assert.equal(data.provider, 'zhipu-mcp');
    assert.equal(data.content[0].type, 'text');
    assert.equal(data.content[0].text, 'body [REDACTED]');
    assert.equal(data.content[1].type, 'resource');
    assert.equal(data.content[1].resource.text, 'file [REDACTED]');
    assert.deepEqual(Object.values(data.structured_content), ['[REDACTED]', '[REDACTED]']);

    f.result({
      isError: true,
      content: [{ type: 'text', text: `diagnostic ${session}`, annotations: {} }],
    });
    const failed = await f.run(['zhipu-mcp', 'search', 'q', '--format=json']);
    assert.equal(failed.exit, 4, failed.channels.out);
    assert.equal(failed.json().status, 'error');
    assert.equal(failed.json().error.code, 'UPSTREAM_ERROR');
    assert.equal(failed.json().error.details.provider, 'zhipu-mcp');
    assert.equal(failed.json().error.details.upstream_content[0].type, 'text');
    assert.equal(failed.json().error.details.upstream_content[0].text, 'diagnostic [REDACTED]');
  }
});

test('Zhipu MCP redaction preserves values when secret-bearing keys collide with each other or existing keys', async (t) => {
  const f = await fixture(t);
  f.save({ providers: { exa: { api_key: 'secret-one' } } });
  f.env.UNISEARCH_EXA_API_KEY = 'secret-two';
  f.result({
    content: [],
    structuredContent: {
      'secret-one': 1,
      'secret-two': 2,
      '[REDACTED]': 3,
      '[REDACTED] (2)': 4,
    },
  });
  const result = await f.run(['zhipu-mcp', 'search', 'q', '--format=json']);
  assert.equal(result.exit, 0);
  assert.deepEqual(Object.values(result.json().data.structured_content).sort(), [1, 2, 3, 4]);
  assert.equal(result.json().data.structured_content['[REDACTED]'], 3);
  assert.equal(result.json().data.structured_content['[REDACTED] (2)'], 4);
  assert.doesNotMatch(result.channels.out, /secret-one|secret-two/);
});

test('Zhipu MCP Markdown renders large files with many backticks without dropping content', () => {
  const body = '`x` '.repeat(150000) + '\n`````\n';
  const outcome = toolResult(
    { content: [{ type: 'text', text: body }] },
    { operation: 'read-file', target: 'owner/repo', path: 'file' },
    'en',
  );
  const output = render(outcome, {
    language: 'en',
    format: 'markdown',
    renderData: (data) => renderMcp(data, 'en', 'read-file'),
  });
  assert.equal(output.outcome.exitCode, 0);
  assert.ok(output.content.includes(body));
  assert.ok(output.content.endsWith('``````\n'));
});

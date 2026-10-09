import { readFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { hasNonfiniteNumber, isObject } from '../config/fields.js';
import { AppError } from '../errors.js';
import type { AttemptContext } from '../execution.js';
import type { MessageKey } from '../i18n/messages.js';
import type { JsonObject, JsonValue } from '../result.js';
import { redactDiagnostics, redactSecrets, transportError } from './transport.js';

export const protocolVersions = ['2025-11-25', '2025-06-18', '2025-03-26'];

export class McpError extends AppError {
  constructor(
    code: AppError['code'],
    key: MessageKey,
    details: JsonObject,
    readonly retry = false,
    readonly retryAfter?: string,
  ) {
    super(code, key, details);
  }
}

export function invalid(field: string, reason?: string): AppError {
  return new AppError('INVALID_RESPONSE', 'mcpResponse', {
    provider: 'zhipu-mcp',
    field,
    ...(reason ? { reason } : {}),
  });
}

function decode(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw invalid('response', 'invalid_json');
  }
}

function httpFailure(status: number, session: boolean): [AppError['code'], MessageKey, boolean] {
  switch (status) {
    case 401:
      return ['AUTHENTICATION_ERROR', 'mcpAuth', false];
    case 402:
      return ['QUOTA_EXCEEDED', 'mcpQuota', false];
    case 403:
      return ['ACCESS_DENIED', 'mcpAccess', false];
    case 408:
    case 504:
      return ['TIMEOUT', 'requestTimeout', true];
    case 429:
      return ['RATE_LIMITED', 'mcpRate', true];
    case 404:
      return ['UPSTREAM_ERROR', 'mcpUpstream', session];
    default:
      return ['UPSTREAM_ERROR', 'mcpUpstream', [500, 502, 503].includes(status)];
  }
}

async function withSession<T>(
  request: { url: string; apiKey: string; secrets: string[] },
  context: AttemptContext,
  transport: typeof fetch,
  run: (
    rpc: (method: string, params?: JsonObject) => Promise<unknown>,
    secrets: string[],
  ) => Promise<T>,
): Promise<T> {
  let session: string | undefined;
  let version: string | undefined;
  const secrets = [...request.secrets];
  const safe = (value: string) => redactDiagnostics(value, secrets) as string;
  const details = (): JsonObject => ({
    provider: 'zhipu-mcp',
    operation: context.operation!,
    ...(context.httpStatus === undefined ? {} : { http_status: context.httpStatus }),
    ...(context.requestId ? { request_id: context.requestId } : {}),
  });

  async function post(
    payload: JsonObject,
    operation: string,
    responseExpected: boolean,
  ): Promise<Response> {
    context.signal.throwIfAborted();
    context.operation = safe(operation);
    delete context.httpStatus;
    delete context.requestId;
    delete context.retryAllowed;
    const response = await transport(request.url, {
      method: 'POST',
      redirect: 'manual',
      signal: context.signal,
      headers: {
        Authorization: `Bearer ${request.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(session ? { 'Mcp-Session-Id': session } : {}),
        ...(version ? { 'MCP-Protocol-Version': version } : {}),
      },
      body: JSON.stringify(payload),
    });
    context.httpStatus = response.status;
    const id = response.headers.get('x-request-id');
    if (id?.trim()) context.requestId = safe(id);
    const [code, key, retry] = httpFailure(response.status, !!session);
    context.retryAllowed = response.ok || retry;
    if (!response.ok) {
      const diagnostic = details();
      if (code === 'TIMEOUT') diagnostic.timeout_scope = 'request';
      if (response.status === 404 && session) diagnostic.reason = 'session_expired';
      try {
        const body = decode(new Uint8Array(await response.arrayBuffer()));
        if (hasNonfiniteNumber(body)) throw invalid('response', 'nonfinite_error_body');
        diagnostic.upstream_data = redactSecrets(body as JsonValue, secrets);
      } catch (error) {
        context.signal.throwIfAborted();
        if (
          !(error instanceof AppError) &&
          !transportError(error, context, 'zhipu-mcp', 'mcpNetwork', safe)
        )
          throw error;
        if (diagnostic.reason === undefined) diagnostic.reason = 'error_body_invalid';
        else diagnostic.error_body_invalid = true;
      }
      throw new McpError(
        code,
        key,
        diagnostic,
        retry,
        response.headers.get('retry-after') ?? undefined,
      );
    }
    if (!responseExpected) {
      if (response.status !== 202) {
        await response.body?.cancel();
        throw invalid('response', 'notification_not_accepted');
      }
      if ((await response.arrayBuffer()).byteLength)
        throw invalid('response', 'unexpected_notification_body');
    }
    return response;
  }

  async function message(value: unknown, id: number): Promise<{ result: unknown } | undefined> {
    if (!isObject(value) || value.jsonrpc !== '2.0') throw invalid('jsonrpc');
    if (Object.hasOwn(value, 'method')) {
      if (
        typeof value.method !== 'string' ||
        Object.hasOwn(value, 'result') ||
        Object.hasOwn(value, 'error') ||
        (value.params !== undefined && !isObject(value.params))
      )
        throw invalid('method');
      if (!Object.hasOwn(value, 'id')) return undefined;
      if (
        typeof value.id !== 'string' &&
        !(typeof value.id === 'number' && Number.isInteger(value.id))
      )
        throw invalid('id');
      const phase = {
        operation: context.operation,
        httpStatus: context.httpStatus,
        requestId: context.requestId,
        retryAllowed: context.retryAllowed,
      };
      await post(
        {
          jsonrpc: '2.0',
          id: value.id,
          ...(value.method === 'ping'
            ? { result: {} }
            : { error: { code: -32601, message: 'Method not found' } }),
        },
        value.method,
        false,
      );
      Object.assign(context, phase);
      return undefined;
    }
    if (value.id !== id) throw invalid('id', 'response_id_mismatch');
    if (Object.hasOwn(value, 'result') === Object.hasOwn(value, 'error'))
      throw invalid('result', 'invalid_rpc_envelope');
    if (Object.hasOwn(value, 'error')) {
      const error = value.error;
      if (!isObject(error) || !Number.isInteger(error.code) || typeof error.message !== 'string')
        throw invalid('error');
      if (hasNonfiniteNumber(error.data)) throw invalid('error.data');
      throw new McpError('UPSTREAM_ERROR', 'mcpUpstream', {
        ...details(),
        upstream_code: error.code as number,
        upstream_message: safe(error.message),
        ...(error.data === undefined
          ? {}
          : { upstream_data: redactSecrets(error.data as JsonValue, secrets) }),
      });
    }
    if (!isObject(value.result)) throw invalid('result');
    return { result: value.result };
  }

  async function read(response: Response, id: number): Promise<unknown> {
    const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (type === 'application/json') {
      const parsed = await message(decode(new Uint8Array(await response.arrayBuffer())), id);
      if (!parsed) throw invalid('response', 'missing_result');
      return parsed.result;
    }
    if (type !== 'text/event-stream' || !response.body) {
      await response.body?.cancel();
      throw invalid('content-type');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = '';
    let skipLF = false;
    let lines: string[] = [];
    let resumable = false;
    let complete = false;
    try {
      for (;;) {
        context.signal.throwIfAborted();
        const chunk = await reader.read();
        try {
          buffer += decoder.decode(chunk.value, { stream: !chunk.done });
        } catch {
          throw invalid('response', 'invalid_utf8');
        }
        if (skipLF && buffer.length) {
          if (buffer.startsWith('\n')) buffer = buffer.slice(1);
          skipLF = false;
        }
        let boundary: number;
        while ((boundary = buffer.search(/[\r\n]/)) !== -1) {
          const line = buffer.slice(0, boundary);
          skipLF = buffer[boundary] === '\r' && boundary === buffer.length - 1;
          buffer = buffer.slice(
            boundary + (buffer.slice(boundary, boundary + 2) === '\r\n' ? 2 : 1),
          );
          if (line) {
            lines.push(line);
            continue;
          }
          const data: string[] = [];
          for (const item of lines) {
            const colon = item.indexOf(':');
            const name = colon === -1 ? item : item.slice(0, colon);
            const value = colon === -1 ? '' : item.slice(colon + 1).replace(/^ /, '');
            if (name === 'data') data.push(value);
            if (
              (name === 'id' && value && !value.includes('\0')) ||
              (name === 'retry' && /^\d+$/.test(value))
            )
              resumable = true;
          }
          lines = [];
          if (!data.join('\n').trim()) continue;
          let value: unknown;
          try {
            value = JSON.parse(data.join('\n'));
          } catch {
            throw invalid('response', 'invalid_sse_json');
          }
          const parsed = await message(value, id);
          if (parsed) {
            complete = true;
            return parsed.result;
          }
        }
        if (chunk.done) {
          if (buffer || lines.length) throw invalid('response', 'incomplete_sse_event');
          if (resumable)
            throw new McpError('UPSTREAM_ERROR', 'mcpUpstream', {
              ...details(),
              reason: 'stream_resume_required',
            });
          throw invalid('response', 'missing_result');
        }
      }
    } catch (error) {
      context.signal.throwIfAborted();
      if (
        !(error instanceof AppError) &&
        resumable &&
        transportError(error, context, 'zhipu-mcp', 'mcpNetwork', safe)
      )
        throw new McpError('UPSTREAM_ERROR', 'mcpUpstream', {
          ...details(),
          reason: 'stream_resume_required',
        });
      throw error;
    } finally {
      // Closing a consumed stream must not replace an already verified RPC result.
      try {
        await reader.cancel();
      } catch (error) {
        if (
          complete &&
          !context.signal.aborted &&
          !transportError(error, context, 'zhipu-mcp', 'mcpNetwork', safe)
        )
          throw error;
      } finally {
        reader.releaseLock();
      }
    }
  }

  try {
    const manifest = JSON.parse(readFileSync(findPackageJSON(import.meta.url)!, 'utf8')) as {
      version: string;
    };
    const initialized = await post(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: protocolVersions[0],
          capabilities: {},
          clientInfo: { name: 'unisearch', version: manifest.version },
        },
      },
      'initialize',
      true,
    );
    const sessionId = initialized.headers.get('mcp-session-id');
    if (sessionId !== null) {
      if (!/^[\x21-\x7e]+$/.test(sessionId)) {
        await initialized.body?.cancel();
        throw invalid('Mcp-Session-Id');
      }
      session = sessionId;
      secrets.push(sessionId);
      secrets.sort((a, b) => b.length - a.length);
      if (context.requestId) context.requestId = safe(context.requestId);
    }
    const info = await read(initialized, 1);
    if (
      !isObject(info) ||
      typeof info.protocolVersion !== 'string' ||
      !protocolVersions.includes(info.protocolVersion)
    )
      throw invalid('result.protocolVersion', 'unsupported_protocol');
    if (
      !isObject(info.serverInfo) ||
      typeof info.serverInfo.name !== 'string' ||
      typeof info.serverInfo.version !== 'string'
    )
      throw invalid('result.serverInfo');
    if (!isObject(info.capabilities) || !isObject(info.capabilities.tools))
      throw invalid('result.capabilities.tools');
    version = info.protocolVersion;
    await post(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      'notifications/initialized',
      false,
    );
    let nextId = 2;
    return await run(async (method, params) => {
      const id = nextId++;
      const response = await post(
        { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) },
        method,
        true,
      );
      return read(response, id);
    }, secrets);
  } catch (error) {
    context.signal.throwIfAborted();
    if (error instanceof AppError) {
      const clean = { ...details(), ...error.details };
      if (error instanceof McpError)
        throw new McpError(error.code, error.key, clean, error.retry, error.retryAfter);
      throw new McpError(error.code, error.key, clean);
    }
    const mapped = transportError(error, context, 'zhipu-mcp', 'mcpNetwork', safe);
    if (!mapped) throw error;
    throw new McpError(
      mapped.error.code,
      mapped.error.key,
      { ...details(), ...mapped.error.details },
      mapped.retry,
    );
  }
}

export function callTool(
  request: { url: string; apiKey: string; tool: string; arguments: JsonObject; secrets: string[] },
  context: AttemptContext,
  transport: typeof fetch,
): Promise<{ result: unknown; secrets: string[] }> {
  return withSession(request, context, transport, async (rpc, secrets) => ({
    result: await rpc('tools/call', { name: request.tool, arguments: request.arguments }),
    secrets,
  }));
}

export function discoverTool(
  request: { url: string; apiKey: string; tool: string; secrets: string[] },
  context: AttemptContext,
  transport: typeof fetch = fetch,
): Promise<void> {
  return withSession(request, context, transport, async (rpc) => {
    let cursor: string | undefined;
    const visited = new Set<string>();
    do {
      const result = await rpc('tools/list', cursor === undefined ? undefined : { cursor });
      if (!isObject(result) || !Array.isArray(result.tools)) throw invalid('result.tools');
      for (const tool of result.tools)
        if (!isObject(tool) || typeof tool.name !== 'string' || !tool.name.trim())
          throw invalid('result.tools.name');
      if (result.tools.some((tool) => tool.name === request.tool)) return;
      if (
        result.nextCursor !== undefined &&
        (typeof result.nextCursor !== 'string' || !result.nextCursor.trim())
      )
        throw invalid('result.nextCursor');
      cursor = result.nextCursor as string | undefined;
      if (cursor !== undefined) {
        if (visited.has(cursor)) throw invalid('result.nextCursor', 'pagination_cycle');
        visited.add(cursor);
      }
    } while (cursor !== undefined);
    throw new AppError('UPSTREAM_ERROR', 'mcpUpstream', {
      provider: 'zhipu-mcp',
      reason: 'tool_not_listed',
      tool: request.tool,
    });
  });
}

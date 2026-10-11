import { isObject } from '../config/fields.js';
import { AppError, failure } from '../errors.js';
import type { AttemptContext } from '../execution.js';
import { text } from '../i18n/messages.js';
import type { Language, MessageKey } from '../i18n/messages.js';
import { success } from '../result.js';
import type { JsonObject, JsonValue, Outcome, PublicError } from '../result.js';
import { validPageUrl } from './firecrawl-response.js';
import type { Request } from './jina.js';

export type SearchType = 'web' | 'news' | 'images';
export type Page = JsonObject & {
  url: string;
  title?: string;
  text?: string;
  description?: string;
  published_date?: string;
  date?: string;
  source?: string;
  image_url?: string;
  image_width?: number;
  image_height?: number;
  site_links?: { url: string; title?: string }[];
  num_pages?: number;
  metadata?: JsonObject;
  external?: Record<string, Record<string, JsonObject>>;
  warnings?: string[];
};
export type FetchData = { provider: 'jina'; results: Page[] };
export type SearchData = FetchData & { search_type: SearchType };
export type Data = FetchData | SearchData;

function jsonValue(value: unknown): value is JsonValue {
  if (typeof value === 'number') return Number.isFinite(value);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.every(jsonValue);
  return isObject(value) && Object.values(value).every(jsonValue);
}

// Billing belongs to a complete request, not to individual search results.
export function readUsage(body: unknown, context: AttemptContext): boolean {
  if (!isObject(body) || body.meta == null) return true;
  if (!isObject(body.meta)) return false;
  if (body.meta.usage == null) return true;
  if (!isObject(body.meta.usage)) return false;
  const tokens = body.meta.usage.tokens;
  if (tokens == null) return true;
  if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens < 0) return false;
  context.billedTokens = tokens;
  return true;
}

export function parseResponse(
  body: unknown,
  request: Request,
  context: AttemptContext,
  language: Language,
  safe: (value: string) => string,
): Outcome<Data> {
  const common: JsonObject = {
    provider: 'jina',
    http_status: 200,
    ...(context.requestId ? { request_id: context.requestId } : {}),
  };
  if (!isObject(body) || body.code !== 200 || body.status !== 20000)
    return failure(new AppError('INVALID_RESPONSE', 'jinaResponse', common), language);
  const validUsage = readUsage(body, context);
  if (request.operation === 'fetch' ? !isObject(body.data) : !Array.isArray(body.data))
    return failure(new AppError('INVALID_RESPONSE', 'jinaResponse', common), language);
  const causes: PublicError[] = [];
  const failures: (PublicError & { url: string })[] = [];
  const results: Page[] = [];
  const invalid = (key: MessageKey, details: JsonObject) =>
    causes.push(new AppError('INVALID_RESPONSE', key, details).public(language));
  if (!validUsage) invalid('jinaFieldInvalid', { field: 'meta.usage.tokens' });
  const entries: unknown[] = request.operation === 'fetch' ? [body.data] : (body.data as unknown[]);
  if (request.operation === 'search' && entries.length > request.limit)
    invalid('jinaCountInvalid', {});
  for (const [upstreamIndex, entry] of entries.entries()) {
    if (!isObject(entry) || !validPageUrl(entry.url)) {
      invalid('jinaPageInvalid', { upstream_index: upstreamIndex });
      continue;
    }
    const page: Page = { url: entry.url };
    const index = results.length;
    results.push(page);
    const badField = (field: string) => invalid('jinaFieldInvalid', { index, field });
    const optionalText = (field: string): string | undefined => {
      const value = entry[field];
      if (value == null) return undefined;
      if (typeof value !== 'string') {
        badField(field);
        return undefined;
      }
      return value.trim() ? value : undefined;
    };
    const strings = [
      ['title', 'title'],
      ['content', 'text'],
      ['description', 'description'],
      ['publishedTime', 'published_date'],
    ] as const;
    for (const [source, target] of strings) {
      const value = optionalText(source);
      if (value !== undefined) page[target] = value;
    }
    if (page.description === page.title || page.description === page.text) delete page.description;
    const warning = optionalText('warning');
    if (warning !== undefined) page.warnings = [safe(warning)];
    const numbers =
      request.operation === 'search'
        ? ([
            ['numPages', 'num_pages'],
            ['imageWidth', 'image_width'],
            ['imageHeight', 'image_height'],
          ] as const)
        : ([['numPages', 'num_pages']] as const);
    for (const [source, target] of numbers) {
      const value = entry[source];
      if (value == null) continue;
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) badField(source);
      else page[target] = value;
    }
    if (entry.metadata != null) {
      if (!isObject(entry.metadata) || !jsonValue(entry.metadata)) badField('metadata');
      else if (Object.keys(entry.metadata).length) page.metadata = entry.metadata;
    }
    if (entry.external != null) {
      if (!isObject(entry.external)) badField('external');
      else {
        const external: Record<string, Record<string, JsonObject>> = {};
        for (const [rel, addresses] of Object.entries(entry.external)) {
          if (!isObject(addresses)) {
            badField(`external.${rel}`);
            continue;
          }
          const links: [string, JsonObject][] = [];
          for (const [url, attrs] of Object.entries(addresses)) {
            if (!isObject(attrs) || !jsonValue(attrs)) badField(`external.${rel}.${url}`);
            else links.push([url, attrs]);
          }
          Object.defineProperty(external, rel, {
            value: Object.fromEntries(links),
            enumerable: true,
          });
        }
        if (Object.keys(external).length) page.external = external;
      }
    }
    if (request.operation === 'search') {
      for (const key of ['date', 'source'] as const) {
        const value = optionalText(key);
        if (value !== undefined) page[key] = value;
      }
      const image = optionalText('imageUrl');
      if (image !== undefined) {
        if (validPageUrl(image)) page.image_url = image;
        else badField('imageUrl');
      }
      if (entry.siteLinks != null) {
        if (!Array.isArray(entry.siteLinks)) badField('siteLinks');
        else {
          const links: NonNullable<Page['site_links']> = [];
          for (const [i, value] of entry.siteLinks.entries()) {
            if (!isObject(value) || !validPageUrl(value.link)) {
              badField(`siteLinks[${i}].link`);
              continue;
            }
            const link: { url: string; title?: string } = { url: value.link };
            if (value.title != null) {
              if (typeof value.title !== 'string') badField(`siteLinks[${i}].title`);
              else if (value.title.trim()) link.title = value.title;
            }
            links.push(link);
          }
          if (links.length) page.site_links = links;
        }
      }
    }
    const unavailable = (key: MessageKey, reason: string, details: JsonObject = {}) =>
      failures.push({
        url: safe(page.url),
        code: 'CONTENT_UNAVAILABLE',
        message: text(language, key),
        details: { index, reason, ...details },
      });
    let pageStatus: number | undefined;
    if (entry.httpStatus != null) {
      if (
        typeof entry.httpStatus !== 'number' ||
        !Number.isInteger(entry.httpStatus) ||
        entry.httpStatus < 100 ||
        entry.httpStatus > 599
      )
        badField('httpStatus');
      else pageStatus = entry.httpStatus;
    }
    const statusText = optionalText('httpStatusText');
    const warningStatuses = (warning ?? '').split(/\r\n|\r|\n/).flatMap((line) => {
      const match = /^Target URL returned error ([45]\d{2})(?::.*)?$/.exec(line);
      return match ? [Number(match[1])] : [];
    });
    if (
      new Set(warningStatuses).size > 1 ||
      (pageStatus !== undefined && warningStatuses.some((value) => value !== pageStatus))
    )
      badField('httpStatus/warning');
    if (entry.httpStatus == null) pageStatus = warningStatuses[0];
    if (pageStatus !== undefined && pageStatus >= 400)
      unavailable('jinaTargetFailed', 'target_http_error', {
        page_status: pageStatus,
        ...(statusText ? { upstream_message: safe(statusText) } : {}),
      });
    else if (
      (request.operation === 'fetch' || request.includeText) &&
      !page.text &&
      (entry.content == null || typeof entry.content === 'string')
    )
      unavailable('jinaEmpty', 'empty_content');
    if (
      request.operation === 'search' &&
      request.searchType === 'images' &&
      (entry.imageUrl == null || (typeof entry.imageUrl === 'string' && !entry.imageUrl.trim()))
    )
      unavailable('jinaImageMissing', 'missing_image');
  }
  const data: Data = {
    provider: 'jina',
    results,
    ...(request.operation === 'search' ? { search_type: request.searchType } : {}),
  };
  if (causes.length) {
    const outcome = failure<Data>(
      new AppError('INVALID_RESPONSE', 'jinaResponse', {
        ...common,
        causes,
        ...(failures.length ? { failures } : {}),
      }),
      language,
    );
    if (results.length || (request.operation === 'search' && entries.length === 0))
      outcome.result.data = data;
    return outcome;
  }
  if (!failures.length) return success(data);
  if (request.operation === 'search')
    return {
      result: {
        status: 'partial',
        data,
        error: {
          code: 'PARTIAL_FAILURE',
          message: text(language, 'jinaPartial'),
          details: { ...(context.requestId ? { request_id: context.requestId } : {}), failures },
        },
      },
      exitCode: 6,
    };
  const first = failures[0];
  const details: JsonObject = { ...common, url: first.url, ...first.details };
  delete details.index;
  return {
    result: { status: 'error', data, error: { code: first.code, message: first.message, details } },
    exitCode: 4,
  };
}

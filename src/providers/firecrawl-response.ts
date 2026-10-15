import { isObject } from '../config/fields.js';
import { AppError } from '../errors.js';
import type { JsonObject } from '../result.js';

export type ContentTruncation = { parsed_pages: number; total_pages: number };
export type SearchItem = JsonObject & {
  url: string;
  title?: string;
  description?: string;
  text?: string;
  final_url?: string;
  missing_content?: string[];
  content_error?: { page_status?: number; message?: string };
  content_truncation?: ContentTruncation;
  warnings?: string[];
};
export type SearchData = JsonObject & {
  provider: 'firecrawl';
  results: SearchItem[];
  warnings?: string[];
};
export type ScrapeData = JsonObject & {
  provider: 'firecrawl';
  url: string;
  text: string;
  title?: string;
  final_url?: string;
  content_type?: string;
  content_truncation?: ContentTruncation;
  warnings?: string[];
};
export type MapLink = { url: string; title?: string; description?: string };
export type MapData = JsonObject & {
  provider: 'firecrawl';
  links: MapLink[];
  warnings?: string[];
};

export function validPageUrl(value: unknown): value is string {
  if (typeof value !== 'string' || /\s/u.test(value)) return false;
  // URL parsing skips extra leading slashes and backslashes before the host.
  const authority = /^https?:\/\/[/\\]*([^/?#\\]*)/.exec(value)?.[1];
  if (authority === undefined || authority.includes('@')) return false;
  try {
    const url = new URL(value);
    return !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

function invalid(): never {
  throw new AppError('INVALID_RESPONSE', 'firecrawlResponse', { provider: 'firecrawl' });
}
function object(value: unknown): Record<string, unknown> {
  if (!isObject(value)) return invalid();
  return value;
}
function optionalText(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') return invalid();
  return value;
}
function requiredUrl(value: unknown): string {
  if (!validPageUrl(value)) return invalid();
  return value;
}
function envelope(value: unknown): Record<string, unknown> {
  const body = object(value);
  if (body.success !== true) return invalid();
  return body;
}
function metadata(doc: Record<string, unknown>): Record<string, unknown> {
  return doc.metadata === undefined ? {} : object(doc.metadata);
}
function pageError(meta: Record<string, unknown>, safe: (value: string) => string) {
  const status = meta.statusCode;
  if (
    status !== undefined &&
    (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599)
  )
    return invalid();
  const message = optionalText(meta.error);
  const badStatus = status !== undefined && !(status >= 200 && status < 300) && status !== 304;
  if (!badStatus && !message?.trim()) return undefined;
  return {
    ...(status === undefined ? {} : { page_status: status }),
    ...(message?.trim() ? { message: safe(message) } : {}),
  };
}
function finalUrl(meta: Record<string, unknown>, original: string): { final_url?: string } {
  const url = optionalText(meta.url);
  if (url === undefined) return {};
  requiredUrl(url);
  return url === original ? {} : { final_url: url };
}
function optionalPageCount(value: unknown, minimum: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
    return invalid();
  return value;
}
function truncation(meta: Record<string, unknown>): { content_truncation?: ContentTruncation } {
  const parsed = optionalPageCount(meta.numPages, 0);
  const total = optionalPageCount(meta.totalPages, 1);
  if (parsed === undefined || total === undefined) return {};
  if (parsed > total) return invalid();
  if (parsed === total) return {};
  return { content_truncation: { parsed_pages: parsed, total_pages: total } };
}
function notices(
  body: Record<string, unknown>,
  safe: (value: string) => string,
): { warnings?: string[] } {
  const single = optionalText(body.warning);
  const multiple = body.warnings;
  if (
    multiple !== undefined &&
    multiple !== null &&
    (!Array.isArray(multiple) || multiple.some((value) => typeof value !== 'string'))
  )
    return invalid();
  const warnings = [
    ...new Set(
      [...(single === undefined ? [] : [single]), ...((multiple ?? []) as string[])]
        .filter((value) => value.trim())
        .map(safe),
    ),
  ];
  return warnings.length ? { warnings } : {};
}

export function searchData(
  value: unknown,
  request: { includeText: boolean; limit: number },
  safe: (value: string) => string,
): SearchData {
  const body = envelope(value);
  const web = object(body.data).web;
  if (!Array.isArray(web) || web.length > request.limit) return invalid();
  const results = web.map((entry): SearchItem => {
    const item = object(entry);
    const url = requiredUrl(item.url);
    const title = optionalText(item.title);
    const description = optionalText(item.description);
    const result: SearchItem = {
      url,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
    };
    if (request.includeText) {
      const meta = metadata(item);
      const error = pageError(meta, safe);
      const markdown = optionalText(item.markdown);
      Object.assign(result, finalUrl(meta, url), notices(item, safe));
      if (error || !markdown?.trim()) {
        result.missing_content = ['text'];
        if (error) result.content_error = error;
      } else {
        result.text = markdown;
        Object.assign(result, truncation(meta));
      }
    }
    return result;
  });
  return { provider: 'firecrawl', results, ...notices(body, safe) };
}

export function scrapeData(
  value: unknown,
  url: string,
  safe: (value: string) => string,
): ScrapeData {
  const doc = object(envelope(value).data);
  const meta = metadata(doc);
  const error = pageError(meta, safe);
  if (error)
    throw new AppError('CONTENT_UNAVAILABLE', 'firecrawlPage', {
      reason: 'page_error',
      ...(error.page_status === undefined ? {} : { page_status: error.page_status }),
      ...(error.message ? { upstream_message: error.message } : {}),
    });
  if (typeof doc.markdown !== 'string') return invalid();
  if (!doc.markdown.trim())
    throw new AppError('CONTENT_UNAVAILABLE', 'firecrawlEmpty', { reason: 'empty_content' });
  let title: string | undefined;
  if (Array.isArray(meta.title)) {
    if (meta.title.some((value) => typeof value !== 'string')) return invalid();
    title = (meta.title as string[]).filter((value) => value.trim()).join(' · ');
  } else title = optionalText(meta.title);
  const contentType = optionalText(meta.contentType);
  return {
    provider: 'firecrawl',
    url,
    ...(title ? { title } : {}),
    ...(contentType ? { content_type: contentType } : {}),
    ...finalUrl(meta, url),
    ...truncation(meta),
    ...notices(doc, safe),
    text: doc.markdown,
  };
}

export function mapData(value: unknown, limit: number, safe: (value: string) => string): MapData {
  const body = envelope(value);
  if (!Array.isArray(body.links) || body.links.length > limit) return invalid();
  const links = body.links.map((entry): MapLink => {
    const item = object(entry);
    const url = requiredUrl(item.url);
    const title = optionalText(item.title);
    const description = optionalText(item.description);
    return { url, ...(title ? { title } : {}), ...(description ? { description } : {}) };
  });
  return { provider: 'firecrawl', links, ...notices(body, safe) };
}

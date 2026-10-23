import { isObject } from '../config/fields.js';
import { AppError } from '../errors.js';
import type { JsonObject } from '../result.js';
import { validPageUrl } from './firecrawl-response.js';

export type SearchResult = JsonObject & {
  title?: string;
  url: string;
  site_name?: string;
  date?: string;
  authority?: number;
  rerank_score?: number;
  summary?: string;
  content?: string;
};
export type SearchData = JsonObject & { provider: 'deepseek'; results: SearchResult[] };
export type FetchData = JsonObject & {
  provider: 'deepseek';
  results: { url: string; title?: string; text: string }[];
};

function invalid(): never {
  throw new AppError('INVALID_RESPONSE', 'deepseekResponse', {
    provider: 'deepseek',
    http_status: 200,
  });
}
function object(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : invalid();
}
function optionalText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return invalid();
  return value.trim() ? value : undefined;
}
function timestamp(value: unknown): string | undefined {
  const text = optionalText(value);
  if (text === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(text))
    return invalid();
  return Number.isFinite(Date.parse(text)) ? text : invalid();
}
function authority(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value)) return invalid();
  const rank = value as number;
  // -1 is the documented unknown sentinel, not the lower bound of a range.
  if (rank < -1 || rank > 4) return invalid();
  return rank === -1 ? undefined : rank;
}
function rerankScore(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 3)
    return invalid();
  return value;
}

export function searchData(value: unknown, limit: number): SearchData {
  const body = object(value);
  if (!Array.isArray(body.results) || body.results.length > limit) return invalid();
  return {
    provider: 'deepseek',
    results: body.results.map((entry) => {
      const item = object(entry);
      if (!validPageUrl(item.url)) return invalid();
      const result: SearchResult = { url: item.url };
      const title = optionalText(item.title);
      if (title !== undefined) result.title = title;
      const site = optionalText(item.site_name);
      if (site !== undefined) result.site_name = site;
      const date = timestamp(item.date);
      if (date !== undefined) result.date = date;
      const rank = authority(item.authority);
      if (rank !== undefined) result.authority = rank;
      const score = rerankScore(item.rerank_score);
      if (score !== undefined) result.rerank_score = score;
      // The snippet only stands in when the summary is absent; carrying both repeats one text.
      const summary = optionalText(item.summary) ?? optionalText(item.snippet);
      if (summary !== undefined) result.summary = summary;
      const content = optionalText(item.content);
      if (content !== undefined) result.content = content;
      return result;
    }),
  };
}

export function fetchData(value: unknown, url: string): FetchData {
  const body = object(value);
  if (typeof body.content !== 'string') return invalid();
  const title = optionalText(body.title);
  if (!body.content.trim())
    throw new AppError('CONTENT_UNAVAILABLE', 'deepseekUnavailable', {
      provider: 'deepseek',
      http_status: 200,
      reason: 'empty_content',
    });
  return {
    provider: 'deepseek',
    results: [{ url, ...(title === undefined ? {} : { title }), text: body.content }],
  };
}

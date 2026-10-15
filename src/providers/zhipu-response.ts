import { hasNonfiniteNumber, isObject } from '../config/fields.js';
import { AppError, failure } from '../errors.js';
import type { AttemptContext } from '../execution.js';
import type { Language } from '../i18n/messages.js';
import { success } from '../result.js';
import type { JsonObject, JsonValue, Outcome, PublicError } from '../result.js';
import type { FetchData as UnifiedFetchData } from '../retrieval.js';
import { validPageUrl } from './firecrawl-response.js';
import { redactSecrets } from './transport.js';
import type { Operation, Request } from './zhipu.js';

export type SearchItem = {
  url: string;
  title?: string;
  description?: string;
  source?: string;
  published_date?: string;
  refer?: string;
};
export type SearchIntent = { intent?: string; query?: string; keywords?: string };
export type SearchData = {
  provider: 'zhipu';
  search_engine: string;
  results: SearchItem[];
  search_intent?: SearchIntent[];
};
export type FetchData = Omit<UnifiedFetchData, 'provider'> & { provider: 'zhipu' };
export type DataByOperation = { search: SearchData; fetch: FetchData };

export function parseResponse<O extends Operation>(
  body: unknown,
  request: Request<O>,
  context: AttemptContext,
  language: Language,
): Outcome<DataByOperation[O]> {
  const common: JsonObject = {
    provider: 'zhipu',
    http_status: 200,
    ...(context.requestId ? { request_id: context.requestId } : {}),
    ...(context.responseId ? { response_id: context.responseId } : {}),
  };
  const errors: PublicError[] = [];
  const invalid = (field: string) =>
    errors.push(
      new AppError('INVALID_RESPONSE', 'zhipuFieldInvalid', {
        field: redactSecrets(field, request.secrets),
      }).public(language),
    );
  const optionalText = (
    item: Record<string, unknown>,
    key: string,
    path: string,
  ): string | undefined => {
    const value = item[key];
    if (value == null) return undefined;
    if (typeof value !== 'string') {
      invalid(path);
      return undefined;
    }
    return value.trim() ? value : undefined;
  };
  let data: SearchData | FetchData | undefined;
  let emptyContent = false;
  if (!isObject(body)) invalid('$');
  else if (request.operation === 'search') {
    if (!Array.isArray(body.search_result)) invalid('search_result');
    else {
      const results: SearchItem[] = [];
      if (typeof request.body.count === 'number' && body.search_result.length > request.body.count)
        invalid('search_result');
      for (const [index, entry] of body.search_result.entries()) {
        const path = `search_result[${index}]`;
        if (!isObject(entry)) {
          invalid(path);
          continue;
        }
        if (!validPageUrl(entry.link)) {
          invalid(`${path}.link`);
          continue;
        }
        const item: SearchItem = { url: entry.link };
        for (const [source, target] of [
          ['title', 'title'],
          ['content', 'description'],
          ['media', 'source'],
          ['publish_date', 'published_date'],
          ['refer', 'refer'],
        ] as const) {
          const value = optionalText(entry, source, `${path}.${source}`);
          if (value !== undefined) item[target] = value;
        }
        if (item.description === item.title) delete item.description;
        results.push(item);
      }
      const intents: SearchIntent[] = [];
      if (body.search_intent != null) {
        if (!Array.isArray(body.search_intent)) invalid('search_intent');
        else
          for (const [index, entry] of body.search_intent.entries()) {
            if (!isObject(entry)) {
              invalid(`search_intent[${index}]`);
              continue;
            }
            const intent: SearchIntent = {};
            for (const key of ['intent', 'query', 'keywords'] as const) {
              const value = optionalText(entry, key, `search_intent[${index}].${key}`);
              if (value !== undefined) intent[key] = value;
            }
            if (intent.intent === 'SEARCH_ALWAYS') delete intent.intent;
            if (intent.query === request.body.search_query) delete intent.query;
            if (intent.keywords === request.body.search_query || intent.keywords === intent.query)
              delete intent.keywords;
            if (Object.keys(intent).length) intents.push(intent);
          }
      }
      if (results.length || (!body.search_result.length && !errors.length))
        data = {
          provider: 'zhipu',
          search_engine: request.body.search_engine as string,
          results,
          ...(intents.length ? { search_intent: intents } : {}),
        };
    }
  } else {
    const entry = body.reader_result;
    if (!isObject(entry)) invalid('reader_result');
    else if (!validPageUrl(entry.url)) invalid('reader_result.url');
    else {
      const page: FetchData['results'][number] = { url: entry.url };
      let pageText: string | undefined;
      if (typeof entry.content !== 'string') invalid('reader_result.content');
      else if (!entry.content.trim()) emptyContent = true;
      else pageText = entry.content;
      for (const key of ['title', 'description'] as const) {
        const value = optionalText(entry, key, `reader_result.${key}`);
        if (value !== undefined) page[key] = value;
      }
      if (page.description === page.title || page.description === pageText) delete page.description;
      if (entry.metadata !== undefined) {
        if (!isObject(entry.metadata)) invalid('reader_result.metadata');
        else {
          const metadata: [string, JsonValue][] = [];
          for (const [key, value] of Object.entries(entry.metadata)) {
            if (['viewport', 'format-detection'].includes(key)) continue;
            if (hasNonfiniteNumber(value)) {
              invalid(`reader_result.metadata.${key}`);
              continue;
            }
            if (
              key === 'description' &&
              [page.title, page.description, pageText].includes(value as string)
            )
              continue;
            metadata.push([key, value as JsonValue]);
          }
          if (metadata.length) page.metadata = Object.fromEntries(metadata);
        }
      }
      if (entry.external !== undefined) {
        if (!isObject(entry.external)) invalid('reader_result.external');
        else {
          const relations: [string, Record<string, JsonObject>][] = [];
          for (const [rel, addresses] of Object.entries(entry.external)) {
            if (rel === 'stylesheet') continue;
            if (!isObject(addresses)) {
              invalid(`reader_result.external.${rel}`);
              continue;
            }
            const links: [string, JsonObject][] = [];
            for (const [url, attrs] of Object.entries(addresses)) {
              if (!validPageUrl(url) || !isObject(attrs)) {
                invalid(`reader_result.external.${rel}.${url}`);
                continue;
              }
              const properties = Object.entries(attrs).filter(([key, value]) => {
                if (!hasNonfiniteNumber(value)) return true;
                invalid(`reader_result.external.${rel}.${url}.${key}`);
                return false;
              });
              links.push([url, Object.fromEntries(properties) as JsonObject]);
            }
            if (links.length) relations.push([rel, Object.fromEntries(links)]);
          }
          if (relations.length) page.external = Object.fromEntries(relations);
        }
      }
      if (pageText !== undefined) page.text = pageText;
      if (Object.keys(page).length > 1) data = { provider: 'zhipu', results: [page] };
    }
  }
  if (data) {
    // Keep normalized field names stable; nested metadata keys belong to the upstream.
    const redactFields = <T extends JsonObject>(item: T): T =>
      Object.fromEntries(
        Object.entries(item).map(([key, value]) => [key, redactSecrets(value, request.secrets)]),
      ) as T;
    data.results = data.results.map((item) => redactFields(item));
    if ('search_engine' in data) {
      data.search_engine = redactSecrets(data.search_engine, request.secrets);
      if (data.search_intent) data.search_intent = data.search_intent.map(redactFields);
    }
  }
  let error: AppError | undefined;
  if (errors.length) {
    const details = errors.length === 1 ? errors[0].details : { causes: errors };
    error = new AppError('INVALID_RESPONSE', data ? 'zhipuRetained' : 'zhipuResponse', {
      ...common,
      ...details,
    });
  } else if (emptyContent) {
    error = new AppError('CONTENT_UNAVAILABLE', 'zhipuEmpty', {
      ...common,
      reason: 'empty_content',
    });
  }
  if (error) {
    const outcome = failure<DataByOperation[O]>(error, language);
    if (data) outcome.result.data = data as DataByOperation[O];
    return outcome;
  }
  return success(data as DataByOperation[O]);
}

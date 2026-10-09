import type { TestContext } from 'node:test';
import { fixture as httpFixture, payloads as otherPayloads } from './anysearch-fixture.js';
import type { ExecutionClock } from '../src/execution.js';

export const url = 'https://example.org/guide?q=中文&part=1#code';
export const content =
  '# Guide\n\n~~~sh\nunisearch --help\n~~~\n\n![image](https://example.org/image.png)\n\n[Details](https://example.org/details)';
export const page = { url, title: 'Guide', description: 'A useful guide.', content };
export const hit = {
  link: url,
  title: 'Guide',
  content: 'Full summary\n\n[Details](https://example.org/details)',
  media: 'Example',
  publish_date: '2026-09-30',
  refer: 'ref_1',
  icon: false,
};
export const search = { search_result: [hit], request_id: 'fixture-search-request' };
export const reader = {
  reader_result: page,
  request_id: 'fixture-reader-request',
  id: 'fixture-reader-task',
  model: 'fixture-reader-model',
};
export const payloads: Record<string, unknown> = {
  ...otherPayloads,
  '/gateway/web_search': search,
  '/gateway/reader': reader,
};

export async function fixture(t: TestContext) {
  const f = await httpFixture(t);
  f.env.UNISEARCH_ZHIPU_API_KEY = 'fixture-zhipu-key';
  f.env.UNISEARCH_ZHIPU_BASE_URL = `${f.base}/gateway///`;
  f.save({ providers: { jina: { enabled: false }, anysearch: { enabled: false } } });
  f.handle((call, res) => res.end(JSON.stringify(payloads[call.path])));
  return f;
}

export function timer() {
  let now = 0;
  let cleared = 0;
  const caps: number[] = [];
  const waits: number[] = [];
  const clock: ExecutionClock = {
    now: () => now,
    wallNow: () => Date.UTC(2026, 9, 1) + now,
    schedule(ms) {
      caps.push(ms);
      return () => {
        cleared++;
      };
    },
    async sleep(ms, signal) {
      signal.throwIfAborted();
      waits.push(ms);
      now += ms;
    },
  };
  return {
    clock,
    caps,
    waits,
    advance(ms: number) {
      now += ms;
    },
    cleared: () => cleared,
  };
}

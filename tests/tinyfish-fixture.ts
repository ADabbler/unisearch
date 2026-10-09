import type { TestContext } from 'node:test';
import { fixture as baseFixture, payloads } from './anysearch-fixture.js';

export const url = 'https://example.org/guide?q=中文&n=1#code';
export const hit = {
  url,
  title: 'Guide',
  snippet: 'Useful summary',
  site_name: 'example.org',
  position: 1,
};
export const search = { query: 'fixture', page: 0, total_results: 1, results: [hit] };
export const page = (address = url) => ({
  url: address,
  format: 'markdown',
  text: '# Guide\n\nFull body.',
  title: 'Guide',
});
export const fetched = (addresses = [url]) => ({ results: addresses.map(page), errors: [] });
export const error = (code = 'INVALID_API_KEY', message = 'Fixture failure') => ({
  error: { code, message },
});

export async function fixture(t: TestContext) {
  const f = await baseFixture(t);
  f.save({ providers: { jina: { enabled: false }, anysearch: { enabled: false } } });
  Object.assign(f.env, {
    UNISEARCH_TINYFISH_API_KEY: 'tinyfish-fixture-key',
    UNISEARCH_TINYFISH_SEARCH_URL: `${f.base}/tf-search`,
    UNISEARCH_TINYFISH_FETCH_URL: `${f.base}/tf-fetch/`,
  });
  f.handle((call, res) => {
    if (call.path === '/tf-search/') res.end(JSON.stringify(search));
    else if (call.path === '/tf-fetch/')
      res.end(JSON.stringify(fetched(call.body!.urls as string[])));
    else res.end(JSON.stringify(payloads[call.path]));
  });
  return f;
}

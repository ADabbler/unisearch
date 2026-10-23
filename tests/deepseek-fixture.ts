import type { TestContext } from 'node:test';
import { fixture as baseFixture } from './anysearch-fixture.js';

export const url = 'https://example.org/guide?q=中文&n=1#code';
export const hit = {
  title: 'DeepSeek V4 模型发布',
  url,
  snippet: '短摘要',
  summary: 'DeepSeek 发布了 V4 模型，改进了工具调用与长上下文能力。',
  content: '# 正文\n\n完整页面。',
  site_name: 'Example News',
  site_icon: 'https://example.org/icon.png',
  date: '2026-06-01T00:00:00+00:00',
  authority: 3,
  rerank_score: 2.4,
};
export const search = { results: [hit] };
export const fetched = { title: 'Install guide', content: '# Install\n\nRun `npm i`.' };
export const balance = {
  is_available: true,
  balance_infos: [
    {
      currency: 'CNY',
      total_balance: '110.00',
      granted_balance: '10.00',
      topped_up_balance: '100.00',
    },
  ],
};

export async function fixture(t: TestContext) {
  const f = await baseFixture(t);
  f.save({
    fetch: { providers: ['deepseek'] },
    providers: { jina: { enabled: false }, anysearch: { enabled: false } },
  });
  Object.assign(f.env, {
    UNISEARCH_DEEPSEEK_API_KEY: 'deepseek-fixture-key',
    UNISEARCH_DEEPSEEK_BASE_URL: `${f.base}/ds`,
  });
  f.handle((call, res) => {
    if (call.path === '/ds/v1/tools/search') res.end(JSON.stringify(search));
    else if (call.path === '/ds/v1/tools/fetch') res.end(JSON.stringify(fetched));
    else if (call.path === '/ds/user/balance') res.end(JSON.stringify(balance));
    else res.writeHead(404).end('{}');
  });
  return f;
}

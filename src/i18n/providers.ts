import type { Provider } from '../config/fields.js';
import type { Language } from './messages.js';

const names: Record<Provider, string> = {
  model: 'Model',
  exa: 'Exa',
  ctx7: 'Context7',
  anysearch: 'AnySearch',
  tavily: 'Tavily',
  firecrawl: 'Firecrawl',
  jina: 'Jina',
  zhipu: 'Zhipu',
  'zhipu-mcp': 'Zhipu Coding Plan MCP',
  tinyfish: 'TinyFish',
};
export function providerName(provider: Provider, language: Language): string {
  if (language === 'zh') {
    if (provider === 'model') return '模型';
    if (provider === 'zhipu') return '智谱';
    if (provider === 'zhipu-mcp') return '智谱 Coding Plan MCP';
  }
  return names[provider];
}
export function operationName(operation: string, language: Language): string {
  if (language === 'en') return operation;
  const names: Record<string, string> = {
    search: '搜索',
    fetch: '网页读取',
    extract: '正文提取',
    scrape: '单页抓取',
    map: '站点结构',
    library: '库定位',
    docs: '文档查询',
    domains: '领域目录',
    tree: '目录结构',
    'read-file': '文件读取',
    usage: '额度查询',
    credit_usage: '额度查询',
    models: '模型列表',
    'tools/list': '工具列表',
  };
  return names[operation] ?? operation;
}

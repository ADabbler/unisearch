import { readConfig } from '../config/read.js';
import { configContext, selectConfigPath } from '../config/path.js';
import type { ConfigContext } from '../config/path.js';
import { AppError } from '../errors.js';
import type { Language } from './messages.js';

export function systemLanguage(
  env: NodeJS.ProcessEnv,
  locale = () => new Intl.DateTimeFormat().resolvedOptions().locale,
): Language {
  const value = env.LC_ALL || env.LC_MESSAGES || env.LANG || locale();
  return /^zh(?:$|[-_.@])/i.test(value) ? 'zh' : 'en';
}

export function resolveLanguage(
  context: ConfigContext = configContext(),
  values?: Record<string, unknown>,
): Language {
  const override = context.env.UNISEARCH_LANG;
  const value =
    override === undefined
      ? (values ?? readConfig(selectConfigPath(context)).values).language
      : override;
  if (value === undefined || value === 'auto') return systemLanguage(context.env);
  if (value === 'zh' || value === 'en') return value;
  throw new AppError('INVALID_CONFIG', 'invalidLanguage', {
    field: override === undefined ? 'language' : 'UNISEARCH_LANG',
  });
}

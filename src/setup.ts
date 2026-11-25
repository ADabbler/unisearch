import { isDeepStrictEqual } from 'node:util';
import {
  assertValid,
  fieldAt,
  providers,
  searchProviders,
  redact,
  valueAt,
} from './config/fields.js';
import type { Field, Provider } from './config/fields.js';
import { inspectClassifier } from './config/classifier.js';
import { prepareMutation, checkCancellation } from './config/manage.js';
import type { Mutation } from './config/manage.js';
import type { ConfigDocument } from './config/read.js';
import type { ConfigContext } from './config/path.js';
import { resolveField } from './config/resolve.js';
import { saveConfig } from './config/write.js';
import { AppError, failure } from './errors.js';
import { colon, text } from './i18n/messages.js';
import type { Language, MessageKey } from './i18n/messages.js';
import { providerName, operationName } from './i18n/providers.js';
import type { Choice, Prompts } from './cli/prompts.js';
import { PromptBack, selectSkillTargets } from './cli/prompts.js';
import { operations } from './providers/operations.js';
import { targetPaths } from './skills/targets.js';
import type { SkillTarget, TargetPath } from './skills/targets.js';
import { manageSkills } from './skills/manage.js';
import type { SkillsData } from './skills/manage.js';
import { success } from './result.js';
import type { JsonObject, JsonValue, Outcome } from './result.js';

export const setupFields: Record<Provider, string[]> = {
  model: ['base_url', 'protocol', 'api_key', 'model.id', 'model.effort'],
  exa: ['base_url', 'api_key'],
  ctx7: ['base_url', 'api_key'],
  anysearch: ['base_url', 'api_key'],
  tavily: ['base_url', 'api_key'],
  firecrawl: ['base_url', 'api_key'],
  jina: ['search_url', 'reader_url', 'api_key'],
  zhipu: ['platform', 'base_url', 'api_key'],
  'zhipu-mcp': ['platform', 'base_url', 'api_key'],
  tinyfish: ['search_url', 'fetch_url', 'api_key'],
  deepseek: ['base_url', 'api_key'],
};
export type SetupData = JsonObject & { config: JsonObject };

const choiceLabels: Record<string, string> = {
  responses: 'Responses',
  'chat-completions': 'Chat Completions',
  bigmodel: 'BigModel',
  zai: 'Z.AI',
};
const xaiBaseUrl = 'https://api.x.ai/v1';
const xaiTools = ['web_search', 'x_search'];

function serviceName(provider: Provider, language: Language): string {
  if (provider === 'model') return language === 'zh' ? '模型搜索' : 'Model search';
  return providerName(provider, language);
}

function fieldName(suffix: string, language: Language): string {
  const zh = language === 'zh';
  switch (suffix) {
    case 'api_key':
      return 'API Key';
    case 'base_url':
      return zh ? 'API 地址' : 'API URL';
    case 'reader_url':
      return zh ? '网页读取地址' : 'Reader URL';
    case 'search_url':
      return zh ? '搜索地址' : 'Search URL';
    case 'fetch_url':
      return zh ? '网页读取地址' : 'Fetch URL';
    case 'model.id':
      return zh ? '模型 ID' : 'model ID';
    case 'model.effort':
      return zh ? '思考等级' : 'reasoning effort';
    case 'protocol':
      return zh ? '协议' : 'protocol';
    case 'platform':
      return zh ? '平台' : 'platform';
    default:
      throw new Error(`Unknown setup field: ${suffix}`);
  }
}

function previewValue(field: Field, value: JsonValue | undefined): string {
  if (value === undefined) return '';
  const shown = String(value);
  if (field.kind === 'credential') {
    if (shown.length <= 8) return '••••••••';
    const visible = shown.length > 12 ? 4 : 2;
    return `${shown.slice(0, visible)}•••${shown.slice(-visible)}`;
  }
  return field.kind === 'protocol' || field.choices ? (choiceLabels[shown] ?? shown) : shown;
}

export class SetupDraft {
  private edits = new Map<string, string>();
  selections = new Map<string, string>();
  selected: Provider[] = [];
  skills: SkillTarget[] = [];
  values: Record<string, unknown>;
  constructor(
    readonly document: ConfigDocument,
    readonly context: ConfigContext,
    public language: Language,
  ) {
    this.values = structuredClone(document.values);
  }
  set(key: string, value: string): void {
    this.values = prepareMutation(
      { ...this.document, values: this.values },
      this.context.env,
      this.language,
      key,
      value,
    ).values;
    this.edits.set(key, value);
  }
  selectServices(selected: Provider[]): void {
    for (const entries of [this.edits, this.selections])
      for (const key of entries.keys())
        if (key.startsWith('providers.') && !selected.includes(key.split('.')[1] as Provider))
          entries.delete(key);
    this.values = structuredClone(this.document.values);
    for (const [key, value] of this.edits)
      this.values = prepareMutation(
        { ...this.document, values: this.values },
        this.context.env,
        this.language,
        key,
        value,
      ).values;
    this.selected = selected;
    for (const provider of selected)
      if (valueAt(this.values, `providers.${provider}.enabled`) === false)
        this.set(`providers.${provider}.enabled`, 'true');
  }
  changes(): JsonObject[] {
    return [...this.edits.keys()]
      .filter(
        (key) => !isDeepStrictEqual(valueAt(this.document.values, key), valueAt(this.values, key)),
      )
      .map((key) => ({ key, value: redact(fieldAt(key), valueAt(this.values, key) as JsonValue) }));
  }
  overrides(): JsonObject {
    return Object.fromEntries(
      [...this.edits.keys()].flatMap((key) => {
        const environment = fieldAt(key).environment;
        return environment && this.context.env[environment] !== undefined
          ? [[key, environment]]
          : [];
      }),
    );
  }
  targets(): TargetPath[] {
    return targetPaths(this.skills, this.context);
  }
  pending(): SetupData {
    return {
      config: { path: this.document.path, state: 'not_saved' },
      ...(this.skills.length
        ? { skills: this.targets().map((target) => ({ ...target, state: 'not_started' })) }
        : {}),
    };
  }
  mutation(): Mutation {
    return {
      values: this.values,
      changed: !isDeepStrictEqual(this.document.values, this.values),
      data: { changed: false },
    };
  }
  current(key: string) {
    const field = fieldAt(key);
    const env =
      field.environment && this.edits.has(key)
        ? { ...this.context.env, [field.environment]: undefined }
        : this.context.env;
    return resolveField(this.values, env, field);
  }
  preview(key: string): string {
    const field = fieldAt(key),
      item = this.current(key);
    const zh = this.language === 'zh';
    if (item.problems.length) return zh ? '配置非法' : 'invalid configuration';
    if (item.value === undefined) return '';
    const value = previewValue(field, item.value);
    let origin = item.source;
    if (item.source === 'config' && this.edits.has(key)) origin = zh ? '待保存' : 'pending';
    else if (item.source === 'config') origin = zh ? '已配置' : 'configured';
    else if (item.source === 'default') origin = zh ? '默认' : 'default';
    return `${origin}${colon(this.language)}${value}`;
  }
}

function promptSetting(draft: SetupDraft, prompts: Prompts, key: string, message: string) {
  const field = fieldAt(key);
  return prompts.input(
    message,
    field.kind === 'credential',
    (input) => {
      if (input === '') return;
      try {
        prepareMutation(
          { ...draft.document, values: draft.values },
          draft.context.env,
          draft.language,
          key,
          input,
        );
      } catch (error) {
        if (error instanceof AppError) return error.public(draft.language).message;
        throw error;
      }
    },
    draft.language,
    previewValue(field, draft.current(key).value),
  );
}

async function promptServices(draft: SetupDraft, prompts: Prompts): Promise<void> {
  const { language } = draft;
  const zh = language === 'zh';
  const selected = await prompts.multi(
    text(language, 'setupSelectServices'),
    providers.map((provider) => {
      const choice = { value: provider, label: serviceName(provider, language) };
      if (provider === 'model') return choice;
      const providerOperations = operations.filter((operation) => operation.provider === provider);
      if (provider === 'jina') {
        const order = ['search', 'fetch'];
        providerOperations.sort((a, b) => order.indexOf(a.operation) - order.indexOf(b.operation));
      }
      return {
        ...choice,
        description: providerOperations
          .map((operation) => operationName(operation.operation, language, provider))
          .join(zh ? '、' : ', '),
      };
    }),
    draft.selected,
    language,
  );
  draft.selectServices(providers.filter((provider) => selected.includes(provider)));
  for (const provider of draft.selected) {
    const providerOperations = operations.filter((operation) => operation.provider === provider);
    const name = serviceName(provider, language);
    const actionName = zh && /^[A-Za-z0-9]/.test(name) ? ` ${name}` : name;
    let askModelTools = false;
    let modelUsesXai = false;
    for (const suffix of setupFields[provider]) {
      if (provider === 'model' && suffix === 'protocol' && modelUsesXai) continue;
      const key = `providers.${provider}.${suffix}`,
        field = fieldAt(key);
      const fieldLabel = fieldName(suffix, language);
      const label = `${name} ${fieldLabel}`;
      const optional =
        providerOperations.some((operation) => operation.optional?.includes(key)) &&
        !providerOperations.some((operation) => operation.required.includes(key));
      const detail = draft.preview(key) || (optional ? text(language, 'setupOptional') : '');
      let preview = '';
      if (detail) preview = zh ? `（${detail}）` : ` (${detail})`;
      const isChoice = suffix === 'protocol' || suffix === 'platform';
      const selectionLabel = isChoice ? `${name}${fieldLabel}` : `${actionName} ${fieldLabel}`;
      const selectionTitle = zh ? `请选择${selectionLabel}${preview}` : `Select ${label}${preview}`;
      let input: string;
      if (isChoice) {
        const choices =
          suffix === 'protocol' ? ['responses', 'chat-completions'] : field.choices!.map(String);
        const resolved = draft.current(key);
        input = await prompts.select(
          selectionTitle,
          choices.map((value) => ({
            value,
            label: choiceLabels[value],
          })),
          resolved.value === undefined ? '' : String(resolved.value),
          language,
        );
        if (input === resolved.value) continue;
      } else {
        if (field.kind === 'url') {
          const resolved = draft.current(key);
          const choices: Choice[] = [];
          let currentLabel = zh ? '当前地址' : 'Current URL';
          if (provider === 'model') {
            if (resolved.value !== undefined)
              choices.push({ value: 'current', label: currentLabel });
            choices.push({ value: 'xai', label: text(language, 'setupXaiPreset') });
          } else {
            if (resolved.source === 'default') currentLabel = zh ? '默认' : 'Default';
            choices.push({ value: 'current', label: currentLabel });
          }
          choices.push({ value: 'custom', label: zh ? '自定义' : 'Custom' });
          const mode = await prompts.select(
            selectionTitle,
            choices,
            draft.selections.get(key) ?? choices[0].value,
            language,
          );
          draft.selections.set(key, mode);
          if (mode === 'current') continue;
          if (provider === 'model' && mode === 'xai') {
            modelUsesXai = true;
            draft.set(key, xaiBaseUrl);
            if (draft.current('providers.model.protocol').value !== 'responses')
              draft.set('providers.model.protocol', 'responses');
            draft.set('providers.model.tools', JSON.stringify(xaiTools));
            continue;
          }
          if (provider === 'model') askModelTools = true;
        }
        let inputTitle = zh ? `配置${actionName} ${fieldLabel}` : `Configure ${label}`;
        if (zh && (suffix === 'model.id' || suffix === 'model.effort'))
          inputTitle = `配置${name}的${fieldLabel}`;
        const titlePreview = field.kind === 'url' ? '' : preview;
        input = await promptSetting(draft, prompts, key, `${inputTitle}${titlePreview}`);
      }
      if (input !== '') draft.set(key, input);
    }
    if (provider === 'model' && askModelTools) {
      const key = 'providers.model.tools';
      const hasCurrentTools = valueAt(draft.values, key) !== undefined;
      const choices: Choice[] = [];
      if (hasCurrentTools)
        choices.push({ value: 'keep', label: zh ? '保持当前工具配置' : 'Keep current tools' });
      choices.push(
        { value: 'xai', label: zh ? '启用 xAI 搜索工具' : 'Enable xAI search tools' },
        { value: 'none', label: zh ? '不使用工具' : 'Use no tools' },
      );
      const tools = await prompts.select(
        zh ? '模型搜索工具' : 'Model search tools',
        choices,
        hasCurrentTools ? 'keep' : 'xai',
        language,
      );
      if (tools !== 'keep') draft.set(key, JSON.stringify(tools === 'xai' ? xaiTools : []));
    }
  }
}

async function promptSearchSources(draft: SetupDraft, prompts: Prompts): Promise<void> {
  const { language } = draft;
  const current = draft.current('search.providers');
  assertValid(current.problems, language);
  const sources = await prompts.multi(
    text(language, 'setupSelectSearchSources'),
    searchProviders.map((provider) => ({
      value: provider,
      label: serviceName(provider, language),
    })),
    current.value as string[],
    language,
    (selected) => (selected?.length ? undefined : text(language, 'setupSearchSourcesRequired')),
  );
  if (!isDeepStrictEqual(sources, current.value))
    draft.set('search.providers', JSON.stringify(sources));
}

const classifierFields = [
  ['base_url', 'setupClassifierUrl'],
  ['api_key', 'setupClassifierKey'],
  ['model', 'setupClassifierModel'],
] as const;

async function promptClassifier(draft: SetupDraft, prompts: Prompts): Promise<void> {
  const { language } = draft;
  for (const [suffix, label] of classifierFields) {
    const key = `search.routing.classifier.${suffix}`;
    const current =
      suffix === 'base_url' && !draft.current(key).problems.length ? '' : draft.preview(key);
    const hint = current ? (language === 'zh' ? `（${current}）` : ` (${current})`) : '';
    const value = await promptSetting(draft, prompts, key, text(language, label) + hint);
    if (value !== '') draft.set(key, value);
  }
}

const routingEnabled = 'search.routing.enabled';

function routingProblem(draft: SetupDraft): string | undefined {
  const {
    values,
    context: { env },
    language,
  } = draft;
  const classifier = inspectClassifier(values, env);
  const limit = resolveField(values, env, fieldAt('search.routing.max_sources'));
  const problem = classifier.problems[0] ?? limit.problems[0];
  if (problem) {
    const field = problem.environment ?? problem.field ?? text(language, 'classifierLabel');
    return field + colon(language) + text(language, problem.message);
  }
  if (classifier.missing.length) return text(language, 'setupRoutingNeedsClassifier');
}

async function promptRouting(draft: SetupDraft, prompts: Prompts): Promise<void> {
  const { language } = draft;
  const current = draft.current(routingEnabled).value;
  const choose = (value: string, label: MessageKey) => ({ value, label: text(language, label) });
  const selected = await prompts.select(
    text(language, 'setupRouting'),
    [choose('true', 'setupRoutingEnable'), choose('false', 'setupRoutingDisable')],
    current === true ? 'true' : 'false',
    language,
    {
      menu: { titleGap: false },
      validate: (value) => (value === 'true' ? routingProblem(draft) : undefined),
    },
  );
  if (selected !== String(current)) draft.set(routingEnabled, selected);
}

async function promptSearch(
  draft: SetupDraft,
  prompts: Prompts,
  nextPage: () => void,
): Promise<void> {
  const { language } = draft;
  let section = 'sources';
  while (true) {
    section = await prompts.select(
      text(language, 'setupSearch'),
      [
        { value: 'sources', label: text(language, 'setupSearchSources') },
        { value: 'classifier', label: text(language, 'classifierLabel') },
        { value: 'routing', label: text(language, 'setupRouting') },
      ],
      section,
      language,
      { menu: {} },
    );
    nextPage();
    try {
      if (section === 'sources') await promptSearchSources(draft, prompts);
      if (section === 'classifier') await promptClassifier(draft, prompts);
      if (section === 'routing') await promptRouting(draft, prompts);
    } catch (error) {
      if (!(error instanceof PromptBack)) throw error;
    }
    nextPage();
  }
}

export async function promptSetup(
  draft: SetupDraft,
  prompts: Prompts,
  preview: (draft: SetupDraft) => string[] | Promise<string[]>,
  setLanguage: (language: Language) => void,
  nextPage: () => void,
): Promise<void> {
  let section = 'services';
  while (true) {
    const { language } = draft;
    const choose = (value: string, label: MessageKey) => ({ value, label: text(language, label) });
    section = await prompts.select(
      text(language, 'setupTitle'),
      [
        choose('services', 'setupServices'),
        choose('search', 'setupSearch'),
        choose('language', 'setupLanguage'),
        choose('skills', 'setupSkills'),
        { value: 'review', label: text(language, 'setupReview'), action: true },
        { value: 'cancel', label: text(language, 'setupCancel'), action: true },
      ],
      section,
      language,
      { menu: { separateBefore: 'review' }, cancelOnEscape: true },
    );
    if (section === 'cancel') throw new AppError('CANCELLED', 'cancelled');
    nextPage();
    try {
      if (section === 'services') await promptServices(draft, prompts);
      if (section === 'search') await promptSearch(draft, prompts, nextPage);
      if (section === 'language') {
        draft.language = (await prompts.select(
          text(language, 'setupLanguage'),
          [
            { value: 'zh', label: '中文' },
            { value: 'en', label: 'English' },
          ],
          language,
          language,
        )) as Language;
        draft.set('language', draft.language);
        setLanguage(draft.language);
      }
      if (section === 'skills')
        draft.skills = await selectSkillTargets(prompts, language, 'install', draft.skills);
      if (section === 'review') {
        const details = await preview(draft);
        const decision = await prompts.select(
          text(language, 'setupReview'),
          [
            { value: 'save', label: text(language, 'setupSave'), action: true },
            { value: 'back', label: text(language, 'setupBack'), action: true },
          ],
          'save',
          language,
          { menu: { details } },
        );
        if (decision === 'save') return;
      }
    } catch (error) {
      if (!(error instanceof PromptBack)) throw error;
    }
    nextPage();
  }
}

export async function applySetup(
  draft: SetupDraft,
  path: string,
  signal: AbortSignal,
  source?: string,
): Promise<Outcome<SetupData>> {
  const data = draft.pending();
  try {
    checkCancellation(signal);
    const saved = await saveConfig(draft.mutation(), path, draft.language, signal);
    const changed = saved.result.data?.changed === true;
    if (changed || saved.exitCode === 0) {
      data.config.state = changed ? 'saved' : 'unchanged';
      if (changed) data.config.changes = draft.changes();
      const overrides = draft.overrides();
      if (Object.keys(overrides).length) data.config.overrides = overrides;
    }
    if (saved.result.status !== 'success')
      return { ...saved, result: { ...saved.result, data } } as Outcome<SetupData>;
    checkCancellation(signal);
    if (draft.skills.length) {
      let installed: Outcome<SkillsData>;
      try {
        installed = await manageSkills('install', draft.targets(), draft.language, signal, source);
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'FILE_IO_ERROR') throw error;
        return {
          result: {
            status: 'partial',
            data,
            error: new AppError('SETUP_SKILLS_FAILED', 'setupSkillsFailed', {
              causes: [error.public(draft.language)],
            }).public(draft.language),
          },
          exitCode: 6,
        };
      }
      data.skills = installed.result.data?.targets ?? data.skills;
      if (installed.result.status !== 'success') {
        if (installed.exitCode === 130 || installed.result.error.code === 'INTERNAL_ERROR')
          return { ...installed, result: { ...installed.result, data } } as Outcome<SetupData>;
        return {
          result: {
            status: 'partial',
            data,
            error: new AppError('SETUP_SKILLS_FAILED', 'setupSkillsFailed').public(draft.language),
          },
          exitCode: 6,
        };
      }
    }
    return success(data);
  } catch (error) {
    return failure(error, draft.language, success(data));
  }
}

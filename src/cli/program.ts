import { Command, CommanderError, Help, Option } from 'commander';
import type { ErrorOptions } from 'commander';
import { configContext, selectConfigPath } from '../config/path.js';
import type { ConfigContext } from '../config/path.js';
import { readConfig } from '../config/read.js';
import type { ConfigDocument } from '../config/read.js';
import { prepareMutation, queryConfig } from '../config/manage.js';
import { configWriteTarget, saveConfig } from '../config/write.js';
import { localStatus } from '../config/status.js';
import { fieldAt, providers } from '../config/fields.js';
import { resolveField } from '../config/resolve.js';
import { AppError, failure } from '../errors.js';
import { resolveLanguage } from '../i18n/index.js';
import { helpText, text } from '../i18n/messages.js';
import type { Language, MessageKey } from '../i18n/messages.js';
import { display, execute, processChannels, reportOutputError } from '../output/index.js';
import type { Channels } from '../output/index.js';
import type { Format, RenderData, RenderOptions } from '../output/render.js';
import { renderConfig, renderStatus } from '../output/config.js';
import { renderExecution, renderSearch, renderFetch } from '../output/exa.js';
import {
  exaRequestLimit,
  prepareSearch,
  requestSearch,
  prepareFetch,
  requestFetch,
} from '../providers/exa.js';
import type { SearchOptions, FetchOptions } from '../providers/exa.js';
import { executeRequest } from '../execution.js';
import type { AttemptContext, AttemptResult } from '../execution.js';
import * as firecrawl from '../providers/firecrawl.js';
import * as context7 from '../providers/context7.js';
import * as jina from '../providers/jina.js';
import * as zhipu from '../providers/zhipu.js';
import { renderZhipu } from '../output/zhipu.js';
import * as zhipuMcp from '../providers/zhipu-mcp.js';
import { renderMcp } from '../output/zhipu-mcp.js';
import { renderJina } from '../output/jina.js';
import * as anysearch from '../providers/anysearch.js';
import * as anysearchOutput from '../output/anysearch.js';
import * as tinyfish from '../providers/tinyfish.js';
import * as deepseek from '../providers/deepseek.js';
import * as deepseekOutput from '../output/deepseek.js';
import * as tinyfishOutput from '../output/tinyfish.js';
import { renderContext7 } from '../output/context7.js';
import * as firecrawlOutput from '../output/firecrawl.js';
import type { ModelOptions } from '../providers/model-config.js';
import { combinedSearch, prepareCombinedSearch } from '../search.js';
import { renderCombinedSearch, renderSearchExecution } from '../output/search.js';
import { prepareRetrieval, retrieve } from '../retrieval.js';
import type { RetrievalOptions } from '../retrieval.js';
import { renderRetrieval } from '../output/retrieval.js';
import {
  prepareTavilySearch,
  prepareExtract,
  prepareMap,
  requestTavilySearch,
  requestExtract,
  requestMap,
  tavilyRequestLimits,
} from '../providers/tavily.js';
import type { TavilySearchOptions, ExtractOptions, MapOptions } from '../providers/tavily.js';
import { renderTavilySearch, renderExtract, renderMap } from '../output/tavily.js';
import { success } from '../result.js';
import type { ExitCode, JsonObject, JsonValue, Outcome } from '../result.js';
import { manageSkills, preflightSkills } from '../skills/manage.js';
import { parseTargets, skillTargets, targetPaths } from '../skills/targets.js';
import { requireTerminal, selectSkillTargets, terminalPrompts } from './prompts.js';
import { renderSkills } from '../output/skills.js';
import { SetupDraft, promptSetup, applySetup } from '../setup.js';
import { renderSetup, renderSetupPreview } from '../output/setup.js';
import { diagnoseAll, prepareDoctor, prepareDoctorBatch } from '../doctor.js';
import { renderDoctor, renderDoctorExecution } from '../output/doctor.js';
import { operations } from '../providers/operations.js';
import { TerminalHelp } from './help.js';

const argumentErrors: Record<string, MessageKey> = {
  'commander.unknownOption': 'unknownOption',
  'commander.unknownCommand': 'unknownCommand',
  'commander.missingArgument': 'missingArgument',
  'commander.optionMissingArgument': 'missingOptionValue',
  'commander.excessArguments': 'excessArguments',
};

const commandHelpKeys = new WeakMap<Command, MessageKey>();

export function commandPath(command: Command): string {
  return command.parent ? `${commandPath(command.parent)} ${command.name()}` : command.name();
}

class CliCommand extends Command {
  constructor(
    private language: () => Language,
    private select: (command: Command) => void,
    name?: string,
  ) {
    super(name);
    this.helpOption('-h, --help', text('en', 'help'));
    this.helpCommand(false);
    this.action(() => this.help());
    this.hook('preSubcommand', (_parent, command) => this.select(command));
  }

  override createCommand(name?: string): Command {
    return new CliCommand(this.language, this.select, name);
  }

  override createHelp(): Help {
    const help = Object.assign(new TerminalHelp(), this.configureHelp());
    help.styleTitle = (value) => helpText(value, this.language());
    help.commandDescription = (command) => {
      const key = commandHelpKeys.get(command);
      return key ? text(this.language(), key) : helpText(command.description(), this.language());
    };
    help.optionDescription = (option) => helpText(option.description, this.language());
    help.argumentDescription = (argument) => helpText(argument.description, this.language());
    help.subcommandDescription = (command) =>
      helpText(command.summary() || command.description(), this.language());
    return help;
  }

  override error(message: string, options: ErrorOptions = {}): never {
    const option = this.options.find((item) => message.includes(`'${item.flags}'`));
    const key =
      options.code === 'commander.excessArguments' && this.commands.length
        ? 'unknownCommand'
        : (argumentErrors[options.code ?? ''] ?? 'invalidArgument');
    throw new AppError('INVALID_ARGUMENT', key, {
      help: `${commandPath(this)} --help`,
      ...(option?.long ? { option: option.long } : {}),
    });
  }
}

export function addScalarOption(command: Command, option: Option): void {
  let seen = false;
  command.addOption(option);
  command.on(`option:${option.name()}`, () => {
    if (seen)
      throw new AppError('INVALID_ARGUMENT', 'duplicateOption', {
        option: option.long ?? option.flags,
      });
    seen = true;
  });
}

function unknownCommandBeforeEarlyExit(root: Command, args: string[]): Command | undefined {
  const earlyExitIndex = args.findIndex(
    (arg) =>
      arg === '--help' ||
      arg === '-h' ||
      arg === '--version' ||
      arg === '-V' ||
      arg.startsWith('-h') ||
      arg.startsWith('-V'),
  );
  if (earlyExitIndex < 0) return undefined;
  let command = root;
  for (let index = 0; index < earlyExitIndex; index++) {
    const arg = args[index]!;
    if (arg === '--') return undefined;
    if (arg.startsWith('-')) {
      const option = command.options.find(
        (item) =>
          item.long === arg ||
          item.short === arg ||
          (item.long !== undefined && arg.startsWith(`${item.long}=`)),
      );
      if (!option) return undefined;
      if (option.required && !arg.includes('=')) index++;
      continue;
    }
    if (!command.commands.length) return undefined;
    const child = command.commands.find(
      (item) => item.name() === arg || item.aliases().includes(arg),
    );
    if (!child) return command;
    command = child;
  }
  return undefined;
}

function explicitBoolean(command: Command, name: string): boolean | undefined {
  return command.getOptionValueSource(name) === 'cli'
    ? (command.opts()[name] as boolean)
    : undefined;
}

function addRequestOptions(command: Command): void {
  addScalarOption(
    command,
    new Option('--timeout <SECONDS>', text('en', 'timeoutOption')).argParser((value) => {
      const number = Number(value);
      if (!value.trim() || !Number.isFinite(number) || number <= 0)
        throw new AppError('INVALID_ARGUMENT', 'invalidTimeout', { option: '--timeout' });
      return number;
    }),
  );
  addScalarOption(command, new Option('--verbose', text('en', 'verbose')));
}

export function addContentOptions(command: Command): void {
  addScalarOption(
    command,
    new Option('--format <FORMAT>', text('en', 'format')).argParser((value) => {
      if (value !== 'json' && value !== 'markdown')
        throw new AppError('INVALID_ARGUMENT', 'invalidFormat', { option: '--format' });
      return value;
    }),
  );
  addScalarOption(
    command,
    new Option('--output <PATH>', text('en', 'output')).argParser((value) => {
      if (!value) throw new AppError('INVALID_ARGUMENT', 'emptyOutput', { option: '--output' });
      return value;
    }),
  );
  addRequestOptions(command);
}

export interface CliOptions {
  config?: ConfigContext;
  channels?: Channels;
}

export function createCli(version: string, options: CliOptions = {}) {
  const config = options.config ?? configContext();
  const channels = options.channels ?? processChannels();
  let selectedLanguage: Language | undefined;
  let document: ConfigDocument | undefined;
  let languageValues: Record<string, unknown> | undefined;
  let active: Command;
  const getDocument = (allowCreate = false) => {
    document ??= readConfig(selectConfigPath(config), allowCreate);
    return document;
  };
  const language = () => {
    if (selectedLanguage === undefined) {
      selectedLanguage = 'en';
      const values =
        languageValues ??
        document?.values ??
        (config.env.UNISEARCH_LANG === undefined ? getDocument().values : undefined);
      selectedLanguage = resolveLanguage(config, values);
    }
    return selectedLanguage;
  };
  let info = '';
  let exitCode: ExitCode = 0;
  const program = new CliCommand(
    language,
    (command) => {
      active = command;
    },
    'unisearch',
  )
    .description(text('en', 'description'))
    .version(`unisearch ${version}`, '-V, --version', text('en', 'version'))
    .configureOutput({
      writeOut: (value) => {
        info += value;
      },
    })
    .exitOverride();
  active = program;

  function format(): Format {
    if (active.parent?.name() === 'config' && ['list', 'get'].includes(active.name()))
      return 'json';
    const explicit = active.opts().format as Format | undefined;
    if (explicit) return explicit;
    if (active.opts().json) return 'json';
    return active.options.some((option) => option.long === '--format') ? 'markdown' : 'text';
  }

  async function runOperation<T extends JsonValue>(
    operation: () => Promise<Outcome<T>>,
    rendering: Pick<RenderOptions<T>, 'renderData' | 'execution' | 'textErrorPlacement'> = {},
    signal?: AbortSignal,
  ): Promise<void> {
    const common = active.opts<{ output?: string; verbose?: boolean }>();
    exitCode = await execute(
      operation,
      { ...common, format: format(), ...rendering, language: language(), cwd: config.cwd, signal },
      channels,
    );
  }

  async function runProviderRequest<T extends JsonValue>(
    provider: string,
    request: { timeout: number; retries: number },
    requestLimit: number,
    operation: (context: AttemptContext) => Promise<AttemptResult<T>>,
    renderData: RenderData<T>,
  ): Promise<void> {
    const abort = new AbortController();
    const cancel = () => abort.abort();
    const record: JsonObject = {};
    const ui = language();
    process.on('SIGINT', cancel);
    try {
      await runOperation(
        () =>
          executeRequest(operation, {
            provider,
            timeout: request.timeout,
            retries: request.retries,
            requestLimit,
            signal: abort.signal,
            language: ui,
            record,
          }),
        { renderData, execution: { data: record, markdown: renderExecution } },
        abort.signal,
      );
    } finally {
      process.off('SIGINT', cancel);
    }
  }

  const management = program.command('config').description(text('en', 'configCommand'));
  program
    .command('doctor')
    .summary(text('en', 'doctorSummary'))
    .description(text('en', 'doctorCommand'))
    .argument('[PROVIDER]', text('en', 'doctorProviderArgument'))
    .action(async (provider: string | undefined) => {
      const ui = language();
      const values = getDocument().values;
      const anonymous = new Set<'ctx7' | 'anysearch' | 'jina'>();
      for (const provider of ['ctx7', 'anysearch', 'jina'] as const) {
        const credential = resolveField(
          values,
          config.env,
          fieldAt(`providers.${provider}.api_key`),
        );
        if (credential.value === undefined && !credential.problems.length) anonymous.add(provider);
      }
      const timeout = active.opts().timeout as number | undefined;
      const plan =
        provider === undefined
          ? prepareDoctorBatch(timeout, values, config.env, ui)
          : prepareDoctor(provider, timeout, values, config.env, ui);
      const singleProvider = 'check' in plan ? plan.provider : undefined;
      const abort = new AbortController();
      const cancel = () => abort.abort();
      const record: JsonObject = 'check' in plan ? { check: plan.check } : {};
      process.on('SIGINT', cancel);
      try {
        await runOperation(
          () =>
            'checks' in plan
              ? diagnoseAll(plan, abort.signal, ui, record)
              : executeRequest((context) => plan.request(context), {
                  ...plan,
                  signal: abort.signal,
                  language: ui,
                  record,
                }),
          {
            renderData: (data, language) => renderDoctor(data, language, { anonymous }),
            textErrorPlacement: 'before-data',
            execution: {
              data: record,
              markdown: (value, language) => renderDoctorExecution(value, language, singleProvider),
              heading: false,
            },
          },
          abort.signal,
        );
      } finally {
        process.off('SIGINT', cancel);
      }
    });
  program
    .command('setup')
    .summary(text('en', 'setupSummary'))
    .description(text('en', 'setupCommand'))
    .action(async () => {
      requireTerminal();
      const loaded = getDocument(true);
      const draft = new SetupDraft(loaded, config, language());
      const abort = new AbortController();
      const cancel = () => abort.abort();
      process.on('SIGINT', cancel);
      try {
        let path: string;
        try {
          await promptSetup(
            draft,
            terminalPrompts(abort.signal),
            (draft) => channels.stderr(renderSetupPreview(draft)),
            (ui) => {
              selectedLanguage = ui;
            },
          );
          path = await configWriteTarget(loaded.path);
          await preflightSkills(draft.targets(), undefined, path);
        } catch (error) {
          exitCode = await display(
            failure(error, language(), success(draft.pending())),
            { format: format(), language: language(), renderText: renderSetup },
            channels,
          );
          return;
        }
        exitCode = await execute(
          () => applySetup(draft, path, abort.signal),
          {
            format: format(),
            language: language(),
            cwd: config.cwd,
            signal: abort.signal,
            previous: success(draft.pending()),
            renderText: renderSetup,
          },
          channels,
        );
      } finally {
        process.off('SIGINT', cancel);
      }
    });
  const skills = program
    .command('skills')
    .summary(text('en', 'skillsSummary'))
    .description(text('en', 'skillsCommand'));
  for (const [action, key] of [
    ['install', 'skillsInstall'],
    ['status', 'skillsStatus'],
    ['update', 'skillsUpdate'],
    ['remove', 'skillsRemove'],
  ] as const) {
    const command = skills.command(action).description(text('en', key));
    addScalarOption(
      command,
      new Option(
        '--targets <IDS>',
        text('en', action === 'status' ? 'skillsStatusTargets' : 'skillsWriteTargets'),
      ),
    );
    command.action(async (opts: { targets?: string }) => {
      const abort = new AbortController();
      const cancel = () => abort.abort();
      process.on('SIGINT', cancel);
      try {
        const ui = language();
        let ids;
        if (opts.targets !== undefined) ids = parseTargets(opts.targets);
        else if (action === 'status') ids = skillTargets.map((item) => item[0]);
        else {
          requireTerminal();
          ids = await selectSkillTargets(terminalPrompts(abort.signal), ui);
        }
        const targets = targetPaths(ids, config);
        if (action !== 'status') await preflightSkills(targets);
        await runOperation(
          () => manageSkills(action, targets, ui, abort.signal),
          { renderData: (data, language) => renderSkills(data, language) },
          abort.signal,
        );
      } finally {
        process.off('SIGINT', cancel);
      }
    });
  }
  management
    .command('path')
    .description(text('en', 'configPathCommand'))
    .action(async () => {
      languageValues = {};
      const selected = selectConfigPath(config);
      await runOperation(async () => success({ ...selected }), {
        renderData: (data, ui) => renderConfig('path', data, ui),
      });
    });
  const configList = management.command('list').description(text('en', 'configListCommand'));
  addScalarOption(configList, new Option('--all', text('en', 'configListAllOption')));
  configList.action(async (opts: { all?: boolean }) => {
    const loaded = getDocument();
    const data = queryConfig(loaded, config.env, language(), undefined, opts.all === true);
    await runOperation(async () => success(data));
  });
  management
    .command('get')
    .description(text('en', 'configGetCommand'))
    .argument('<KEY>', text('en', 'configGetKeyArgument'))
    .action(async (key: string) => {
      const loaded = getDocument();
      const data = queryConfig(loaded, config.env, language(), key);
      await runOperation(async () => success(data));
    });
  for (const action of ['set', 'unset'] as const) {
    const command = management
      .command(action)
      .summary(text('en', action === 'set' ? 'configSetSummary' : 'configUnsetCommand'))
      .description(text('en', action === 'set' ? 'configSetCommand' : 'configUnsetCommand'))
      .argument(
        '<KEY>',
        text('en', action === 'set' ? 'configSetKeyArgument' : 'configUnsetKeyArgument'),
      );
    if (action === 'set') command.argument('<VALUE>', text('en', 'valueArgument'));
    command.action(async (key: string, input: unknown) => {
      const loaded = getDocument(action === 'set');
      const mutation = prepareMutation(
        loaded,
        config.env,
        language(),
        key,
        action === 'set' ? (input as string) : undefined,
      );
      const abort = new AbortController();
      const cancel = () => abort.abort();
      process.on('SIGINT', cancel);
      try {
        const target = await configWriteTarget(loaded.path);
        await runOperation(
          () => saveConfig(mutation, target, language(), abort.signal),
          {
            renderData: (data, ui) => renderConfig(action, data, ui),
          },
          abort.signal,
        );
      } finally {
        process.off('SIGINT', cancel);
      }
    });
  }
  program
    .command('status')
    .summary(text('en', 'statusSummary'))
    .description(text('en', 'statusCommand'))
    .action(async () => {
      const loaded = getDocument();
      const data = localStatus(loaded.values, config.env, language(), operations);
      await runOperation(async () => success(data), { renderData: renderStatus });
    });

  for (const operation of ['fetch', 'map'] as const) {
    const command = program
      .command(operation)
      .summary(text('en', operation === 'fetch' ? 'fetchSummary' : 'mapCommand'))
      .description(text('en', operation === 'fetch' ? 'fetchCommand' : 'mapCommand'))
      .argument('<URL>', text('en', 'pageUrlArgument'));
    addScalarOption(command, new Option('--no-fallback', text('en', 'noServiceFallback')));
    if (operation === 'map')
      addScalarOption(command, new Option('--limit <N>', text('en', 'retrievalLimit')));
    command.action(async (url: string, options: RetrievalOptions) => {
      const ui = language();
      const plan = prepareRetrieval(
        operation,
        url,
        {
          ...options,
          fallback: explicitBoolean(command, 'fallback'),
          timeout: active.opts().timeout,
        },
        getDocument().values,
        config.env,
        ui,
      );
      const abort = new AbortController();
      const cancel = () => abort.abort();
      const record: JsonObject = {};
      process.on('SIGINT', cancel);
      try {
        await runOperation(
          () => retrieve(plan, abort.signal, ui, record),
          {
            renderData: renderRetrieval,
            execution: { data: record, markdown: renderSearchExecution },
          },
          abort.signal,
        );
      } finally {
        process.off('SIGINT', cancel);
      }
    });
  }

  const model = program
    .command('search')
    .summary(text('en', 'searchSummary'))
    .description(text('en', 'modelSearch'))
    .argument('<QUERY>', text('en', 'queryArgument'));
  for (const [flags, key] of [
    ['--model <ID>', 'modelOption'],
    ['--effort <LEVEL>', 'effortOption'],
    ['--extra-sources <IDS>', 'extraSourcesOption'],
    ['--stream', 'streamOption'],
    ['--no-stream', 'noStreamOption'],
    ['--no-fallback', 'noFallbackOption'],
  ] as const)
    addScalarOption(model, new Option(flags, text('en', key)));
  let streamSeen = false;
  for (const name of ['stream', 'no-stream'])
    model.on(`option:${name}`, () => {
      if (streamSeen)
        throw new AppError('INVALID_ARGUMENT', 'streamConflict', {
          option: '--stream/--no-stream',
        });
      streamSeen = true;
    });
  model.action(async (query: string, options: ModelOptions) => {
    const loaded = getDocument();
    const ui = language();
    const plan = prepareCombinedSearch(
      query,
      {
        ...options,
        stream: explicitBoolean(model, 'stream'),
        fallback: explicitBoolean(model, 'fallback'),
        timeout: active.opts().timeout,
      },
      loaded.values,
      config.env,
      ui,
    );
    const abort = new AbortController();
    const cancel = () => abort.abort();
    const record: JsonObject = {};
    process.on('SIGINT', cancel);
    try {
      await runOperation(
        () => combinedSearch(plan, abort.signal, ui, record),
        {
          renderData: renderCombinedSearch,
          execution: { data: record, markdown: renderSearchExecution },
        },
        abort.signal,
      );
    } finally {
      process.off('SIGINT', cancel);
    }
  });

  const zhipuGroup = program.command('zhipu').description(text('en', 'zhipuCommand'));
  const zhipuSearch = zhipuGroup
    .command('search')
    .summary(text('en', 'exaSearch'))
    .description(text('en', 'zhipuSearch'))
    .argument('<QUERY>', text('en', 'queryArgument'));
  for (const [flags, key] of [
    ['--engine <NAME>', 'zhipuEngineOption'],
    ['--limit <N>', 'zhipuLimitOption'],
    ['--recency <VALUE>', 'zhipuRecencyOption'],
    ['--include-domains <FILTER>', 'zhipuDomainsOption'],
    ['--content-size <VALUE>', 'zhipuContentOption'],
  ] as const)
    addScalarOption(zhipuSearch, new Option(flags, text('en', key)));
  const zhipuFetch = zhipuGroup
    .command('fetch')
    .summary(text('en', 'pageFetchSummary'))
    .description(text('en', 'zhipuFetch'))
    .argument('<URL>', text('en', 'pageUrlArgument'));
  for (const [flags, key] of [
    ['--no-cache', 'zhipuNoCache'],
    ['--no-images', 'zhipuNoImages'],
    ['--include-images-summary', 'zhipuImagesSummary'],
    ['--include-links-summary', 'zhipuLinksSummary'],
  ] as const)
    addScalarOption(zhipuFetch, new Option(flags, text('en', key)));
  for (const [command, operation] of [
    [zhipuSearch, 'search'],
    [zhipuFetch, 'fetch'],
  ] as const)
    command.action(async (input: string, options: zhipu.SearchOptions & zhipu.FetchOptions) => {
      const ui = language();
      const request = zhipu.prepare(
        operation,
        input,
        { ...options, timeout: active.opts().timeout },
        getDocument().values,
        config.env,
        ui,
      );
      await runProviderRequest(
        'zhipu',
        request,
        zhipu.requestLimits[operation],
        (context) => zhipu.request(request, context, ui),
        (data, language) => renderZhipu(data, language),
      );
    });

  const tinyfishGroup = program.command('tinyfish').description(text('en', 'tinyfishCommand'));
  const tinyfishSearch = tinyfishGroup
    .command('search')
    .summary(text('en', 'tinyfishSearchSummary'))
    .description(text('en', 'tinyfishSearch'))
    .argument('<QUERY>', text('en', 'queryArgument'));
  for (const [flags, key] of [
    ['--purpose <TEXT>', 'tinyfishSearchPurpose'],
    ['--location <CODE>', 'tinyfishLocation'],
    ['--language <CODE>', 'tinyfishLanguage'],
    ['--include-domains <DOMAINS>', 'tinyfishIncludeDomainsOption'],
    ['--exclude-domains <DOMAINS>', 'tinyfishExcludeDomainsOption'],
    ['--recency-minutes <N>', 'tinyfishRecency'],
    ['--after-date <DATE>', 'tinyfishAfter'],
    ['--before-date <DATE>', 'tinyfishBefore'],
    ['--search-type <TYPE>', 'tinyfishType'],
    ['--pub-year-min <N>', 'tinyfishYearMin'],
    ['--pub-year-max <N>', 'tinyfishYearMax'],
    ['--page <N>', 'tinyfishPage'],
  ] as const)
    addScalarOption(tinyfishSearch, new Option(flags, text('en', key)));
  tinyfishSearch.action(async (query: string, options: tinyfish.SearchOptions) => {
    const ui = language();
    const request = tinyfish.prepareSearch(
      query,
      { ...options, timeout: active.opts().timeout },
      getDocument().values,
      config.env,
      ui,
    );
    await runProviderRequest(
      'tinyfish',
      request,
      tinyfish.requestLimits.search,
      (context) => tinyfish.request(request, context, ui),
      (data, ui) => tinyfishOutput.renderSearch(data, ui),
    );
  });
  const tinyfishFetch = tinyfishGroup
    .command('fetch')
    .summary(text('en', 'batchFetchSummary'))
    .description(text('en', 'tinyfishFetch'))
    .argument('<URL...>', text('en', 'pageUrlArgument'));
  for (const [flags, key] of [
    ['--purpose <TEXT>', 'tinyfishFetchPurpose'],
    ['--ttl <SECONDS>', 'tinyfishTtl'],
    ['--per-url-timeout-ms <N>', 'tinyfishUrlTimeoutOption'],
    ['--include-links', 'tinyfishLinksOption'],
    ['--include-image-links', 'tinyfishImagesOption'],
    ['--include-metadata', 'tinyfishMetadataOption'],
  ] as const)
    addScalarOption(tinyfishFetch, new Option(flags, text('en', key)));
  for (const [flags, key] of [
    ['--target-selector <CSS>', 'tinyfishTarget'],
    ['--remove-selector <CSS>', 'tinyfishRemove'],
  ] as const)
    tinyfishFetch.addOption(
      new Option(flags, text('en', key)).argParser((value: string, previous: string[] = []) => [
        ...previous,
        value,
      ]),
    );
  tinyfishFetch.action(async (urls: string[], options: tinyfish.FetchOptions) => {
    const ui = language();
    const request = tinyfish.prepareFetch(
      urls,
      { ...options, timeout: active.opts().timeout },
      getDocument().values,
      config.env,
      ui,
    );
    await runProviderRequest(
      'tinyfish',
      request,
      tinyfish.requestLimits.fetch,
      (context) => tinyfish.request(request, context, ui),
      tinyfishOutput.renderFetch,
    );
  });

  const deepseekGroup = program.command('deepseek').description(text('en', 'deepseekCommand'));
  const deepseekSearch = deepseekGroup
    .command('search')
    .summary(text('en', 'deepseekSearch'))
    .description(text('en', 'deepseekSearch'))
    .argument('<QUERY>', text('en', 'queryArgument'));
  for (const [flags, key] of [
    ['--limit <N>', 'deepseekLimitOption'],
    ['--include-text', 'textOption'],
    ['--question <TEXT>', 'deepseekQuestion'],
    ['--include-domains <DOMAINS>', 'deepseekIncludeDomains'],
    ['--exclude-domains <DOMAINS>', 'deepseekExcludeDomains'],
    ['--language <CODE>', 'deepseekLanguage'],
    ['--after-date <DATE>', 'deepseekAfter'],
    ['--before-date <DATE>', 'deepseekBefore'],
  ] as const)
    addScalarOption(deepseekSearch, new Option(flags, text('en', key)));
  deepseekSearch.action(async (query: string, options: deepseek.SearchOptions) => {
    const ui = language();
    const request = deepseek.prepareSearch(
      query,
      { ...options, timeout: active.opts().timeout },
      getDocument().values,
      config.env,
      ui,
    );
    await runProviderRequest(
      'deepseek',
      request,
      deepseek.requestLimits.search,
      (context) => deepseek.request(request, context, ui),
      (data, ui) => deepseekOutput.renderSearch(data, ui),
    );
  });
  const deepseekFetch = deepseekGroup
    .command('fetch')
    .summary(text('en', 'pageFetchSummary'))
    .description(text('en', 'pageFetchSummary'))
    .argument('<URL>', text('en', 'pageUrlArgument'));
  deepseekFetch.action(async (url: string, options: deepseek.FetchOptions) => {
    const ui = language();
    const request = deepseek.prepareFetch(
      url,
      { ...options, timeout: active.opts().timeout },
      getDocument().values,
      config.env,
      ui,
    );
    await runProviderRequest(
      'deepseek',
      request,
      deepseek.requestLimits.fetch,
      (context) => deepseek.request(request, context, ui),
      deepseekOutput.renderFetch,
    );
  });

  const mcpGroup = program.command('zhipu-mcp').description(text('en', 'mcpCommand'));
  async function runMcp(
    operation: zhipuMcp.Operation,
    target: string,
    options: zhipuMcp.Options = {},
  ) {
    const ui = language();
    const request = zhipuMcp.prepare(
      operation,
      target,
      { ...options, timeout: active.opts().timeout },
      getDocument().values,
      config.env,
      ui,
    );
    await runProviderRequest(
      'zhipu-mcp',
      request,
      zhipuMcp.requestLimits[operation],
      (context) => zhipuMcp.request(request, context, ui),
      (data, language) => renderMcp(data, language, operation),
    );
  }
  mcpGroup
    .command('search')
    .summary(text('en', 'exaSearch'))
    .description(text('en', 'mcpSearch'))
    .argument('<QUERY>', text('en', 'queryArgument'))
    .action(async (query: string) => runMcp('search', query));
  mcpGroup
    .command('fetch')
    .summary(text('en', 'pageFetchSummary'))
    .description(text('en', 'mcpFetch'))
    .argument('<URL>', text('en', 'pageUrlArgument'))
    .action(async (url: string) => runMcp('fetch', url));
  mcpGroup
    .command('docs')
    .summary(text('en', 'repositoryDocsSummary'))
    .description(text('en', 'mcpDocs'))
    .argument('<REPO>', text('en', 'mcpRepo'))
    .argument('<QUERY>', text('en', 'queryArgument'))
    .action(async (repo: string, query: string) => runMcp('docs', repo, { query }));
  const mcpTree = mcpGroup
    .command('tree')
    .summary(text('en', 'repositoryTreeSummary'))
    .description(text('en', 'mcpTree'))
    .argument('<REPO>', text('en', 'mcpRepo'));
  addScalarOption(mcpTree, new Option('--path <PATH>', text('en', 'mcpTreePath')));
  mcpTree.action(async (repo: string, options: { path?: string }) => runMcp('tree', repo, options));
  mcpGroup
    .command('read-file')
    .summary(text('en', 'repositoryFileSummary'))
    .description(text('en', 'mcpReadFile'))
    .argument('<REPO>', text('en', 'mcpRepo'))
    .argument('<PATH>', text('en', 'mcpFilePath'))
    .action(async (repo: string, path: string) => runMcp('read-file', repo, { path }));

  const jinaGroup = program.command('jina').description(text('en', 'jinaCommand'));
  const jinaFetch = jinaGroup
    .command('fetch')
    .summary(text('en', 'pageFetchSummary'))
    .description(text('en', 'jinaFetch'))
    .argument('<URL>', text('en', 'pageUrlArgument'));
  commandHelpKeys.set(jinaFetch, 'jinaFetch');
  for (const [flags, key] of [
    ['--target-selector <CSS>', 'jinaTarget'],
    ['--remove-selector <CSS>', 'jinaRemove'],
    ['--wait-for-selector <CSS>', 'jinaWait'],
    ['--no-cache', 'jinaNoCache'],
    ['--max-tokens <N>', 'jinaMaxTokens'],
  ] as const)
    addScalarOption(jinaFetch, new Option(flags, text('en', key)));
  jinaFetch.action(async (url: string, options: jina.FetchOptions) => {
    const ui = language();
    const request = jina.prepareFetch(
      url,
      { ...options, timeout: active.opts().timeout },
      getDocument().values,
      config.env,
      ui,
    );
    await runProviderRequest(
      'jina',
      request,
      jina.requestLimit,
      (context) => jina.request(request, context, ui),
      (data, language) => renderJina(data, language),
    );
  });
  const jinaSearch = jinaGroup
    .command('search')
    .summary(text('en', 'jinaSearchSummary'))
    .description(text('en', 'jinaSearch'))
    .argument('<QUERY>', text('en', 'queryArgument'));
  for (const [flags, key] of [
    ['--limit <N>', 'jinaLimit'],
    ['--include-text', 'textOption'],
    ['--country <CODE>', 'jinaCountry'],
    ['--language <CODE>', 'jinaLanguage'],
    ['--search-type <TYPE>', 'jinaSearchType'],
  ] as const)
    addScalarOption(jinaSearch, new Option(flags, text('en', key)));
  jinaSearch.action(async (query: string, options: jina.SearchOptions) => {
    const ui = language();
    const request = jina.prepareSearch(
      query,
      { ...options, timeout: active.opts().timeout },
      getDocument().values,
      config.env,
      ui,
    );
    await runProviderRequest(
      'jina',
      request,
      jina.requestLimit,
      (context) => jina.request(request, context, ui),
      (data, language) => renderJina(data, language),
    );
  });

  const anysearchGroup = program
    .command('anysearch')
    .summary(text('en', 'anysearchSummary'))
    .description(text('en', 'anysearchCommand'));
  const anysearchSearch = anysearchGroup
    .command('search')
    .summary(text('en', 'anysearchSearchSummary'))
    .description(text('en', 'anysearchSearch'))
    .argument('<QUERY>', text('en', 'queryArgument'));
  for (const [flags, key] of [
    ['--limit <N>', 'anysearchLimitOption'],
    ['--tag <TAG>', 'anysearchTagOption'],
    ['--params <JSON>', 'anysearchParamsOption'],
    ['--zone <ZONE>', 'anysearchZoneOption'],
    ['--language <LANGUAGE>', 'anysearchLanguageOption'],
  ] as const)
    addScalarOption(anysearchSearch, new Option(flags, text('en', key)));
  anysearchSearch.action(async (query: string, options: anysearch.SearchOptions) => {
    const ui = language();
    const request = anysearch.prepare(
      'search',
      query,
      { ...options, timeout: active.opts().timeout },
      getDocument().values,
      config.env,
      ui,
    );
    await runProviderRequest(
      'anysearch',
      request,
      anysearch.requestLimit,
      (context) => anysearch.request(request, context, ui),
      (data, ui) => anysearchOutput.renderSearch(data, ui),
    );
  });
  anysearchGroup
    .command('domains')
    .summary(text('en', 'anysearchDomainsSummary'))
    .description(text('en', 'anysearchDomains'))
    .argument('[DOMAIN]', text('en', 'anysearchDomain'))
    .action(async (domain: string | undefined) => {
      const ui = language();
      if (domain === undefined) {
        const data = anysearch.catalog(getDocument().values, config.env, ui);
        const abort = new AbortController();
        const cancel = () => abort.abort();
        process.on('SIGINT', cancel);
        try {
          await runOperation(
            async () => success(data),
            { renderData: anysearchOutput.renderDomains },
            abort.signal,
          );
        } finally {
          process.off('SIGINT', cancel);
        }
        return;
      }
      const request = anysearch.prepare(
        'domains',
        domain,
        { timeout: active.opts().timeout },
        getDocument().values,
        config.env,
        ui,
      );
      await runProviderRequest(
        'anysearch',
        request,
        anysearch.requestLimit,
        (context) => anysearch.request(request, context, ui),
        anysearchOutput.renderDomains,
      );
    });
  anysearchGroup
    .command('extract')
    .summary(text('en', 'pageFetchSummary'))
    .description(text('en', 'anysearchExtract'))
    .argument('<URL>', text('en', 'pageUrlArgument'))
    .action(async (url: string) => {
      const ui = language();
      const request = anysearch.prepare(
        'extract',
        url,
        { timeout: active.opts().timeout },
        getDocument().values,
        config.env,
        ui,
      );
      await runProviderRequest(
        'anysearch',
        request,
        anysearch.requestLimit,
        (context) => anysearch.request(request, context, ui),
        anysearchOutput.renderExtract,
      );
    });

  const ctx7 = program.command('ctx7').description(text('en', 'ctx7Command'));
  for (const operation of ['library', 'docs'] as const) {
    ctx7
      .command(operation)
      .description(text('en', operation === 'library' ? 'ctx7Library' : 'ctx7Docs'))
      .argument(
        operation === 'library' ? '<NAME>' : '<LIBRARY_ID>',
        text('en', operation === 'library' ? 'ctx7Name' : 'ctx7Id'),
      )
      .argument('<QUERY>', text('en', 'queryArgument'))
      .action(async (target: string, query: string) => {
        const ui = language();
        const request = context7.prepare(
          operation,
          target,
          query,
          active.opts().timeout,
          getDocument().values,
          config.env,
          ui,
        );
        await runProviderRequest(
          'ctx7',
          request,
          context7.requestLimit,
          (context) => context7.request(request, context, ui),
          renderContext7,
        );
      });
  }

  const exa = program.command('exa').description(text('en', 'exaCommand'));
  const search = exa
    .command('search')
    .description(text('en', 'exaSearch'))
    .argument('<QUERY>', text('en', 'queryArgument'));
  for (const [flags, key] of [
    ['--limit <N>', 'limitOption'],
    ['--search-type <TYPE>', 'searchTypeOption'],
    ['--include-text', 'textOption'],
    ['--include-highlights', 'highlightsOption'],
    ['--published-after <DATE>', 'publishedOption'],
    ['--category <NAME>', 'categoryOption'],
    ['--include-domains <DOMAINS>', 'includeDomainsOption'],
    ['--exclude-domains <DOMAINS>', 'excludeDomainsOption'],
  ] as const)
    addScalarOption(search, new Option(flags, text('en', key)));
  search.action(async (query: string, options: SearchOptions) => {
    const loaded = getDocument();
    const ui = language();
    const request = prepareSearch(
      query,
      { ...options, timeout: active.opts().timeout },
      loaded.values,
      config.env,
      ui,
    );
    await runProviderRequest(
      'exa',
      request,
      exaRequestLimit,
      (context) => requestSearch(request, context, ui),
      (data, ui) => renderSearch(data, ui),
    );
  });
  const exaFetchCommand = exa
    .command('fetch')
    .summary(text('en', 'batchFetchSummary'))
    .description(text('en', 'exaFetch'))
    .argument('<URL...>', text('en', 'pageUrlArgument'));
  for (const [flags, key] of [
    ['--max-length <N>', 'exaMaxLength'],
    ['--include-highlights', 'highlightsOption'],
    ['--highlights-query <TEXT>', 'exaHighlightsQuery'],
  ] as const)
    addScalarOption(exaFetchCommand, new Option(flags, text('en', key)));
  exaFetchCommand.action(async (urls: string[], options: FetchOptions) => {
    const ui = language();
    const request = prepareFetch(
      urls,
      { ...options, timeout: active.opts().timeout },
      getDocument().values,
      config.env,
      ui,
    );
    await runProviderRequest(
      'exa',
      request,
      exaRequestLimit,
      (context) => requestFetch(request, context, ui),
      renderFetch,
    );
  });

  const firecrawlGroup = program
    .command('firecrawl')
    .summary(text('en', 'firecrawlSummary'))
    .description(text('en', 'firecrawlCommand'));
  const firecrawlSearch = firecrawlGroup
    .command('search')
    .summary(text('en', 'exaSearch'))
    .description(text('en', 'firecrawlSearch'))
    .argument('<QUERY>', text('en', 'queryArgument'));
  for (const [flags, key] of [
    ['--limit <N>', 'limitOption'],
    ['--categories <TYPE>', 'categoriesOption'],
    ['--tbs <VALUE>', 'tbsOption'],
    ['--location <TEXT>', 'locationOption'],
    ['--country <CODE>', 'countryOption'],
  ] as const)
    addScalarOption(firecrawlSearch, new Option(flags, text('en', key)));
  addScalarOption(firecrawlSearch, new Option('--include-text', text('en', 'firecrawlTextOption')));
  firecrawlSearch.action(async (query: string, options: firecrawl.SearchOptions) => {
    const loaded = getDocument();
    const ui = language();
    const request = firecrawl.prepareSearch(
      query,
      {
        ...options,
        timeout: active.opts().timeout,
      },
      loaded.values,
      config.env,
      ui,
    );
    await runProviderRequest(
      'firecrawl',
      request,
      firecrawl.requestLimits.search,
      (context) => firecrawl.requestSearch(request, context, ui),
      (data, ui) => firecrawlOutput.renderSearch(data, ui),
    );
  });

  const firecrawlScrape = firecrawlGroup
    .command('scrape')
    .summary(text('en', 'pageFetchSummary'))
    .description(text('en', 'firecrawlScrape'))
    .argument('<URL>', text('en', 'pageUrlArgument'));
  for (const [flags, key] of [
    ['--max-age <SECONDS>', 'maxAgeOption'],
    ['--wait-for <SECONDS>', 'waitForOption'],
  ] as const)
    addScalarOption(firecrawlScrape, new Option(flags, text('en', key)));
  addScalarOption(
    firecrawlScrape,
    new Option('--no-only-main-content', text('en', 'noMainContentOption')),
  );
  for (const [flag, key] of [
    ['include-tag', 'includeTagOption'],
    ['exclude-tag', 'excludeTagOption'],
  ] as const)
    firecrawlScrape.addOption(
      new Option(`--${flag} <SELECTOR>`, text('en', key)).argParser(
        (value, previous: string[] = []) => [...previous, value],
      ),
    );
  firecrawlScrape.action(async (url: string, options: firecrawl.ScrapeOptions) => {
    const loaded = getDocument();
    const ui = language();
    const request = firecrawl.prepareScrape(
      url,
      {
        ...options,
        timeout: active.opts().timeout,
      },
      loaded.values,
      config.env,
      ui,
    );
    await runProviderRequest(
      'firecrawl',
      request,
      firecrawl.requestLimits.scrape,
      (context) => firecrawl.requestScrape(request, context, ui),
      firecrawlOutput.renderScrape,
    );
  });

  const firecrawlMap = firecrawlGroup
    .command('map')
    .summary(text('en', 'siteMapSummary'))
    .description(text('en', 'firecrawlMap'))
    .argument('<URL>', text('en', 'pageUrlArgument'));
  for (const [flags, key] of [
    ['--limit <N>', 'mapLimitOption'],
    ['--search <TEXT>', 'mapSearchOption'],
    ['--sitemap <MODE>', 'sitemapOption'],
    ['--ignore-cache', 'ignoreCacheOption'],
  ] as const)
    addScalarOption(firecrawlMap, new Option(flags, text('en', key)));
  addScalarOption(firecrawlMap, new Option('--include-subdomains', text('en', 'subdomainsOption')));
  addScalarOption(
    firecrawlMap,
    new Option('--no-ignore-query-parameters', text('en', 'noQueryParametersOption')),
  );
  firecrawlMap.action(async (url: string, options: firecrawl.MapOptions) => {
    const loaded = getDocument();
    const ui = language();
    const request = firecrawl.prepareMap(
      url,
      {
        ...options,
        timeout: active.opts().timeout,
      },
      loaded.values,
      config.env,
      ui,
    );
    await runProviderRequest(
      'firecrawl',
      request,
      firecrawl.requestLimits.map,
      (context) => firecrawl.requestMap(request, context, ui),
      firecrawlOutput.renderMap,
    );
  });

  const tavily = program
    .command('tavily')
    .summary(text('en', 'tavilySummary'))
    .description(text('en', 'tavilyCommand'));
  const tavilySearch = tavily
    .command('search')
    .summary(text('en', 'tavilySearchCommand'))
    .description(text('en', 'tavilySearchDescription'))
    .argument('<QUERY>', text('en', 'queryArgument'));
  const extract = tavily
    .command('extract')
    .summary(text('en', 'batchFetchSummary'))
    .description(text('en', 'tavilyExtractCommand'))
    .argument('<URL...>', text('en', 'urlArgument'));
  const map = tavily
    .command('map')
    .summary(text('en', 'tavilyMapCommand'))
    .description(text('en', 'tavilyMapDescription'))
    .argument('<URL>', text('en', 'urlArgument'));
  for (const [flags, key] of [
    ['--limit <N>', 'tavilySearchLimitOption'],
    ['--search-depth <TYPE>', 'tavilySearchDepthOption'],
    ['--topic <TOPIC>', 'tavilyTopicOption'],
    ['--time-range <RANGE>', 'tavilyTimeOption'],
    ['--start-date <DATE>', 'tavilyStartOption'],
    ['--end-date <DATE>', 'tavilyEndOption'],
    ['--include-domains <LIST>', 'tavilyIncludeOption'],
    ['--exclude-domains <LIST>', 'tavilyExcludeOption'],
    ['--include-text', 'textOption'],
  ] as const)
    addScalarOption(tavilySearch, new Option(flags, text('en', key)));
  for (const [flags, key] of [
    ['--extract-depth <TYPE>', 'tavilyExtractDepthOption'],
    ['--query <TEXT>', 'tavilyQueryOption'],
    ['--chunks-per-source <N>', 'tavilyChunksOption'],
  ] as const)
    addScalarOption(extract, new Option(flags, text('en', key)));
  for (const [flags, key] of [
    ['--limit <N>', 'tavilyMapLimitOption'],
    ['--max-depth <N>', 'tavilyMaxDepthOption'],
    ['--max-breadth <N>', 'tavilyMaxBreadthOption'],
    ['--instructions <TEXT>', 'tavilyInstructionsOption'],
  ] as const)
    addScalarOption(map, new Option(flags, text('en', key)));
  for (const [flags, key] of [
    ['--select-path <REGEX>', 'tavilySelectPathOption'],
    ['--exclude-path <REGEX>', 'tavilyExcludePathOption'],
    ['--select-domain <REGEX>', 'tavilySelectDomainOption'],
    ['--exclude-domain <REGEX>', 'tavilyExcludeDomainOption'],
  ] as const)
    map.addOption(
      new Option(flags, text('en', key)).argParser((value: string, previous: string[] = []) => [
        ...previous,
        value,
      ]),
    );
  addScalarOption(map, new Option('--allow-external', text('en', 'tavilyExternalOption')));
  tavilySearch.action(async (query: string, options: TavilySearchOptions) => {
    const request = prepareTavilySearch(
      query,
      { ...options, timeout: active.opts().timeout },
      getDocument().values,
      config.env,
      language(),
    );
    await runProviderRequest(
      'tavily',
      request,
      tavilyRequestLimits[request.operation],
      (context) => requestTavilySearch(request, context, language()),
      (data, ui) => renderTavilySearch(data, ui),
    );
  });
  extract.action(async (urls: string[], options: ExtractOptions) => {
    const request = prepareExtract(
      urls,
      { ...options, timeout: active.opts().timeout },
      getDocument().values,
      config.env,
      language(),
    );
    await runProviderRequest(
      'tavily',
      request,
      tavilyRequestLimits[request.operation],
      (context) => requestExtract(request, context, language()),
      renderExtract,
    );
  });
  map.action(async (url: string, options: MapOptions) => {
    const request = prepareMap(
      url,
      {
        ...options,
        timeout: active.opts().timeout,
      },
      getDocument().values,
      config.env,
      language(),
    );
    await runProviderRequest(
      'tavily',
      request,
      tavilyRequestLimits.map,
      (context) => requestMap(request, context, language()),
      renderMap,
    );
  });

  for (const command of program.commands) {
    if (['status', 'doctor'].includes(command.name())) {
      addScalarOption(command, new Option('--json', text('en', 'jsonOption')));
      if (command.name() === 'doctor') addRequestOptions(command);
    } else if (['search', 'fetch', 'map'].includes(command.name())) addContentOptions(command);
    else if (command.name() !== 'config' && command.name() !== 'skills')
      for (const operation of command.commands) addContentOptions(operation);
  }

  const commandOrder = [
    'setup',
    'status',
    'doctor',
    'config',
    'skills',
    'search',
    'fetch',
    'map',
    ...providers.filter((provider) => provider !== 'model'),
  ];
  (program.commands as Command[]).sort(
    (a, b) => commandOrder.indexOf(a.name()) - commandOrder.indexOf(b.name()),
  );
  (jinaGroup.commands as Command[]).sort(
    (a, b) => ['search', 'fetch'].indexOf(a.name()) - ['search', 'fetch'].indexOf(b.name()),
  );

  async function run(argv: string[]): Promise<ExitCode> {
    let forceTextError = false;
    try {
      const unknown = unknownCommandBeforeEarlyExit(program, argv);
      if (unknown) {
        forceTextError = true;
        throw new AppError('INVALID_ARGUMENT', 'unknownCommand', {
          help: `${commandPath(unknown)} --help`,
        });
      }
      await program.parseAsync(argv, { from: 'user' });
    } catch (error) {
      if (!(error instanceof CommanderError && error.exitCode === 0)) {
        const invalidFormat =
          error instanceof AppError &&
          error.details?.option === '--format' &&
          active.options.some((option) => option.long === '--format');
        const outputFormat: Format = forceTextError || invalidFormat ? 'text' : format();
        let problem = error;
        let ui: Language;
        try {
          ui = language();
        } catch (languageError) {
          problem = languageError;
          ui = 'en';
        }
        return display(failure(problem, ui), { language: ui, format: outputFormat }, channels);
      }
    }
    try {
      if (info) await channels.stdout(info);
      return exitCode;
    } catch (error) {
      return reportOutputError(error, channels, selectedLanguage ?? 'en');
    }
  }
  return { program, run, runOperation };
}

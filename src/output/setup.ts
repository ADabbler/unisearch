import { colon } from '../i18n/messages.js';
import type { Language } from '../i18n/messages.js';
import type { JsonObject, Result } from '../result.js';
import type { SetupData, SetupDraft } from '../setup.js';
import type { TargetResult } from '../skills/manage.js';
import { renderSkills } from './skills.js';
import { skillTargets } from '../skills/targets.js';
import { promptFrame } from '../cli/prompts.js';
import { errorText } from './render.js';

function changes(items: JsonObject[]): string {
  return items
    .map(
      (item) =>
        `${item.key} = ${typeof item.value === 'string' ? item.value : JSON.stringify(item.value)}`,
    )
    .join('\n');
}
function overrides(items: JsonObject, language: Language): string {
  const zh = language === 'zh';
  return Object.entries(items)
    .map(
      ([key, env]) =>
        `${key}${colon(language)}${zh ? `被环境变量 ${env} 覆盖` : `overridden by environment variable ${env}`}`,
    )
    .join('\n');
}

export function renderSetup(result: Result<SetupData>, language: Language): string {
  const zh = language === 'zh';
  const { data, error } = result;
  const cancelled = error?.code === 'CANCELLED';
  if (cancelled && (!data || data.config.state === 'not_saved'))
    return promptFrame(errorText(error, language), 'cancel', [], process.stderr, true) + '\n';
  const states: Record<string, string> = zh
    ? { saved: '配置已保存', unchanged: '配置无变化', not_saved: '配置未保存' }
    : {
        saved: 'Configuration saved',
        unchanged: 'Configuration unchanged',
        not_saved: 'Configuration not saved',
      };
  const targets = (data?.skills as TargetResult[] | undefined)?.filter(
    (target) => !cancelled || target.state !== 'not_started',
  );
  let skills = '';
  if (targets?.length) {
    const installed = targets.every((target) =>
      ['installed', 'updated', 'unchanged'].includes(target.state),
    );
    if (!cancelled && installed) skills = zh ? 'Skills 安装完成' : 'Skills installed';
    else skills = renderSkills({ targets }, language, !cancelled);
  }
  const configuration = data ? states[String(data.config.state)] : '';
  const issues = error ? errorText(error, language).split('\n') : [];
  const heading = cancelled || !data ? issues.shift()! : configuration;
  const lines = [skills, ...issues];
  if (cancelled) lines.unshift(configuration);
  else if (data)
    lines.unshift(`${zh ? '配置文件' : 'Configuration file'}${colon(language)}${data.config.path}`);
  return (
    promptFrame(
      heading,
      error ? 'error' : 'submit',
      lines.filter(Boolean).flatMap((line) => line.split('\n')),
      process.stderr,
      true,
    ) + '\n'
  );
}
export function renderSetupPreview(draft: SetupDraft): string {
  const zh = draft.language === 'zh';
  const targets = draft.targets();
  const fileAndChanges = [
    `${zh ? '配置文件' : 'Configuration file'}${colon(draft.language)}${draft.document.path}`,
    changes(draft.changes()),
  ]
    .filter(Boolean)
    .join('\n');
  const sections = [fileAndChanges, overrides(draft.overrides(), draft.language)].filter(Boolean);
  if (targets.length)
    sections.push(
      [
        zh ? 'Skills 安装位置' : 'Skills installation locations',
        ...targets.map(
          (target) =>
            `${skillTargets.find((item) => item[0] === target.target)![1]}${colon(draft.language)}${target.path}`,
        ),
      ].join('\n'),
    );
  return (
    promptFrame(
      zh ? '待保存配置预览' : 'Configuration preview',
      'submit',
      ['', ...sections.join('\n\n').split('\n')],
      process.stderr,
    ) + '\n'
  );
}

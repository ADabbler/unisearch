import type { Language } from '../i18n/messages.js';
import type { JsonObject, PublicError } from '../result.js';
import type { SkillsData } from '../skills/manage.js';
import { skillTargets } from '../skills/targets.js';
import { errorText } from './render.js';
import { wrapText } from './text.js';

export function renderSkills(data: SkillsData, language: Language, showPaths = true): string {
  const zh = language === 'zh';
  const labels: Record<string, string> = zh
    ? {
        absent: '未安装',
        current: '与随包内容一致',
        different: '存在差异',
        installed: '已安装',
        updated: '已更新',
        unchanged: '已是当前内容',
        removed: '已移除',
        failed: '操作失败',
        not_started: '未开始',
      }
    : {
        absent: 'not installed',
        current: 'current',
        different: 'different',
        installed: 'installed',
        updated: 'updated',
        unchanged: 'unchanged',
        removed: 'removed',
        failed: 'failed',
        not_started: 'not started',
      };
  if (!data.targets.length) return zh ? '未选择 Skill 目标' : 'No Skill targets selected';
  return wrapText(
    data.targets
      .map((item) => {
        const name = skillTargets.find((target) => target[0] === item.target)![1];
        let changed = '';
        if (item.changed === false) changed = zh ? '，未改动目标' : ', target unchanged';
        else if (item.changed === true) changed = zh ? '，目标已改动' : ', target changed';
        else if (item.changed !== undefined)
          changed = zh ? '，可能已部分改动' : ', target may be partially changed';
        const lines = [
          `${name}: ${labels[item.state]}${changed}`,
          ...(showPaths ? [`  ${item.path}`] : []),
        ];
        if (item.differences)
          for (const [kind, paths] of Object.entries(item.differences as JsonObject))
            lines.push(
              `  ${zh ? ({ missing: '缺失', modified: '变更', extra: '额外文件' } as Record<string, string>)[kind] : kind}: ${(paths as string[]).join(', ')}`,
            );
        if (item.error) {
          lines.push(
            ...errorText(item.error as PublicError, language)
              .split('\n')
              .map((line) => `  ${line}`),
          );
        }
        return lines.join('\n');
      })
      .join('\n'),
  );
}

import { posix, win32 } from 'node:path';
import type { ConfigContext } from '../config/path.js';
import { AppError } from '../errors.js';

export const skillTargets = [
  ['codex', 'Codex', '.codex/skills'],
  ['claude', 'Claude Code', '.claude/skills'],
  ['cursor', 'Cursor', '.cursor/skills'],
  ['opencode', 'OpenCode', '.config/opencode/skills'],
  ['copilot', 'GitHub Copilot', '.copilot/skills'],
  ['gemini', 'Gemini CLI', '.gemini/skills'],
  ['cline', 'Cline', '.cline/skills'],
  ['roo', 'Roo Code', '.roo/skills'],
  ['kiro', 'Kiro', '.kiro/skills'],
  ['qoder', 'Qoder', '.qoder/skills'],
  ['codebuddy', 'CodeBuddy', '.codebuddy/skills'],
  ['droid', 'Factory Droid', '.factory/skills'],
  ['pi', 'Pi Agent', '.pi/agent/skills'],
  ['kilo', 'Kilo CLI', '.kilo/skills'],
  ['antigravity', 'Antigravity', '.gemini/config/skills'],
  ['devin', 'Devin', '.config/devin/skills'],
  ['hermes', 'Hermes Agent', '.hermes/skills'],
] as const;
export type SkillTarget = (typeof skillTargets)[number][0];
export type TargetPath = { target: SkillTarget; path: string };

export function parseTargets(input: string): SkillTarget[] {
  const ids = input.split(',');
  if (new Set(ids).size !== ids.length || ids.some((id) => !skillTargets.some((t) => t[0] === id)))
    throw new AppError('INVALID_ARGUMENT', 'skillsInvalidTargets', { option: '--targets' });
  return ids as SkillTarget[];
}

export function targetPaths(ids: readonly SkillTarget[], context: ConfigContext): TargetPath[] {
  const path = context.platform === 'win32' ? win32 : posix;
  return ids.map((target) => {
    let root = path.join(context.home(), skillTargets.find((item) => item[0] === target)![2]);
    if (target === 'devin') {
      if (context.platform === 'win32')
        root = path.join(
          context.env.APPDATA || path.join(context.home(), 'AppData', 'Roaming'),
          'devin',
          'skills',
        );
      else if (context.env.XDG_CONFIG_HOME && path.isAbsolute(context.env.XDG_CONFIG_HOME))
        root = path.join(context.env.XDG_CONFIG_HOME, 'devin', 'skills');
    }
    return { target, path: path.join(root, 'unisearch') };
  });
}

import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { AppError } from '../errors.js';

export interface ConfigContext {
  env: NodeJS.ProcessEnv;
  cwd: string;
  platform: NodeJS.Platform;
  home: () => string;
}

export function configContext(): ConfigContext {
  return { env: process.env, cwd: process.cwd(), platform: process.platform, home: homedir };
}

export interface ConfigPath {
  path: string;
  source: 'environment' | 'default';
}

export function selectConfigPath(context: ConfigContext): ConfigPath {
  const path = context.platform === 'win32' ? win32 : posix;
  const explicit = context.env.UNISEARCH_CONFIG_PATH;
  if (explicit !== undefined) {
    if (explicit.length === 0)
      throw new AppError('CONFIG_PATH_ERROR', 'configPath', { field: 'UNISEARCH_CONFIG_PATH' });
    return { path: path.resolve(context.cwd, explicit), source: 'environment' };
  }
  let directory: string;
  if (context.platform === 'win32') {
    directory = context.env.LOCALAPPDATA || path.join(context.home(), 'AppData', 'Local');
  } else if (context.platform === 'darwin') {
    directory = path.join(context.home(), 'Library', 'Application Support');
  } else {
    const xdg = context.env.XDG_CONFIG_HOME;
    directory = xdg && path.isAbsolute(xdg) ? xdg : path.join(context.home(), '.config');
  }
  return {
    path: path.resolve(context.cwd, directory, 'unisearch', 'config.json'),
    source: 'default',
  };
}

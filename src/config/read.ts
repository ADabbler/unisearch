import { lstatSync, readFileSync } from 'node:fs';
import { AppError, systemCode } from '../errors.js';
import type { ConfigPath } from './path.js';

export interface ConfigDocument extends ConfigPath {
  exists: boolean;
  values: Record<string, unknown>;
}

export function readConfig(selected: ConfigPath, allowCreate = false): ConfigDocument {
  let bytes: Buffer;
  try {
    bytes = readFileSync(selected.path);
  } catch (error) {
    const code = systemCode(error);
    if (code === 'ENOENT') {
      let isLink = false;
      try {
        isLink = lstatSync(selected.path).isSymbolicLink();
      } catch (linkError) {
        const linkCode = systemCode(linkError);
        if (linkCode !== 'ENOENT') {
          throw new AppError('CONFIG_READ_ERROR', 'configRead', {
            path: selected.path,
            ...(linkCode ? { system_code: linkCode } : {}),
          });
        }
      }
      // A dangling link is a broken configuration path, not a new file.
      if (isLink)
        throw new AppError('CONFIG_READ_ERROR', 'configRead', {
          path: selected.path,
          system_code: code,
        });
      if (selected.source === 'default' || allowCreate)
        return { ...selected, exists: false, values: {} };
    }
    throw new AppError(
      code === 'ENOENT' ? 'CONFIG_NOT_FOUND' : 'CONFIG_READ_ERROR',
      code === 'ENOENT' ? 'configMissing' : 'configRead',
      { path: selected.path, ...(code ? { system_code: code } : {}) },
    );
  }
  let values: unknown;
  try {
    values = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new AppError('CONFIG_PARSE_ERROR', 'configParse', { path: selected.path });
  }
  if (values === null || typeof values !== 'object' || Array.isArray(values)) {
    throw new AppError('CONFIG_PARSE_ERROR', 'configParse', { path: selected.path });
  }
  return { ...selected, exists: true, values: values as Record<string, unknown> };
}

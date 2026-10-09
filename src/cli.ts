#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createCli } from './cli/program.js';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};
process.exitCode = await createCli(manifest.version).run(process.argv.slice(2));

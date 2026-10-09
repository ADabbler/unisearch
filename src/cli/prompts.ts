import * as clack from '@clack/prompts';
import {
  MultiSelectPrompt,
  PasswordPrompt,
  SelectPrompt,
  TextPrompt,
  wrapTextWithPrefix,
} from '@clack/core';
import type { State } from '@clack/core';
import type { Readable, Writable } from 'node:stream';
import { styleText } from 'node:util';
import { AppError } from '../errors.js';
import type { Language } from '../i18n/messages.js';
import { text } from '../i18n/messages.js';
import { skillTargets } from '../skills/targets.js';
import type { SkillTarget } from '../skills/targets.js';

export interface Choice {
  value: string;
  label: string;
  description?: string;
}
export interface Prompts {
  select(message: string, choices: Choice[], initial: string, language: Language): Promise<string>;
  multi(
    message: string,
    choices: Choice[],
    initial: string[],
    language: Language,
  ): Promise<string[]>;
  input(
    message: string,
    secret: boolean,
    validate: (input: string) => string | undefined,
    label: string,
    placeholder?: string,
  ): Promise<string>;
}
export function requireTerminal(): void {
  if (!process.stdin.isTTY || !process.stderr.isTTY)
    throw new AppError('INVALID_ARGUMENT', 'interactiveRequired');
}

function wrappedLines(value: string, output: Writable): string[] {
  return wrapTextWithPrefix(output, value, '   ')
    .split('\n')
    .map((line) => line.slice(3));
}

export function promptFrame(
  message: string,
  state: State,
  lines: string[],
  output: Writable,
  endGuide = false,
): string {
  const finished = state === 'submit' || state === 'cancel';
  let color: 'gray' | 'yellow' | 'cyan' = 'cyan';
  if (finished) color = 'gray';
  else if (state === 'error') color = 'yellow';
  const bar = styleText(color, clack.S_BAR);
  if (endGuide && state === 'cancel' && !lines.length) {
    const messageLines = wrappedLines(message, output);
    return `${bar}\n${messageLines
      .map(
        (line, index) =>
          `${index === messageLines.length - 1 ? styleText(color, clack.S_BAR_END) : bar}  ${line}`,
      )
      .join('\n')}`;
  }
  const heading = wrappedLines(message, output)
    .map((line, index) => `${index === 0 ? clack.symbol(state) : bar}  ${line}`)
    .join('\n');
  const body = (endGuide && !lines.length ? [''] : lines).flatMap((line) =>
    wrappedLines(line, output),
  );
  return `${styleText('gray', clack.S_BAR)}\n${heading}\n${body
    .map((line, index) => {
      const prefix =
        (!finished || endGuide) && index === body.length - 1
          ? styleText(color, clack.S_BAR_END)
          : bar;
      return line ? `${prefix}  ${line}` : prefix;
    })
    .join('\n')}${finished || endGuide ? '' : '\n'}`;
}

function choiceLines(
  choices: Choice[],
  cursor: number,
  selected: string[],
  multi: boolean,
  output: Writable,
  rowPadding: number,
): string[] {
  return clack.limitOptions({
    output,
    options: choices,
    cursor,
    columnPadding: 3,
    rowPadding,
    style: (choice, active) => {
      const checked = selected.includes(choice.value);
      let symbol = active ? clack.S_RADIO_ACTIVE : clack.S_RADIO_INACTIVE;
      if (multi) symbol = checked ? clack.S_CHECKBOX_SELECTED : clack.S_CHECKBOX_INACTIVE;
      let color: 'green' | 'cyan' | 'dim' = 'dim';
      if (checked || (!multi && active)) color = 'green';
      else if (active) color = 'cyan';
      const mark = styleText(color, symbol);
      const label = choice.description ? `${choice.label}: ${choice.description}` : choice.label;
      return `${mark} ${active ? label : styleText('dim', label)}`;
    },
  });
}

export function terminalPrompts(
  signal: AbortSignal,
  common: { input: Readable; output: Writable } = { input: process.stdin, output: process.stderr },
): Prompts {
  async function ask<T>(run: (signal: AbortSignal) => Promise<T | symbol | undefined>): Promise<T> {
    const eof = new AbortController();
    const end = () => eof.abort();
    const keypress = (_value: string, key: { ctrl?: boolean; name?: string }) => {
      if (key.ctrl && key.name === 'd') queueMicrotask(end);
    };
    common.input.once('end', end);
    common.input.on('keypress', keypress);
    try {
      if (common.input.readableEnded) eof.abort();
      const result = await run(AbortSignal.any([signal, eof.signal]));
      if (clack.isCancel(result)) throw new AppError('CANCELLED', 'cancelled');
      if (result === undefined) throw new AppError('INTERNAL_ERROR', 'internal');
      return result as T;
    } finally {
      common.input.off('end', end);
      common.input.off('keypress', keypress);
    }
  }
  const hinted = new Set<boolean>();
  const hint = (message: string, language: Language, multi = false) => {
    if (hinted.has(multi)) return message;
    hinted.add(multi);
    const instructions =
      language === 'zh'
        ? `↑↓ 移动${multi ? '，空格选择' : ''}，回车确认，Esc 取消`
        : `↑↓ move${multi ? ', Space select' : ''}, Enter confirm, Esc cancel`;
    return `${message} ${styleText('dim', language === 'zh' ? `（${instructions}）` : `(${instructions})`)}`;
  };
  return {
    select: (message, choices, initial, language) => {
      const heading = hint(message, language);
      return ask<string>((signal) =>
        new SelectPrompt({
          ...common,
          signal,
          options: choices,
          initialValue: initial,
          render() {
            const finished = this.state === 'submit' || this.state === 'cancel';
            const lines = finished
              ? [styleText('dim', this.options[this.cursor].label)]
              : choiceLines(
                  this.options,
                  this.cursor,
                  [],
                  false,
                  common.output,
                  wrappedLines(heading, common.output).length + 2,
                );
            return promptFrame(heading, this.state, lines, common.output);
          },
        }).prompt(),
      );
    },
    multi: (message, choices, initial, language) => {
      const heading = hint(message, language, true);
      return ask<string[]>((signal) =>
        new MultiSelectPrompt({
          ...common,
          signal,
          options: choices,
          initialValues: initial,
          required: false,
          render() {
            const finished = this.state === 'submit' || this.state === 'cancel';
            const selected = this.value ?? [];
            let lines: string[];
            if (finished) {
              const summary =
                this.options
                  .filter((choice) => selected.includes(choice.value))
                  .map((choice) => choice.label)
                  .join(', ') || (language === 'zh' ? '未选择' : 'None');
              lines = [styleText('dim', summary)];
            } else {
              lines = choiceLines(
                this.options,
                this.cursor,
                selected,
                true,
                common.output,
                wrappedLines(heading, common.output).length + 2,
              );
            }
            return promptFrame(heading, this.state, lines, common.output);
          },
        }).prompt(),
      );
    },
    input: (message, secret, validate, label, placeholder) =>
      ask<string>((signal) =>
        new (secret ? PasswordPrompt : TextPrompt)({
          ...common,
          signal,
          ...(secret ? { mask: clack.S_PASSWORD_MASK } : {}),
          validate: (value) => validate(value ?? ''),
          render() {
            const finished = this.state === 'submit' || this.state === 'cancel';
            let value: string;
            if (finished) {
              const submitted = secret ? this.userInputWithCursor : this.value;
              value = styleText('dim', submitted || placeholder || '');
            } else {
              let entered = this.userInputWithCursor;
              if (!secret && this.userInput === '' && placeholder)
                entered =
                  styleText('inverse', placeholder[0]) + styleText('dim', placeholder.slice(1));
              value = `${label}${entered}`;
            }
            const lines = [value];
            if (this.state === 'error') lines.push(styleText('yellow', this.error));
            return promptFrame(message, this.state, lines, common.output);
          },
        }).prompt(),
      ),
  };
}
export async function selectSkillTargets(
  prompts: Prompts,
  language: Language,
  initial: SkillTarget[] = [],
): Promise<SkillTarget[]> {
  return (await prompts.multi(
    text(language, 'skillsSelect'),
    skillTargets.map(([value, label]) => ({ value, label })),
    initial,
    language,
  )) as SkillTarget[];
}

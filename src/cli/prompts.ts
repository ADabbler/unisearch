import * as clack from '@clack/prompts';
import {
  MultiSelectPrompt,
  PasswordPrompt,
  SelectPrompt,
  TextPrompt,
  getRows,
  wrapTextWithPrefix,
} from '@clack/core';
import type { Prompt, State } from '@clack/core';
import { clearScreenDown, cursorTo, moveCursor } from 'node:readline';
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
  action?: boolean;
}
interface SelectOptions {
  menu?: { separateBefore?: string; details?: string[]; titleGap?: boolean };
  validate?: (value: string | undefined) => string | undefined;
  cancelOnEscape?: boolean;
}
export interface Prompts {
  select(
    message: string,
    choices: Choice[],
    initial: string,
    language: Language,
    options?: SelectOptions,
  ): Promise<string>;
  multi(
    message: string,
    choices: Choice[],
    initial: string[],
    language: Language,
    validate?: (selected: string[] | undefined) => string | undefined,
  ): Promise<string[]>;
  input(
    message: string,
    secret: boolean,
    validate: (input: string) => string | undefined,
    language: Language,
    placeholder?: string,
  ): Promise<string>;
}

export class PromptBack extends Error {}

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

function choicePadding(title: string, footer: string, output: Writable): number {
  const frameRows = wrappedLines(title, output).length + 2;
  const footerRows = wrappedLines(footer, output).length + 1;
  return frameRows + footerRows;
}

function choiceLines(
  choices: Choice[],
  cursor: number,
  selected: string[],
  multi: boolean,
  output: Writable,
  rowPadding: number,
  separateBefore?: string,
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
      let line: string;
      if (!multi && choice.action) {
        const label = active
          ? styleText('bold', styleText('green', choice.label), { validateStream: false })
          : styleText('dim', choice.label);
        line = `[ ${label} ]`;
      } else {
        const mark = styleText(color, symbol);
        const label = choice.description ? `${choice.label}: ${choice.description}` : choice.label;
        line = `${mark} ${active ? label : styleText('dim', label)}`;
      }
      return choice.value === separateBefore ? `\n${line}` : line;
    },
  });
}

export function terminalPrompts(
  signal: AbortSignal,
  {
    input = process.stdin,
    output = process.stderr,
    backOnEscape = false,
  }: { input?: Readable; output?: Writable; backOnEscape?: boolean } = {},
): Prompts {
  const common = { input, output };
  async function ask<T>(
    create: (signal: AbortSignal) => Prompt<T>,
    back = backOnEscape,
  ): Promise<T> {
    const interrupt = new AbortController();
    const cancel = () => interrupt.abort();
    const keypress = (_value: string, key: { ctrl?: boolean; name?: string }) => {
      if (key.ctrl && key.name === 'd') queueMicrotask(cancel);
    };
    // Clack keeps its abort handler after closing, so detach the caller's signal in finally.
    signal.addEventListener('abort', cancel, { once: true });
    input.once('end', cancel);
    input.on('keypress', keypress);
    try {
      if (signal.aborted || input.readableEnded) cancel();
      const prompt = create(interrupt.signal);
      let escaped = false;
      if (back)
        prompt.on('key', (_value, key) => {
          escaped = key.name === 'escape';
        });
      const result = await prompt.prompt();
      if (clack.isCancel(result)) {
        if (escaped && !interrupt.signal.aborted) throw new PromptBack();
        throw new AppError('CANCELLED', 'cancelled');
      }
      if (result === undefined) throw new AppError('INTERNAL_ERROR', 'internal');
      return result;
    } finally {
      signal.removeEventListener('abort', cancel);
      input.off('end', cancel);
      input.off('keypress', keypress);
    }
  }
  const keyFooter = (
    language: Language,
    keys: 'selectKeys' | 'multiSelectKeys' | 'inputKeys',
    back = backOnEscape,
  ) => {
    const escape = text(language, back ? 'escapeBack' : 'escapeCancel');
    return styleText('dim', `${text(language, keys)} · ${escape}`);
  };
  const errorTitle = (heading: string, error: string, language: Language) =>
    heading + styleText('yellow', language === 'zh' ? `（${error}）` : ` (${error})`);
  return {
    select: (message, choices, initial, language, options) => {
      const menu = options?.menu;
      const back = backOnEscape && !options?.cancelOnEscape;
      const footer = keyFooter(language, 'selectKeys', back);
      const titleGap = menu?.titleGap !== false;
      let previewOffset = 0;
      let previewCapacity = 0;
      let previewLastOffset = 0;
      let menuRows = 0;
      const frame = (title: string, state: State, lines: string[]) => {
        const value = promptFrame(title, state, lines, common.output);
        if (menu) menuRows = value.split('\n').length - 1;
        return value;
      };
      const create = (signal: AbortSignal) => {
        const prompt = new SelectPrompt({
          ...common,
          signal,
          options: choices,
          initialValue: initial,
          validate: options?.validate,
          render() {
            const finished = this.state === 'submit' || this.state === 'cancel';
            if (finished) {
              if (menu) {
                menuRows = 0;
                return;
              }
              return frame(message, this.state, [
                styleText('dim', this.options[this.cursor].label),
              ]);
            }
            const title =
              this.state === 'error' ? errorTitle(message, this.error, language) : message;
            const sectionGap = menu && (menu.details || titleGap) ? 1 : 0;
            const padding = choicePadding(title, footer, common.output) + sectionGap;
            const lines = choiceLines(
              this.options,
              this.cursor,
              [],
              false,
              common.output,
              padding,
              menu?.separateBefore,
            );
            const keys = [footer];
            if (menu?.details) {
              const details = menu.details.flatMap((line) => wrappedLines(line, common.output));
              let availableRows = getRows(common.output) - padding - lines.length;
              if (details.length > Math.max(1, availableRows)) {
                const scroll = styleText('dim', text(language, 'setupPreviewScroll'));
                keys.unshift(scroll);
                availableRows -= wrappedLines(scroll, common.output).length;
              }
              previewCapacity = Math.max(1, availableRows);
              previewLastOffset = Math.max(0, details.length - previewCapacity);
              previewOffset = Math.min(previewOffset, previewLastOffset);
              // Give the preview a content row before reserving its gap above the actions.
              if (availableRows > 0) lines.unshift('');
              lines.unshift(...details.slice(previewOffset, previewOffset + previewCapacity));
            } else if (menu && titleGap) {
              lines.unshift('');
            }
            lines.push('', ...keys);
            return frame(title, this.state, lines);
          },
        });
        if (menu) {
          // Closing advances one row. An abort can close without clearing the menu.
          const finishMenu = () => {
            moveCursor(common.output, 0, -menuRows - 1);
            if (menuRows) clearScreenDown(common.output);
          };
          prompt.once('submit', finishMenu);
          prompt.once('cancel', finishMenu);
        }
        if (menu?.details)
          prompt.on('key', (_value, key) => {
            if (key.name === 'pageup') previewOffset = Math.max(0, previewOffset - previewCapacity);
            if (key.name === 'pagedown')
              previewOffset = Math.min(previewLastOffset, previewOffset + previewCapacity);
          });
        return prompt;
      };
      return ask(create, back);
    },
    multi: (message, choices, initial, language, validate) => {
      const footer = keyFooter(language, 'multiSelectKeys');
      return ask((signal) => {
        return new MultiSelectPrompt({
          ...common,
          signal,
          options: choices,
          initialValues: initial,
          validate,
          render() {
            const finished = this.state === 'submit' || this.state === 'cancel';
            const selected = this.value ?? [];
            const title =
              this.state === 'error' ? errorTitle(message, this.error, language) : message;
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
                choicePadding(title, footer, common.output),
              );
              lines.push('', footer);
            }
            return promptFrame(title, this.state, lines, common.output);
          },
        });
      });
    },
    input: (message, secret, validate, language, placeholder) => {
      const label = text(language, 'setupInput');
      const footer = keyFooter(language, 'inputKeys');
      return ask((signal) => {
        return new (secret ? PasswordPrompt : TextPrompt)({
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
            if (backOnEscape && !finished) lines.push('', footer);
            return promptFrame(message, this.state, lines, common.output);
          },
        });
      });
    },
  };
}

export async function withSetupScreen(
  signal: AbortSignal,
  run: (prompts: Prompts, nextPage: () => void) => Promise<void>,
): Promise<void> {
  const output = process.stderr;
  let alternateScreen = false;
  const nextPage = () => {
    if (!alternateScreen) {
      output.write('\x1b[?1049h');
      alternateScreen = true;
    }
    cursorTo(output, 0, 0);
    clearScreenDown(output);
  };
  try {
    await run(terminalPrompts(signal, { backOnEscape: true }), nextPage);
  } finally {
    if (alternateScreen) output.write('\x1b[?1049l');
  }
}

const skillTargetTitles = {
  install: 'skillsSelectInstall',
  update: 'skillsSelectUpdate',
  remove: 'skillsSelectRemove',
} as const;

export async function selectSkillTargets(
  prompts: Prompts,
  language: Language,
  action: keyof typeof skillTargetTitles,
  initial: SkillTarget[] = [],
): Promise<SkillTarget[]> {
  return (await prompts.multi(
    text(language, skillTargetTitles[action]),
    skillTargets.map(([value, label]) => ({ value, label })),
    initial,
    language,
  )) as SkillTarget[];
}

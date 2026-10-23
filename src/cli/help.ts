import { Help } from 'commander';
import type { Command } from 'commander';
import stringWidth from 'fast-string-width';
import { wrapText } from '../output/text.js';

export class TerminalHelp extends Help {
  override displayWidth(value: string): number {
    return stringWidth(value);
  }

  override boxWrap(value: string, width: number): string {
    return wrapText(value, width);
  }

  override formatItem(term: string, termWidth: number, description: string, helper: Help): string {
    const width = this.helpWidth ?? 80;
    const alignedTermWidth = Math.max(termWidth, 13);
    if (width - alignedTermWidth - 4 >= this.minWidthToWrap) {
      return super.formatItem(term, alignedTermWidth, description, helper);
    }
    const label = this.boxWrap(`  ${term}`, width);
    return description ? `${label}\n${this.boxWrap(`    ${description}`, width)}` : label;
  }

  override formatHelp(command: Command, helper: Help): string {
    // Commander joins the localized title and its subject with a literal space, which reads as a
    // stray gap after the full-width colon Chinese uses as a label separator.
    const heading = helper.styleTitle('Usage:');
    const text = super.formatHelp(command, helper);
    const joined = `${heading} `;
    const trimmed =
      heading.endsWith('：') && text.startsWith(joined)
        ? heading + text.slice(joined.length)
        : text;
    return this.boxWrap(trimmed, this.helpWidth ?? 80);
  }
}

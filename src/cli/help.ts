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
    return this.boxWrap(super.formatHelp(command, helper), this.helpWidth ?? 80);
  }
}

import stringWidth from 'fast-string-width';
import { Rules } from '@cto.af/linebreak';

const rules = new Rules({ string: true });
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function wrapLine(value: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const part of rules.breaks(value)) {
    const segment = part.string!;
    if (line && stringWidth((line + segment).trimEnd()) > width) {
      lines.push(line.trimEnd());
      line = '';
    }
    const chunk = line ? segment : segment.trimStart();
    if (stringWidth(chunk.trimEnd()) > width) {
      for (const { segment: character } of graphemes.segment(chunk.trimEnd())) {
        if (line && stringWidth(line + character) > width) {
          lines.push(line);
          line = '';
        }
        line += character;
      }
    } else line += chunk;
  }
  lines.push(line.trimEnd());
  return lines;
}

export function wrapText(value: string, width = process.stdout.columns ?? 80): string {
  return value
    .split('\n')
    .map((line) => {
      const prefix = /^ */.exec(line)![0];
      const indent = ' '.repeat(Math.min(prefix.length, Math.max(0, width - 2)));
      return wrapLine(line.slice(prefix.length), width - indent.length)
        .map((part) => indent + part)
        .join('\n');
    })
    .join('\n');
}

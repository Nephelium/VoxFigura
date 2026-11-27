export interface ParsedTooltipContent {
  label: string;
  shortcut: string | null;
}

const MOD_KEY_CHORD = '(?:(?:Ctrl|Cmd|Alt|Shift|Meta)\\s*\\+\\s*)+(?:[A-Za-z0-9,./;\\-=`\\[\\]\\\\]|Space|Enter|Esc|Tab|Delete|Backspace|Home|End|F\\d{1,2}|[↑↓←→])';
const SINGLE_KEY = '(?:Esc|Space|Enter|Tab|Delete|Backspace|Home|End|F(?:1[0-2]|[1-9]))';

const PAREN_SHORTCUT_RE = new RegExp(`^(.+?)\\s*[（(]\\s*(${MOD_KEY_CHORD}|${SINGLE_KEY})\\s*[)）]\\s*$`);
const TRAILING_CHORD_RE = new RegExp(`^(.+?)\\s+(${MOD_KEY_CHORD})\\s*$`);

/**
 * Split a human-readable tooltip string into main label and an optional trailing keyboard shortcut badge.
 * Keeps ordinary prose, version strings, and parenthetical notes untouched.
 */
export function parseTooltipContent(raw: string): ParsedTooltipContent {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return { label: '', shortcut: null };

  const parenMatch = text.match(PAREN_SHORTCUT_RE);
  if (parenMatch) {
    const label = parenMatch[1].trim();
    const shortcut = parenMatch[2].replace(/\s*\+\s*/g, '+').trim();
    if (label) return { label, shortcut };
  }

  const trailingMatch = text.match(TRAILING_CHORD_RE);
  if (trailingMatch) {
    const label = trailingMatch[1].trim();
    const shortcut = trailingMatch[2].replace(/\s*\+\s*/g, '+').trim();
    if (label) return { label, shortcut };
  }

  return { label: text, shortcut: null };
}

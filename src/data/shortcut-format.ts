export interface ShortcutToken {
  kind: 'key' | 'sep';
  text: string;
}

const SLASH_PHRASE_RE = /[\u4e00-\u9fff]左\s*\/\s*右[\u4e00-\u9fff]/;
const COMPACT_SLASH_KEYS_RE = /^[A-Za-z0-9]+\/[A-Za-z0-9]+$/;

function pushChordTokens(out: ShortcutToken[], rawChord: string): void {
  const chord = rawChord.trim();
  if (!chord) return;
  const parts = chord.split(/\s+\+\s+|(?<=[A-Za-z0-9])\+(?=[A-Za-z0-9\u4e00-\u9fff])/);
  parts.forEach((part, idx) => {
    const token = part.trim();
    if (!token) return;
    if (idx > 0) out.push({ kind: 'sep', text: '+' });
    if (COMPACT_SLASH_KEYS_RE.test(token)) {
      const [left, right] = token.split('/');
      out.push({ kind: 'key', text: left });
      out.push({ kind: 'sep', text: '/' });
      out.push({ kind: 'key', text: right });
    } else {
      out.push({ kind: 'key', text: token });
    }
  });
}

/**
 * Parse a human-readable shortcut expression into structured keycaps and separators
 * without breaking `/` key bindings (e.g. `Alt + /`) or Chinese phrase slashes (e.g. `拖音块左 / 右缘`).
 */
export function parseShortcutTokens(expr: string): ShortcutToken[] {
  const tokens: ShortcutToken[] = [];
  const groups = expr.split(/\s+·\s+/);
  groups.forEach((group, gIdx) => {
    if (gIdx > 0) tokens.push({ kind: 'sep', text: '·' });
    const trimmedGroup = group.trim();
    if (!trimmedGroup) return;
    if (SLASH_PHRASE_RE.test(trimmedGroup)) {
      tokens.push({ kind: 'key', text: trimmedGroup });
      return;
    }
    const alts = trimmedGroup.split(/\s+\/\s+/);
    alts.forEach((alt, aIdx) => {
      if (aIdx > 0) tokens.push({ kind: 'sep', text: '/' });
      pushChordTokens(tokens, alt);
    });
  });
  return tokens;
}

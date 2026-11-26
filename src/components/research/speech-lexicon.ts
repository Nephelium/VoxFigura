import type { Clip, Syllable } from '@vocalcut/core';
import type { ReadingRow } from '@vocalcut/g2p';
import { parseIpaSuprasegmentals } from '@/data/ipa-segments';
import { detectWordLanguage, formatUserLexiconIpa, userLexiconReadingTarget } from '@/data/user-lexicon';

export function speechLexiconSelection(clip: Clip, syllable: Syllable, readings: readonly ReadingRow[], standard: string) {
  const index = clip.syllable_order.indexOf(syllable.id);
  const original = readings.length === clip.syllable_order.length ? readings[index] : undefined;
  const reading = original?.word.normalize('NFC') === syllable.text.normalize('NFC') ? original : undefined;
  const word = syllable.text.trim();
  const language = reading?.language ?? (standard.startsWith('dialect:') ? 'zh'
    : clip.source?.lang === 'ja' && !clip.source.score ? 'ja' : detectWordLanguage(word));
  const target = userLexiconReadingTarget({ ...reading, word, language }, standard);
  if (language === 'en' && target.syllableIndex === undefined) {
    // Imported or previously edited timelines may no longer match a fresh G2P pass.
    // English display labels mark every non-final syllable with a trailing hyphen.
    let first = index;
    let last = index;
    const part = (i: number) => clip.syllables[clip.syllable_order[i]]?.text.trim() ?? '';
    const isEnglishPart = (text: string) => /^[\p{Script=Latin}\p{M}'’]+-?$/u.test(text);
    if (isEnglishPart(word)) {
      while (first > 0 && isEnglishPart(part(first - 1)) && part(first - 1).endsWith('-')) first--;
      while (part(last).endsWith('-') && isEnglishPart(part(last + 1))) last++;
    }
    if (last > first && !part(last).endsWith('-')) {
      target.word = clip.syllable_order.slice(first, last + 1).map((_, i) => part(first + i).replace(/-$/u, '')).join('');
      target.syllableIndex = index - first;
      target.syllableCount = last - first + 1;
    } else if (word.endsWith('-')) {
      return null;
    }
  }
  const segments = syllable.segments.filter(segment => segment.role !== 'rest' && segment.ipa.trim() !== '' && segment.ipa !== 'sil');
  if (!word || !segments.length) return null;
  const ipaPhones = segments.map(segment => segment.ipa);
  const stress = parseIpaSuprasegmentals(reading?.ipa ?? (language === 'ipa' ? word : '')).stress;
  const toneLevels = syllable.tone_levels;
  return {
    ...target, ipaPhones, segments, stress, toneLevels,
    ipa: formatUserLexiconIpa(ipaPhones, target.language, toneLevels, stress),
  };
}

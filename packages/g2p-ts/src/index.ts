export {
  mappingStandards,
  mandarinCharacters,
  standards,
  dataInventory,
  addToneMark,
  displayEntry,
  variantKey,
  convertText,
  variantsFor,
  autoErhuaPairs,
  moveErhuaPairs,
  plainOutput,
  effectiveIpaSize,
  createDraft,
  createPageDraft,
  moveVariantChoices,
  snapshotDraft,
  restoreDraft,
  restoreTableDraft,
  type MappingStandard,
  type IpaStandard,
  type DisplayMode,
  type PageLayout,
  type IpaEntry,
  type MappedToken,
  type LiteralToken,
  type ConversionToken,
  type VariantOption,
  type MandarinIpaDraft,
} from './state.ts';

export {
  untVersion,
  isUnt,
  untSyllable,
  untTranscription,
  untReading,
} from './unt.ts';

export {
  defaultToneSettings,
  toneSuffix,
  toneSymbols,
  toneClasses,
  validateToneSettings,
  transcribeTone,
  tonePreview,
  type ToneSettings,
} from './tones.ts';

export {
  emptyLibrary,
  syllableKey,
  parseDelimited,
  suggestColumns,
  columnLabel,
  tableRows,
  tableName,
  restoreLibrary,
  addTable,
  replaceTable,
  removeTable,
  CustomTableStore,
  tableErrorNeedsReload,
  type TableKind,
  type CustomTable,
  type TableLibrary,
  type ImportColumns,
} from './custom-tables.ts';

export {
  tonicMidi,
  readNumberedScore,
  type SongTonic,
  type SongNote,
  type SongScore,
  type ScorePreview,
} from './numbered-score.ts';

export {
  tokens,
  pauseMark,
  longPause,
  IPA_SPACE_PAUSE_MS,
  IPA_LONG_PAUSE_MS,
  IPA_SPACE_PAUSE_TOKEN,
  startsIpa,
  speechTokens,
  isKanaRun,
  mixedSpeechTokens,
  splitIpaSpanTokens,
  looksLikeBareIpaToken,
} from './text-tokens.ts';

export {
  needsEnglishDictionary,
  arpaToIpa,
  arpaToIpaSyllables,
  splitEnglishWordDisplay,
  parseCmu,
  loadCmu,
  parsePersonal,
  reviewText,
  type Lexicon,
  type ReadingRow,
  type ReviewTextOptions,
} from './text-readings.ts';

export {
  planReading,
  type SpeechUnit,
  type SpeechPlan,
  type EnglishEnding,
} from './text-prosody.ts';

export {
  sandhiSuggestions,
  isEnglishPhraseEnd,
  type SandhiRule,
  type SandhiSuggestion,
} from './text-sandhi.ts';

export {
  basicKanaReading,
  basicKanaInventory,
  narrowJapaneseMoraIpa,
  reviewKana,
  type KanaLexicon,
  type ReviewKanaOptions,
} from './kana-readings.ts';

export {
  normalizeJapaneseWord,
  japaneseShard,
  searchJapaneseWords,
  japaneseWordInventory,
  japaneseReadingsFor,
  type JapaneseEntry,
} from './japanese-dictionary.ts';

export {
  japaneseAccentShard,
  countMoras,
  computeTokyoMoraContour,
  analyzeJapaneseAccent,
  japaneseKanjiReadingsFor,
  type JapaneseAccentEntry,
  type JapaneseAccentMora,
  type JapaneseAccentPlan,
  type JapaneseKanjiSegment,
} from './japanese-accent.ts';

export {
  romajiToMoras,
  romajiToHiragana,
  isRomajiWord,
  reviewRomajiWord,
  reviewRomaji,
  type RomajiMoraToken,
} from './romaji-readings.ts';

export {
  loadCantoneseDictionary,
  lookupCantoneseHanRun,
  type CantoneseLexicon,
} from './cantonese-dictionary.ts';

export {
  LYRICS_LANGUAGE_OPTIONS,
  isLyricsLanguage,
  jyutpingToNarrowIpa,
  isJyutpingToken,
  cantoneseHanziChoices,
  reviewJyutpingToken,
  spanishWordToNarrowIpaSyllables,
  reviewSpanishWord,
  type LyricsLanguage,
  type LanguageSelection,
  type LyricsLanguageOption,
} from './multilang-g2p.ts';

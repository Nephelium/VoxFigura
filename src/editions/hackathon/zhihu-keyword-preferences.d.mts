export interface ZhihuKeywordPreferences {
  preferred: string[];
  blocked: string[];
}

export function splitZhihuEntries(raw: string): string[];
export function keywordKey(text: string): string;
export function readZhihuKeywords(value: unknown): string[];
export function hasBlockedKeyword(text: string, blocked: readonly string[]): boolean;

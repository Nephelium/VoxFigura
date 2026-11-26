export const DEEPSEEK_API_BASE = 'https://api.deepseek.com';

export function isDeepSeekApiBase(base: string): boolean {
  try {
    const url = new URL(base);
    return url.origin === DEEPSEEK_API_BASE &&
      !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

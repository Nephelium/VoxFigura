import { computed, ref, watch } from 'vue';

const ZHIHU_NICKNAME_STORAGE_KEY = 'vocalcut.hackathon.zhihuNickname';
const ZHIHU_SHOW_SIG_STORAGE_KEY = 'vocalcut.hackathon.showSignature';

function cleanNickname(raw: string): string {
  return raw
    .trim()
    .replace(/^知乎\s*@+/u, '')
    .replace(/^@+/u, '')
    .trim()
    .slice(0, 48);
}

function readStoredNickname(): string {
  if (typeof localStorage === 'undefined') return '';
  try {
    return cleanNickname(localStorage.getItem(ZHIHU_NICKNAME_STORAGE_KEY) ?? '');
  } catch {
    return '';
  }
}

function readStoredShowSig(): boolean {
  if (typeof localStorage === 'undefined') return true;
  try {
    return localStorage.getItem(ZHIHU_SHOW_SIG_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

export const zhihuAuthorNickname = ref<string>(readStoredNickname());
export const showZhihuSignature = ref<boolean>(readStoredShowSig());

watch(zhihuAuthorNickname, (val) => {
  const cleaned = cleanNickname(val);
  if (cleaned !== val && val.startsWith('@')) {
    zhihuAuthorNickname.value = cleaned;
    return;
  }
  if (typeof localStorage === 'undefined') return;
  try {
    if (cleaned) localStorage.setItem(ZHIHU_NICKNAME_STORAGE_KEY, cleaned);
    else localStorage.removeItem(ZHIHU_NICKNAME_STORAGE_KEY);
  } catch {
    // Ignore storage quota issues in private browsing
  }
});

watch(showZhihuSignature, (val) => {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(ZHIHU_SHOW_SIG_STORAGE_KEY, val ? '1' : '0');
  } catch {
    // Ignore storage quota issues
  }
});

/**
 * Formats the author credit in official Zhihu image watermark convention: `知乎@昵称` (no space).
 * Never falls back to any application brand watermark.
 */
export const formattedZhihuSignature = computed<string>(() => {
  if (!showZhihuSignature.value) return '';
  const nick = cleanNickname(zhihuAuthorNickname.value);
  return nick ? `知乎@${nick}` : '';
});

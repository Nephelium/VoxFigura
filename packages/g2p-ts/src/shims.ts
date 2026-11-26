export type MessageRef = { key: string; values?: Record<string, string | number> } | string;

const MESSAGES: Record<string, string> = {
  'modules.mandarin-ipa.text.67436511c305': '轻声',
  'modules.vocal-tract.dictionary_invalid': '词典格式无效',
  'modules.vocal-tract.dictionary_load': '无法加载英语词典 cmudict.dict',
  'modules.vocal-tract.dictionary_line': '词典第 {line} 行格式无效',
  'modules.vocal-tract.text_brackets': '方括号 IPA 配对或内容无效',
  'modules.vocal-tract.kana_empty': '假名输入为空',
  'modules.vocal-tract.kana_unsupported': '暂不支持该假名字符',
};

export function tr(key: string, values?: Record<string, string | number>): string {
  const template = MESSAGES[key] ?? key;
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (_m, k) => (k in values ? String(values[k]) : `{${k}}`));
}

export function displayMessage(key: string, values?: Record<string, string | number>): MessageRef {
  return { key, values };
}

export class G2pError extends Error {
  readonly ref: MessageRef;
  constructor(ref: MessageRef) {
    super(typeof ref === 'string' ? ref : tr(ref.key, ref.values));
    this.name = 'G2pError';
    this.ref = ref;
  }
}

export function displayError(ref: MessageRef): Error {
  return new G2pError(ref);
}

export function uiErrorMessage(cause: unknown): MessageRef {
  if (cause instanceof G2pError) return cause.ref;
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

export function validFamily(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 120 && !/[;{}<>]/.test(value);
}

export interface AssetDatabase {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

const memoryAssets = new Map<string, unknown>();

export class LocalAssets {
  private prefix: string;
  private db?: AssetDatabase;

  constructor(owner: string, namespace: string, db?: AssetDatabase) {
    this.prefix = `${owner}:${namespace}:`;
    this.db = db;
  }

  async value<T = unknown>(key: string): Promise<T | undefined> {
    if (this.db) return (await this.db.get(this.prefix + key)) as T | undefined;
    return memoryAssets.get(this.prefix + key) as T | undefined;
  }

  async compare(key: string, expectedPrev: unknown, nextValue: unknown): Promise<void> {
    const current = await this.value(key);
    if ((current ?? null) !== (expectedPrev ?? null)) {
      throw displayError(displayMessage('modules.mandarin-ipa.text.32f4898dd7c3'));
    }
    if (this.db) {
      await this.db.set(this.prefix + key, nextValue);
    } else {
      memoryAssets.set(this.prefix + key, nextValue);
    }
  }
}

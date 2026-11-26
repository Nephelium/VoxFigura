export interface ZhihuAuthorIdentity {
  name: string;
  accountId?: string;
  profileUrl?: string;
  avatarKey?: string;
  sourceId?: string;
}

export function authorNameKey(name: string): string;
export function zhihuProfileUrl(value: unknown): string | undefined;
export function readZhihuAuthorIdentity(item: Record<string, unknown>, name?: string): ZhihuAuthorIdentity;
export function readAuthorEntry(value: unknown): ZhihuAuthorIdentity | undefined;
export function matchZhihuAuthor(saved: ZhihuAuthorIdentity, author: ZhihuAuthorIdentity, ambiguousAvatars?: ReadonlySet<string>): boolean;
export function hasZhihuAuthorIdentity(author: ZhihuAuthorIdentity): boolean;
export function ambiguousAuthorAvatars(authors: readonly ZhihuAuthorIdentity[]): Set<string>;
export function rankZhihuAuthorItems<T>(
  items: readonly T[], preferences: { preferred: readonly ZhihuAuthorIdentity[]; blocked: readonly ZhihuAuthorIdentity[] },
  getAuthor: (item: T) => ZhihuAuthorIdentity, getVotes: (item: T) => number | null,
): T[];

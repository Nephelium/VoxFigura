/**
 * Resolves a static asset path under `public/` against Vite's configured `BASE_URL`
 * so builds work identically at root (`/`) and subpath deployments (e.g. `/VoxFigura/`).
 */
export function publicAssetUrl(path: string): string {
  const rawBase =
    (typeof import.meta !== 'undefined'
      ? (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL
      : undefined) || '/';
  const base = rawBase.endsWith('/') ? rawBase : `${rawBase}/`;
  return `${base}${path.replace(/^\/+/, '')}`;
}

import { readFileSync, readdirSync, createReadStream } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';

const localPath = (relativePath: string) => fileURLToPath(new URL(relativePath, import.meta.url));
const pkgVersion: string = JSON.parse(readFileSync(localPath('./package.json'), 'utf8')).version || '0.1.0';

function contestAssets(): Plugin {
  const directory = new URL('./src/editions/hackathon/assets/', import.meta.url);
  const urls = new Map(readdirSync(directory).map(name => ['/assets/kanshan/' + name, new URL(name, directory)]));
  return {
    name: 'contest-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const asset = urls.get((req.url ?? '').split('?')[0]);
        if (!asset || (req.method !== 'GET' && req.method !== 'HEAD')) return next();
        res.setHeader('Content-Type', asset.pathname.endsWith('.gif') ? 'image/gif' : asset.pathname.endsWith('.jpg') ? 'image/jpeg' : 'application/json');
        if (req.method === 'HEAD') return res.end();
        createReadStream(asset).on('error', next).pipe(res);
      });
    },
    generateBundle() {
      for (const [pathname, source] of urls) {
        this.emitFile({ type: 'asset', fileName: pathname.slice(1), source: readFileSync(source) });
      }
    },
  };
}

function resolveBaseUrl(): string {
  const raw = (process.env.VITE_BASE_URL || '/').trim();
  if (!raw || raw === '/') return '/';
  const withLead = raw.startsWith('/') ? raw : `/${raw}`;
  return withLead.endsWith('/') ? withLead : `${withLead}/`;
}

function rewriteHtmlBase(base: string): Plugin {
  return {
    name: 'rewrite-html-base',
    transformIndexHtml(html) {
      if (base === '/') return html;
      return html
        .replaceAll('"/vocal-tract/vendor/three.module.js"', JSON.stringify(`${base}vocal-tract/vendor/three.module.js`))
        .replaceAll('url("/fonts/', `url("${base}fonts/`)
        .replaceAll('href="/app-icon.png"', `href="${base}app-icon.png"`)
        .replaceAll('src="/app-icon.png"', `src="${base}app-icon.png"`);
    },
  };
}

export default defineConfig(({ mode }) => {
  const base = resolveBaseUrl();
  const contest = mode === 'hackathon';
  const edition = contest
    ? { name: 'hackathon', entry: './src/editions/hackathon/index.ts', devPort: 5174, previewPort: 4174, proxyPort: 3002 }
    : { name: 'public', entry: './src/editions/public.ts', devPort: 5173, previewPort: 4173, proxyPort: 3001 };
  const restrictedEditionPaths = contest ? [] : ['**/editions/hackathon/assets/**'];
  return {
    base,
    envDir: false,
    define: {
      __APP_VERSION__: JSON.stringify(pkgVersion),
      __APP_EDITION__: JSON.stringify(edition.name),
      __APP_PORTABLE__: JSON.stringify(process.env.VOCALCUT_PORTABLE === '1'),
    },
    cacheDir: contest ? 'node_modules/.vite-contest' : `node_modules/.vite-${edition.name}`,
    plugins: [vue(), rewriteHtmlBase(base), ...(contest ? [contestAssets()] : [])],
    resolve: {
      alias: {
        '@': localPath('./src'),
        '@vocalcut/edition': localPath(edition.entry),
        '@vocalcut/core': localPath('./packages/core-ts/src/index.ts'),
        '@vocalcut/g2p': localPath('./packages/g2p-ts/src/index.ts'),
        '@vocalcut/model-adapters': localPath('./packages/model-adapters/src/index.ts'),
      },
    },
    build: { outDir: `dist-${edition.name}`, emptyOutDir: true },
    preview: { host: '127.0.0.1', port: edition.previewPort },
    server: {
      host: '127.0.0.1',
      port: edition.devPort,
      fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.zhihu-author-defaults.local.json', ...restrictedEditionPaths] },
      proxy: { '/api': { target: process.env.VOCALCUT_PROXY_URL || `http://127.0.0.1:${edition.proxyPort}`, changeOrigin: true } },
    },
  };
});

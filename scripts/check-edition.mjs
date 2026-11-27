import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const edition = process.argv[2];
if (!['public', 'hackathon', 'friends'].includes(edition)) throw new Error('Choose public, hackathon or friends.');
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const output = process.argv[3] ? resolve(process.argv[3]) : fileURLToPath(new URL('../dist-' + edition + '/', import.meta.url));
const textFormats = new Set(['.html', '.js', '.mjs', '.json', '.css', '.svg', '.txt', '.dict']);
const brand = /知乎|刘看山|kanshan|zhida[-_]|\bzhihu\b|zhihu[./_-]/i;
const zhihuCredentialLeak = /X-Zhihu-BYOK-Secret|zhihu-keyword|ZHIHU_ACCESS_SECRET|zhihu_search|zhihu-author-identity|developer\.zhihu\.com/i;
const explorationBundle = /(?:ExploreLabView|ExploreExport|KanshanCompanion)-/;
const contestServerLeak = /\b(?:contest-routes|repo-knowledge|zhihu-cli|zhihu-author-defaults)\.mjs\b/i;

// Explicit allowlist of hackathon modules intentionally shared by the public edition.
const PUBLIC_ALLOWED_HACKATHON_IMPORTS = new Set([
  './hackathon/branded-card',
  './hackathon/branded-card.ts',
]);

const contestFiles = new Set();
const cardFiles = new Set();
const problems = [];
let fileCount = 0;

async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      await inspect(file);
      continue;
    }
    fileCount++;
    const name = relative(output, file).replaceAll('\\', '/');
    const content = textFormats.has(extname(name)) ? await readFile(file, 'utf8') : '';
    if (name.startsWith('assets/CardHeaderButton-') && name.endsWith('.js')) cardFiles.add('card-entry');
    if (content.includes('/api/explore/card-job')) cardFiles.add('card-encoding');
    if (edition === 'hackathon') {
      if (name.startsWith('assets/kanshan/')) contestFiles.add(entry.name);
      if (content.includes('/api/zhihu/search')) contestFiles.add('explore-route');
    } else {
      if (
        name.startsWith('assets/kanshan/') ||
        explorationBundle.test(name) ||
        brand.test(name)
      ) {
        problems.push(name);
      }
      if (
        /\/api\/(?:zhihu\/|explore\/repo-)|\/assets\/kanshan\//.test(content) ||
        /刘看山|kanshan/i.test(content) ||
        zhihuCredentialLeak.test(content) ||
        contestServerLeak.test(content)
      ) {
        problems.push(name);
      }
    }
  }
}

async function verifyPublicSourceAllowlist() {
  const publicEntry = join(repoRoot, 'src', 'editions', 'public.ts');
  const source = await readFile(publicEntry, 'utf8');
  const importRe = /\b(?:import|export)\b[^'"]*?from\s+['"]([^'"]*hackathon[^'"]*)['"]/g;
  let match;
  while ((match = importRe.exec(source)) !== null) {
    const spec = match[1];
    if (!PUBLIC_ALLOWED_HACKATHON_IMPORTS.has(spec)) {
      problems.push(`disallowed public hackathon import: ${spec}`);
    }
  }
}

await inspect(output);
if (!fileCount) throw new Error('Empty build output.');
if (edition !== 'hackathon') {
  await verifyPublicSourceAllowlist();
}
if (edition === 'hackathon') {
  for (const name of ['manifest.json', 'idle.gif', 'greet.gif', 'sway.gif', 'computer.gif', 'dribble.gif', 'sleepy.gif', 'sheet-1.jpg', 'sheet-2.jpg', 'sheet-3.jpg', 'explore-route']) {
    if (!contestFiles.has(name)) problems.push('missing ' + name);
  }
}
for (const name of ['card-entry', 'card-encoding']) {
  if (!cardFiles.has(name)) problems.push('missing ' + name);
}
if (problems.length) throw new Error('Edition check failed: ' + problems.join(', '));
console.log('Verified ' + edition + ' edition (' + fileCount + ' files).');

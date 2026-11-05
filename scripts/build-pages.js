// Build a static copy of the public dashboard (for GitHub Pages) from a fresh
// synthetic registry. Output goes to ./site.
import { mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { loadCountry } from '../src/country.js';
import { Registry } from '../src/registry.js';
import { seedDemo } from '../src/demo.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = `${root}site/`;
mkdirSync(out, { recursive: true });

const registry = new Registry(new Store(), { country: loadCountry() });
await seedDemo(registry);
writeFileSync(`${out}stats.json`, JSON.stringify(registry.publicStats(), null, 2));

// The static copy has no portal or admin, so the header links to the source code instead.
const html = readFileSync(`${root}public/index.html`, 'utf8')
  .replace('data-stats-url="api/public/stats"',
    'data-stats-url="stats.json" data-public-site="1" data-source-url="https://github.com/muhammadyasir52-max/cancer-screening-registry"');
if (!html.includes('data-public-site="1"')) throw new Error('index.html body attributes changed; update build-pages.js');
writeFileSync(`${out}index.html`, html);
for (const f of ['app.css', 'ui.js', 'dashboard.js']) copyFileSync(`${root}public/${f}`, `${out}${f}`);
console.log(`Static dashboard written to ${out}`);

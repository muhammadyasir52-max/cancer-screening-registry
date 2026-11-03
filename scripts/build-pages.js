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

const html = readFileSync(`${root}public/index.html`, 'utf8')
  .replace('data-stats-url="api/public/stats"', 'data-stats-url="stats.json"')
  .replace(/<nav class="site-nav">[\s\S]*?<\/nav>/, '<nav class="site-nav"><a href="https://github.com/muhammadyasir52-max/cancer-screening-registry">Source code</a></nav>');
writeFileSync(`${out}index.html`, html);
for (const f of ['app.css', 'dashboard.js']) copyFileSync(`${root}public/${f}`, `${out}${f}`);
console.log(`Static dashboard written to ${out}`);

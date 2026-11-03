import { createServer } from 'node:http';
import { openStore } from './store.js';
import { loadCountry } from './country.js';
import { Registry } from './registry.js';
import { createApp } from './app.js';
import { ensureAdmin } from './auth.js';
import { seedDemo, DEMO_ORGS } from './demo.js';

const port = Number(process.env.PORT) || 3000;
const store = await openStore();
const country = loadCountry();
const registry = new Registry(store, { country });

if (store.all('Organization').length === 0 && process.env.DEMO !== '0') {
  console.log('Empty registry: loading synthetic demo organisations and population…');
  const { totals } = await seedDemo(registry);
  console.log('Demo submissions:', JSON.stringify(totals));
}
ensureAdmin(store, process.env.ADMIN_API_KEY);
const demoOrgs = store.all('Organization').filter((o) => o.name.endsWith('(demo)') || o.name.startsWith('Demo '));
if (process.env.NODE_ENV === 'production' && demoOrgs.length) {
  console.error('Refusing to start: demo organisations with well-known keys exist and NODE_ENV=production. Start on a fresh database with DEMO=0.');
  process.exit(1);
}
const run = registry.refreshAll();
console.log(`${country.name}: rules evaluated for ${run.patients} people (${run.opened} alerts opened, ${run.closed} closed).`);

// Re-run the rules daily so people become overdue without a restart.
setInterval(() => registry.refreshAll(), 24 * 60 * 60 * 1000).unref();

createServer(createApp(registry)).listen(port, () => {
  console.log(`Public dashboard: http://localhost:${port}/`);
  console.log(`Facility portal:  http://localhost:${port}/portal`);
  console.log(`Administration:   http://localhost:${port}/admin`);
  console.log(`FHIR API:         http://localhost:${port}/fhir/metadata`);
  if (store.all('Organization').some((o) => o.name.endsWith('(demo)'))) {
    console.warn('DEMO MODE: synthetic data and well-known demo keys:');
    for (const o of Object.values(DEMO_ORGS)) console.warn(`  ${o.key.padEnd(20)} ${o.name} [${o.roles.join(', ')}]`);
  }
});

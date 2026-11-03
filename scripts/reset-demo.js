// Wipe the local registry and reload the synthetic demo organisations and population.
import { openStore } from '../src/store.js';
import { loadCountry } from '../src/country.js';
import { Registry } from '../src/registry.js';
import { seedDemo } from '../src/demo.js';

const store = await openStore();
store.clear();
const registry = new Registry(store, { country: loadCountry() });
const { totals } = await seedDemo(registry, { count: Number(process.env.COUNT) || 2500 });
const run = registry.refreshAll();
console.log(`Loaded ${run.patients} synthetic people. Submissions: ${JSON.stringify(totals)}`);

// Country policy packs: identifier format, regions, programme parameters and
// disclosure-control thresholds. Adding a country means adding a JSON file in
// config/countries/, not changing code.

import { readFileSync } from 'node:fs';

export function loadCountry(code = process.env.COUNTRY || 'pk') {
  const url = new URL(`../config/countries/${code.toLowerCase()}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8'));
}

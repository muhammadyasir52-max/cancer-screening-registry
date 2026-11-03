// Synthetic demo population. Every name, ID number, date and result is
// randomly generated from a fixed seed; none of it describes a real person.
// ID numbers start with "99" and family names are obviously fake.

import { addDays, isoDate } from './rules.js';

const FEMALE = ['Ayesha', 'Fatima', 'Zainab', 'Maryam', 'Hira', 'Sana', 'Nadia', 'Amna', 'Rabia', 'Saima'];
const MALE = ['Ali', 'Usman', 'Bilal', 'Hamza', 'Imran', 'Kamran', 'Tariq', 'Faisal'];
const FAMILY = ['Placeholder', 'Sampleton', 'Testcase', 'Fixture', 'Dummy', 'Example', 'Mockdata', 'Synthetic'];
const PROVINCE_WEIGHTS = {
  Punjab: 0.5, Sindh: 0.25, 'Khyber Pakhtunkhwa': 0.15, Balochistan: 0.05,
  'Islamabad Capital Territory': 0.02, 'Gilgit-Baltistan': 0.015, 'Azad Jammu and Kashmir': 0.015,
};
// Which demo source serves each province.
export const HOME_SOURCE = {
  Punjab: 'lahore', 'Islamabad Capital Territory': 'lahore', 'Azad Jammu and Kashmir': 'lahore',
  Sindh: 'karachi', Balochistan: 'karachi', 'Khyber Pakhtunkhwa': 'kp', 'Gilgit-Baltistan': 'kp',
};
const PREFIX = { lahore: 'LHR', karachi: 'KHI', kp: 'KPM', registry: 'CR' };

// Small deterministic PRNG (mulberry32).
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SCREEN = {
  cervical: { sexes: ['female'], minAge: 25, uptake: 0.55, site: 'C53.9', morph: '8070' },
  breast: { sexes: ['female'], minAge: 40, uptake: 0.5, site: 'C50.9', morph: '8500' },
  colorectal: { sexes: ['female', 'male'], minAge: 50, uptake: 0.35, site: 'C18.9', morph: '8140' },
  oral: { sexes: ['female', 'male'], minAge: 30, uptake: 0.45, site: 'C06.9', morph: '8070' },
};

function screenResult(programme, rand, pick) {
  const r = rand();
  switch (programme) {
    case 'cervical':
      if (rand() < 0.3) return [{ test: 'via', result: r < 0.92 ? 'negative' : r < 0.98 ? 'positive' : 'invalid' }];
      if (r < 0.03) return [{ test: 'hpv', result: 'invalid' }];
      if (r < 0.12) return [{ test: 'hpv', result: 'positive' }, { test: 'cytology', result: pick(['NILM', 'NILM', 'NILM', 'ASC-US', 'LSIL', 'LSIL', 'HSIL', 'ASC-H', 'UNSAT']) }];
      return [{ test: 'hpv', result: 'negative' }];
    case 'breast':
      if (rand() < 0.25) return [{ test: 'cbe', result: r < 0.95 ? 'normal' : 'abnormal' }];
      return [{ test: 'mammography', result: r < 0.55 ? '1' : r < 0.85 ? '2' : r < 0.91 ? '3' : r < 0.96 ? '0' : r < 0.99 ? '4' : '5' }];
    case 'colorectal':
      return [{ test: 'fit', result: r < 0.92 ? 'negative' : r < 0.98 ? 'positive' : 'invalid' }];
    default:
      return [{ test: 'ove', result: r < 0.9 ? 'normal' : r < 0.98 ? 'suspicious' : 'inadequate' }];
  }
}

const ABNORMAL = {
  cervical: (rs) => rs.some((x) => ['ASC-US', 'LSIL', 'HSIL', 'ASC-H'].includes(x.result) || (x.test === 'via' && x.result === 'positive')),
  breast: (rs) => rs.some((x) => ['0', '4', '5', 'abnormal'].includes(x.result)),
  colorectal: (rs) => rs.some((x) => x.result === 'positive'),
  oral: (rs) => rs.some((x) => x.result === 'suspicious'),
};

/**
 * Generate canonical records grouped by demo source:
 * { lahore: [...], karachi: [...], kp: [...], registry: [...] }
 */
export function generateRecords(country, { count = 2500, seed = 2026, today = new Date() } = {}) {
  const rand = rng(seed);
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const chance = (p) => rand() < p;
  const now = isoDate(today);
  const out = { lahore: [], karachi: [], kp: [], registry: [] };
  const counters = { lahore: 0, karachi: 0, kp: 0, registry: 0 };
  const localId = (src) => `${PREFIX[src]}-${String(++counters[src]).padStart(6, '0')}`;
  const provinces = Object.entries(PROVINCE_WEIGHTS);

  for (let i = 0; i < count; i++) {
    let roll = rand();
    const province = provinces.find(([, w]) => (roll -= w) < 0)?.[0] || 'Punjab';
    const sex = chance(0.62) ? 'female' : 'male';
    const age = 22 + Math.floor(rand() * 56);
    const person = {
      cnic: `99${String(Math.floor(rand() * 1e3)).padStart(3, '0')}-${String(Math.floor(rand() * 1e7)).padStart(7, '0')}-${Math.floor(rand() * 10)}`,
      givenName: pick(sex === 'female' ? FEMALE : MALE),
      familyName: pick(FAMILY),
      sex,
      dateOfBirth: addDays(now, -Math.round((age + rand()) * 365.25)),
      district: pick(country.regions[province]),
      phone: `+92 300 ${String(1000000 + i).slice(-7)}`,
    };
    const home = HOME_SOURCE[province];
    const ids = { [home]: localId(home) };
    const rec = (src, extra) => {
      ids[src] ??= localId(src);
      out[src].push({ ...person, recordId: ids[src], ...extra });
    };

    if (chance(0.005)) rec(home, { event: 'opt-out', eventDate: addDays(now, -Math.floor(rand() * 300)) });

    for (const [programme, s] of Object.entries(SCREEN)) {
      if (!s.sexes.includes(sex) || age < s.minAge || !chance(s.uptake)) continue;
      // Some people are screened by a second source, which the pseudonym links.
      const src = chance(0.05) ? pick(['lahore', 'karachi', 'kp'].filter((x) => x !== home)) : home;
      if (src === 'kp' && programme === 'colorectal') continue; // not in the KP unit's agreement
      const date = addDays(now, -Math.floor(rand() ** 2 * 6 * 365));
      const results = screenResult(programme, rand, pick);
      for (const r of results) rec(src, { event: 'screen', programme, eventDate: date, test: r.test, result: r.result });

      if (ABNORMAL[programme](results)) {
        const followProb = date < addDays(now, -180) ? 0.95 : 0.55;
        if (!chance(followProb)) continue;
        const followUp = addDays(date, 10 + Math.floor(rand() * 50));
        if (followUp > now) continue;
        rec(src, { event: 'follow-up', programme, eventDate: followUp });
        const diagnosed = addDays(followUp, 20);
        if (chance(0.25) && diagnosed <= now) {
          rec('registry', { event: 'diagnosis', eventDate: diagnosed, topography: s.site, morphology: `${s.morph}/3` });
        }
      }
    }
    // Background cancers in people never screened, known only to the registry.
    if (chance(0.006) && age >= 30) {
      const s = SCREEN[pick(Object.keys(SCREEN).filter((p) => SCREEN[p].sexes.includes(sex)))];
      rec('registry', { event: 'diagnosis', eventDate: addDays(now, -Math.floor(rand() * 4 * 365)), topography: s.site, morphology: `${s.morph}/3` });
    }
  }
  return out;
}

import { systems, results } from '../fhir.js';

export default {
  id: 'colorectal',
  name: 'Colorectal',
  sexes: ['female', 'male'],
  // C18 colon, C19 rectosigmoid junction, C20 rectum.
  cancerSites: ['C18', 'C19', 'C20'],
  tests: {
    fit: {
      label: 'Faecal immunochemical test (FIT)',
      coding: { system: systems.loinc, code: '29771-3', display: 'Hemoglobin.gastrointestinal [Presence] in Stool by Immunoassay' },
      results: { positive: results.positive, negative: results.negative, invalid: results.invalid },
    },
  },
  followUp: { label: 'Colonoscopy', coding: { system: systems.snomed, code: '73761001', display: 'Colonoscopy' } },

  classifyEpisode({ fit }) {
    if (fit === 'positive') return 'abnormal';
    if (fit === 'negative') return 'negative';
    return 'inadequate';
  },
};

import { systems } from '../fhir.js';

const birads = `${systems.localResult}/bi-rads`;
const cbe = `${systems.localResult}/clinical-breast-exam`;

export default {
  id: 'breast',
  name: 'Breast',
  sexes: ['female'],
  cancerSites: ['C50'],
  tests: {
    mammography: {
      label: 'Screening mammogram (BI-RADS)',
      coding: { system: systems.loinc, code: '24606-6', display: 'MG Breast Screening' },
      results: Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map((c) => [c, { system: birads, code: c, display: `BI-RADS ${c}` }])),
    },
    cbe: {
      label: 'Clinical breast examination',
      coding: { system: systems.localTest, code: 'cbe', display: 'Clinical breast examination' },
      results: {
        normal: { system: cbe, code: 'normal', display: 'No abnormality detected' },
        abnormal: { system: cbe, code: 'abnormal', display: 'Lump or other abnormality found' },
      },
    },
  },
  followUp: { label: 'Diagnostic breast assessment', coding: { system: systems.followUp, code: 'breast-assessment', display: 'Diagnostic breast assessment (imaging and/or biopsy)' } },

  // BI-RADS 0 (incomplete), 4, 5 and 6 need assessment; 3 is a short-interval recall.
  classifyEpisode({ mammography, cbe }) {
    if (['0', '4', '5', '6'].includes(mammography) || cbe === 'abnormal') return 'abnormal';
    if (mammography === '3') return 'early-recall';
    if (['1', '2'].includes(mammography) || cbe === 'normal') return 'negative';
    return 'inadequate';
  },
};

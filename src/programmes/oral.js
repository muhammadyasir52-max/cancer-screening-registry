import { systems } from '../fhir.js';

const ove = `${systems.localResult}/oral-visual-exam`;

export default {
  id: 'oral',
  name: 'Oral',
  sexes: ['female', 'male'],
  // C00–C06: lip, tongue, gum, floor of mouth, palate, other mouth.
  cancerSites: ['C00', 'C01', 'C02', 'C03', 'C04', 'C05', 'C06'],
  tests: {
    ove: {
      label: 'Oral visual examination',
      coding: { system: systems.localTest, code: 'oral-visual-exam', display: 'Oral visual examination' },
      results: {
        normal: { system: ove, code: 'normal', display: 'No lesion seen' },
        suspicious: { system: ove, code: 'suspicious', display: 'Suspicious lesion (e.g. leukoplakia, erythroplakia, non-healing ulcer)' },
        inadequate: { system: ove, code: 'inadequate', display: 'Examination incomplete' },
      },
    },
  },
  followUp: { label: 'Specialist oral assessment', coding: { system: systems.followUp, code: 'oral-assessment', display: 'Specialist oral assessment and/or biopsy' } },

  classifyEpisode({ ove }) {
    if (ove === 'suspicious') return 'abnormal';
    if (ove === 'normal') return 'negative';
    return 'inadequate';
  },
};

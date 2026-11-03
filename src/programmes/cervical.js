import { systems, results } from '../fhir.js';

const bethesda = `${systems.localResult}/bethesda`;
const cyto = (code, display) => ({ system: bethesda, code, display });

export default {
  id: 'cervical',
  name: 'Cervical',
  sexes: ['female'],
  // ICD-O-3 topography C53 (cervix uteri).
  cancerSites: ['C53'],
  tests: {
    hpv: {
      label: 'HPV test',
      coding: { system: systems.loinc, code: '21440-3', display: 'Human papilloma virus 16+18+31+33+35+45+51+52+56 DNA [Presence] in Cervix by Probe' },
      results: { positive: results.positive, negative: results.negative, invalid: results.invalid },
    },
    cytology: {
      label: 'Cervical cytology',
      coding: { system: systems.loinc, code: '10524-7', display: 'Microscopic observation [Identifier] in Cervix by Cyto stain' },
      results: {
        NILM: cyto('NILM', 'Negative for intraepithelial lesion or malignancy'),
        'ASC-US': cyto('ASC-US', 'Atypical squamous cells of undetermined significance'),
        LSIL: cyto('LSIL', 'Low-grade squamous intraepithelial lesion'),
        'ASC-H': cyto('ASC-H', 'Atypical squamous cells, cannot exclude HSIL'),
        HSIL: cyto('HSIL', 'High-grade squamous intraepithelial lesion'),
        AGC: cyto('AGC', 'Atypical glandular cells'),
        SCC: cyto('SCC', 'Squamous cell carcinoma'),
        UNSAT: cyto('UNSAT', 'Unsatisfactory for evaluation'),
      },
    },
    via: {
      label: 'Visual inspection with acetic acid (VIA)',
      coding: { system: systems.localTest, code: 'via', display: 'Visual inspection with acetic acid' },
      results: { positive: results.positive, negative: results.negative, invalid: results.invalid },
    },
  },
  followUp: { label: 'Colposcopy', coding: { system: systems.snomed, code: '392003006', display: 'Colposcopy' } },

  classifyEpisode({ hpv, cytology, via }) {
    if (cytology && !['NILM', 'UNSAT'].includes(cytology)) return 'abnormal';
    if (via === 'positive') return 'abnormal';
    if (hpv === 'positive' && !cytology) return 'abnormal'; // needs triage
    if (hpv === 'positive' && cytology === 'NILM') return 'early-recall';
    if (hpv === 'invalid' || cytology === 'UNSAT' || via === 'invalid') return 'inadequate';
    if (hpv === 'negative' || cytology === 'NILM' || via === 'negative') return 'negative';
    return 'inadequate';
  },
};

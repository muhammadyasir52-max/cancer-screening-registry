import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, addMonths, STATUS } from '../src/rules.js';
import { programmes } from '../src/programmes/index.js';
import { loadCountry } from '../src/country.js';
import { buildPatient, buildObservation, buildProcedure, buildCondition } from '../src/fhir.js';

const TODAY = '2026-06-15';
const pk = loadCountry('pk');
const subject = { reference: 'Patient/p1' };
const person = (birthMonth, sex = 'female') => ({ ...buildPatient({ pseudonym: 'x', birthMonth, sex, district: 'Lahore', province: 'Punjab', country: 'PK' }), id: 'p1' });
const obs = (prog, testKey, result, date) => {
  const t = programmes[prog].tests[testKey];
  return buildObservation({ subject, date, test: t, value: t.results[result] });
};
const follow = (prog, date) => buildProcedure({ subject, date, coding: programmes[prog].followUp.coding, label: 'x' });
const run = (prog, input) => evaluate(input, programmes[prog], pk.programmes[prog], TODAY);

test('classifies episodes for every programme', () => {
  assert.equal(programmes.cervical.classifyEpisode({ hpv: 'positive', cytology: 'NILM' }), 'early-recall');
  assert.equal(programmes.cervical.classifyEpisode({ hpv: 'positive' }), 'abnormal');
  assert.equal(programmes.cervical.classifyEpisode({ via: 'positive' }), 'abnormal');
  assert.equal(programmes.breast.classifyEpisode({ mammography: '3' }), 'early-recall');
  assert.equal(programmes.breast.classifyEpisode({ mammography: '0' }), 'abnormal');
  assert.equal(programmes.breast.classifyEpisode({ cbe: 'normal' }), 'negative');
  assert.equal(programmes.colorectal.classifyEpisode({ fit: 'positive' }), 'abnormal');
  assert.equal(programmes.colorectal.classifyEpisode({ fit: 'invalid' }), 'inadequate');
  assert.equal(programmes.oral.classifyEpisode({ ove: 'suspicious' }), 'abnormal');
});

test('addMonths clamps to the end of short months', () => {
  assert.equal(addMonths('2024-01-31', 1), '2024-02-29');
});

test('eligibility depends on programme sex and age range', () => {
  const man = person('1960-01', 'male');
  assert.equal(run('cervical', { patient: man }).status, STATUS.NOT_ELIGIBLE);
  assert.equal(run('breast', { patient: man }).status, STATUS.NOT_ELIGIBLE);
  assert.equal(run('colorectal', { patient: man }).status, STATUS.OVERDUE);
  assert.equal(run('oral', { patient: man }).status, STATUS.OVERDUE);
  assert.equal(run('breast', { patient: person('1995-01') }).status, STATUS.NOT_ELIGIBLE);
});

test('never screened raises never-screened, due from the first eligible birthday', () => {
  const r = run('cervical', { patient: person('1990-01') });
  assert.equal(r.dueDate, '2015-01-01');
  assert.deepEqual(r.alerts.map((a) => a.code), ['never-screened']);
});

test('routine intervals come from the country pack', () => {
  assert.equal(run('cervical', { patient: person('1990-01'), observations: [obs('cervical', 'hpv', 'negative', '2025-02-01')] }).dueDate, '2028-02-01');
  assert.equal(run('breast', { patient: person('1970-01'), observations: [obs('breast', 'mammography', '1', '2025-03-01')] }).dueDate, '2027-03-01');
  assert.equal(run('colorectal', { patient: person('1960-01'), observations: [obs('colorectal', 'fit', 'negative', '2025-03-01')] }).dueDate, '2027-03-01');
});

test('BI-RADS 3 gives a 6-month early recall', () => {
  const r = run('breast', { patient: person('1970-01'), observations: [obs('breast', 'mammography', '3', '2026-02-01')] });
  assert.equal(r.dueDate, '2026-08-01');
  assert.equal(r.status, STATUS.DUE_SOON);
});

test('abnormal result alerts, escalates, and clears on follow-up', () => {
  const fresh = run('colorectal', { patient: person('1960-01'), observations: [obs('colorectal', 'fit', 'positive', '2026-06-01')] });
  assert.equal(fresh.status, STATUS.ABNORMAL);
  assert.deepEqual(fresh.alerts.map((a) => a.code), ['abnormal-result']);

  const late = run('oral', { patient: person('1960-01'), observations: [obs('oral', 'ove', 'suspicious', '2026-04-01')] });
  assert.deepEqual(late.alerts.map((a) => a.code), ['follow-up-overdue']);

  const done = run('colorectal', {
    patient: person('1960-01'),
    observations: [obs('colorectal', 'fit', 'positive', '2026-03-01')],
    procedures: [follow('colorectal', '2026-03-20')],
  });
  assert.equal(done.status, STATUS.UP_TO_DATE);
  assert.equal(done.dueDate, '2029-03-20');
  assert.deepEqual(done.alerts, []);
});

test('a follow-up for another programme does not clear the alert', () => {
  const r = run('cervical', {
    patient: person('1980-01'),
    observations: [obs('cervical', 'hpv', 'positive', '2026-06-01'), obs('cervical', 'cytology', 'HSIL', '2026-06-01')],
    procedures: [follow('colorectal', '2026-06-10')],
  });
  assert.equal(r.status, STATUS.ABNORMAL);
});

test('a cancer recorded by a registry takes the person out of that programme only', () => {
  const input = {
    patient: person('1970-01'),
    conditions: [buildCondition({ subject, date: '2026-01-10', topography: 'C50.9', morphology: '8500/3' })],
  };
  assert.equal(run('breast', input).status, STATUS.DIAGNOSED);
  assert.deepEqual(run('breast', input).alerts, []);
  assert.equal(run('cervical', input).status, STATUS.OVERDUE);
});

test('opted-out people get no status or alerts', () => {
  const r = run('cervical', { patient: person('1980-01'), optedOut: true });
  assert.equal(r.status, STATUS.OPTED_OUT);
  assert.deepEqual(r.alerts, []);
});

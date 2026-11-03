// Generic screening rules engine. Pure functions: given one person's FHIR
// resources, a programme definition and its parameters, work out the person's
// status in that programme and which alerts apply.

import { identifyObservation, identifyProcedure, programmeForSite } from './programmes/index.js';
import { systems, codeIn } from './fhir.js';

export const STATUS = {
  NOT_ELIGIBLE: 'not-eligible',
  UP_TO_DATE: 'up-to-date',
  DUE_SOON: 'due-soon',
  OVERDUE: 'overdue',
  ABNORMAL: 'abnormal',
  DIAGNOSED: 'diagnosed',
  OPTED_OUT: 'opted-out',
};

export const OUTCOMES = ['negative', 'early-recall', 'abnormal', 'inadequate'];

export function ageOn(birthDate, date) {
  const b = new Date(birthDate);
  const d = new Date(date);
  let age = d.getUTCFullYear() - b.getUTCFullYear();
  const m = d.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && d.getUTCDate() < b.getUTCDate())) age--;
  return age;
}

export function addMonths(date, months) {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return isoDate(d);
}

export const addDays = (date, days) => isoDate(new Date(new Date(date).getTime() + days * 86400000));
export const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
export const isoDate = (d) => new Date(d).toISOString().slice(0, 10);

// Collapse one programme's Observations into dated episodes, newest first.
export function episodesFor(programme, observations) {
  const byDate = new Map();
  for (const obs of observations) {
    if (obs.status === 'entered-in-error' || obs.status === 'cancelled') continue;
    const id = identifyObservation(obs);
    if (!id || id.programme.id !== programme.id) continue;
    const date = (obs.effectiveDateTime || '').slice(0, 10);
    if (!date) continue;
    const ep = byDate.get(date) || { date, results: {} };
    ep.results[id.testKey] = id.result || 'invalid';
    byDate.set(date, ep);
  }
  return [...byDate.values()]
    .map((ep) => ({ ...ep, outcome: programme.classifyEpisode(ep.results) }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

function routineMonths(age, params) {
  const band = params.intervals.find((i) => age >= i.minAge && age <= i.maxAge);
  return band ? band.months : params.intervals[params.intervals.length - 1].months;
}

/**
 * Evaluate one person in one programme.
 * @returns {{programme, status, age, eligible, dueDate, lastScreen, lastOutcome, neverScreened, diagnosed, alerts: {code, detail}[]}}
 */
export function evaluate({ patient, observations = [], procedures = [], conditions = [], optedOut = false }, programme, params, asOf) {
  const today = isoDate(asOf);
  const age = ageOn(patient.birthDate, today);
  const eligible = patient.active !== false && programme.sexes.includes(patient.gender)
    && age >= params.eligibleAge.min && age <= params.eligibleAge.max;

  const episodes = episodesFor(programme, observations);
  const last = episodes[0];
  const diagnosis = conditions
    .filter((c) => programmeForSite(codeIn(c.bodySite?.[0], systems.icdo3))?.id === programme.id)
    .map((c) => (c.onsetDateTime || '').slice(0, 10))
    .sort()[0];

  const result = {
    programme: programme.id,
    age,
    eligible,
    lastScreen: last?.date || null,
    lastOutcome: last?.outcome || null,
    neverScreened: !last,
    diagnosed: diagnosis || null,
    dueDate: null,
    status: null,
    alerts: [],
  };

  if (optedOut) {
    result.status = STATUS.OPTED_OUT;
    return result;
  }
  // A recorded cancer takes the person out of screening for that site.
  if (diagnosis) {
    result.status = STATUS.DIAGNOSED;
    return result;
  }

  const followUps = procedures
    .filter((p) => p.status === 'completed' && identifyProcedure(p)?.id === programme.id)
    .map((p) => p.performedDateTime.slice(0, 10))
    .sort();

  // An abnormal result needs follow-up whatever the person's age.
  if (last?.outcome === 'abnormal') {
    const followUp = followUps.find((d) => d >= last.date);
    if (!followUp) {
      const waited = daysBetween(last.date, today);
      const detail = `${programme.name}: ${describe(programme, last)} on ${last.date}`;
      result.status = STATUS.ABNORMAL;
      result.dueDate = addDays(last.date, params.abnormalFollowUpDays);
      result.alerts.push(waited > params.abnormalFollowUpDays
        ? { code: 'follow-up-overdue', detail: `${detail}; no ${programme.followUp.label.toLowerCase()} after ${waited} days` }
        : { code: 'abnormal-result', detail: `${detail}: refer for ${programme.followUp.label.toLowerCase()}` });
      return result;
    }
    result.dueDate = addMonths(followUp, params.postFollowUpRecallMonths);
  } else if (last) {
    const months = last.outcome === 'early-recall' ? params.earlyRecallMonths
      : last.outcome === 'inadequate' ? params.inadequateRepeatMonths
        : routineMonths(ageOn(patient.birthDate, last.date), params);
    result.dueDate = addMonths(last.date, months);
  } else {
    // Never screened: due from the first eligible birthday.
    result.dueDate = addMonths(patient.birthDate, params.eligibleAge.min * 12);
  }

  if (!eligible) {
    result.status = STATUS.NOT_ELIGIBLE;
    return result;
  }

  if (result.dueDate < today) {
    result.status = STATUS.OVERDUE;
    result.alerts.push(result.neverScreened
      ? { code: 'never-screened', detail: `${programme.name}: eligible since ${result.dueDate}; no screening on record` }
      : { code: 'overdue', detail: `${programme.name}: due ${result.dueDate} (last screened ${result.lastScreen})` });
  } else if (daysBetween(today, result.dueDate) <= params.dueSoonDays) {
    result.status = STATUS.DUE_SOON;
  } else {
    result.status = STATUS.UP_TO_DATE;
  }
  return result;
}

function describe(programme, ep) {
  return Object.entries(ep.results)
    .map(([k, v]) => `${programme.tests[k].label} ${programme.tests[k].results[v]?.display || v}`)
    .join(', ');
}

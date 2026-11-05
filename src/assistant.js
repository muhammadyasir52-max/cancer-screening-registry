// Optional AI assistant for the Data Quality Studio.
//
// SWITCHED OFF in the MVP. It is enabled only when ASSISTANT_ENABLED=1 and an
// Anthropic credential is configured, after funding and governance approval
// (see GOVERNANCE.md, "AI and data quality").
//
// Privacy: the assistant only ever receives the validated aggregate quality
// summary (counts and scores per check) and a staff question. It never sees
// rows, names, ID numbers, record numbers or dates. The caller validates the
// summary with validateQualitySummary() before it gets here.

import { explainSummary } from './quality/summary.js';
import { CHECKS } from './quality/index.js';

const MODEL = 'claude-opus-5-5';

const SYSTEM = `You help hospital data staff in a national cancer screening registry understand a data-quality report for a file they are about to submit.
You receive only an aggregate summary: an overall score, scores per dimension, and for each check how many queries and rows it affected. You never see patient data.
Explain in plain language what the findings mean, which to fix first and why, and how to fix them in the source system. Critical findings exclude rows from the submission until resolved.
Be concise and practical. Do not invent numbers that are not in the summary. Do not give clinical advice about individual patients.`;

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['explanation', 'priorities', 'suggestedActions'],
  properties: {
    explanation: { type: 'string' },
    priorities: { type: 'array', items: { type: 'string' } },
    suggestedActions: { type: 'array', items: { type: 'string' } },
  },
};

// Local answer used when the assistant is off, refuses, or errors.
function localAnswer(summary, note) {
  const e = explainSummary(summary);
  return { source: 'local', note, explanation: e.headline, priorities: e.bullets, suggestedActions: e.actions };
}

export function createAssistant({
  enabled = process.env.ASSISTANT_ENABLED === '1' && Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
  client = null,
} = {}) {
  let sdk = null;

  async function getClient() {
    if (client) return client;
    // Loaded only when the assistant is switched on, so the registry itself has no dependencies.
    sdk ??= (await import('@anthropic-ai/sdk')).default;
    client = new sdk();
    return client;
  }

  async function ask(summary, question) {
    // Give the model the check titles so it can explain them; still aggregate only.
    const described = {
      ...summary,
      fileSha256: undefined,
      checks: Object.fromEntries(Object.entries(summary.checks).map(([id, c]) => [id, { ...c, title: CHECKS[id].title, dimension: CHECKS[id].dimension }])),
    };
    try {
      const api = await getClient();
      const response = await api.beta.messages.create({
        model: MODEL,
        max_tokens: 4000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: RESPONSE_SCHEMA } },
        system: SYSTEM,
        messages: [{
          role: 'user',
          content: `Data-quality summary (aggregate only):\n${JSON.stringify(described)}\n\nStaff question: ${question || 'What should we fix first, and how?'}`,
        }],
      });
      if (response.stop_reason === 'refusal') return localAnswer(summary, 'The assistant declined this request; showing the built-in explanation.');
      const text = response.content.find((b) => b.type === 'text')?.text;
      const parsed = JSON.parse(text);
      return { source: 'claude', model: response.model, ...parsed };
    } catch (err) {
      console.error('Assistant error:', err?.status || '', err?.message || err);
      // Configuration problems (bad key, bad request) must be visible to the
      // operator: surface them as a 502, which also lands in the audit log.
      // Rate limits, overload and network failures fall back to the local answer.
      if (err?.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) {
        throw Object.assign(new Error('The AI assistant is misconfigured. Ask the registry operator to check its settings.'), { status: 502 });
      }
      return localAnswer(summary, 'The assistant is unavailable right now; showing the built-in explanation.');
    }
  }

  return { enabled, ask };
}

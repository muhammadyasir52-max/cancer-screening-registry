// Minimal RFC 4180-style parser for comma, semicolon or tab separated files.
// Returns one object per row keyed by the header line.

export function parseDelimited(text, delimiter) {
  const clean = text.replace(/^﻿/, '');
  const firstLine = clean.slice(0, clean.indexOf('\n') >>> 0);
  const sep = delimiter || ['\t', ';', ','].sort((a, b) => count(firstLine, b) - count(firstLine, a))[0];

  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (quoted) {
      if (c === '"' && clean[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && clean[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v !== '')) rows.push(row);

  const [header = [], ...body] = rows;
  const keys = header.map((h) => h.trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

const count = (s, ch) => s.split(ch).length - 1;

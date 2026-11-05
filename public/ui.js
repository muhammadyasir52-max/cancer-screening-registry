// Shared UI helpers and dependency-free charts for every page.
// All values are escaped before they reach innerHTML.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const $ = (id) => document.getElementById(id);

let threshold = 5;
export const setThreshold = (t) => { threshold = t; };
// Suppressed counts arrive as null and are shown as "<5".
export const fmt = (n) => (n === null || n === undefined ? `<${threshold}` : Number(n).toLocaleString('en'));
export const pct = (p) => (p === null || p === undefined ? '—' : `${p}%`);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthLabel = (ym) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(2, 4)}`;

// --- Status badges (colour is never the only signal: icon + label) ---------
const STATUS = {
  good: ['good', '✓'], warning: ['warning', '!'], serious: ['serious', '!'], critical: ['critical', '✕'], info: ['info', 'i'], neutral: ['neutral', '·'],
};
export function badge(label, kind = 'neutral') {
  const [cls, icon] = STATUS[kind] || STATUS.neutral;
  return `<span class="badge ${cls}"><span class="dot" aria-hidden="true"></span><span class="sr-only">${esc(kind)}: </span>${esc(label)}<span class="status-icon" aria-hidden="true">${icon === '·' ? '' : ` ${icon}`}</span></span>`;
}

export function toast(message) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), 3500);
}

// --- Tooltip: any element with data-tip shows it on hover and focus ---------
let tipEl;
function showTip(target, x, y) {
  tipEl ??= Object.assign(document.createElement('div'), { className: 'tooltip', role: 'tooltip' });
  if (!tipEl.isConnected) document.body.append(tipEl);
  tipEl.textContent = target.dataset.tip;
  const w = tipEl.offsetWidth;
  tipEl.style.left = `${Math.min(window.innerWidth - w - 8, Math.max(8, x + 12))}px`;
  tipEl.style.top = `${Math.max(8, y - 36)}px`;
}
document.addEventListener('mouseover', (e) => { const t = e.target.closest('[data-tip]'); if (t) showTip(t, e.clientX, e.clientY); });
document.addEventListener('mousemove', (e) => { const t = e.target.closest('[data-tip]'); if (t && tipEl?.isConnected) showTip(t, e.clientX, e.clientY); });
document.addEventListener('mouseout', (e) => { if (e.target.closest('[data-tip]')) tipEl?.remove(); });
document.addEventListener('focusin', (e) => { const t = e.target.closest('[data-tip]'); if (t) { const r = t.getBoundingClientRect(); showTip(t, r.left, r.top); } });
document.addEventListener('focusout', () => tipEl?.remove());

// --- Charts -------------------------------------------------------------------

// Small table view behind every chart (accessibility and exact values).
export function tableView(headers, rows) {
  return `<details class="table-view"><summary>Show as table</summary><div class="table-wrap"><table>
    <thead><tr>${headers.map((h, i) => `<th${i ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${i ? ' class="num"' : ''}>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`;
}

/** Horizontal percentage bars with an optional target marker. rows: [{ label, value (0-100 or null), note }] */
export function percentBars(rows, { target = null, valueLabel = 'Coverage' } = {}) {
  const t = target?.percent ?? null;
  const html = rows.map((r) => {
    const v = r.value;
    const below = t !== null && v !== null && v < t;
    const tip = `${r.label}: ${pct(v)}${r.note ? ` · ${r.note}` : ''}${t !== null ? ` · target ${t}%` : ''}`;
    return `<div class="bar-row">
      <span class="label">${esc(r.label)}</span>
      <span class="track" role="img" aria-label="${esc(tip)}" data-tip="${esc(tip)}" tabindex="0">
        ${v === null ? '' : `<span class="fill${below ? ' below' : ''}" style="width:${Math.max(0, Math.min(100, v))}%"></span>`}
        ${t !== null ? `<span class="target" style="left:calc(${t}% - 1px)" aria-hidden="true"></span>` : ''}
      </span>
      <span class="num">${esc(pct(v))}</span>
    </div>`;
  }).join('');
  const legend = `<div class="chart-legend"><span><span class="swatch" style="background:var(--s1)"></span>${esc(valueLabel)}${t !== null ? ' at or above target' : ''}</span>${t !== null ? `<span><span class="swatch" style="background:var(--seq-300)"></span>Below target</span><span><span class="tick"></span>${esc(target.label || 'Target')}: ${t}%</span>` : ''}</div>`;
  return html + legend + tableView(['Group', valueLabel], rows.map((r) => [r.label, pct(r.value)]));
}

/** Monthly column chart. data: [{ month: 'YYYY-MM', screens (number|null) }]. The last month may be partial. */
export function columnChart(data, { partialLast = true, label = 'Screens' } = {}) {
  const W = 560; const H = 200; const padL = 34; const padB = 26; const padT = 10;
  const known = data.map((d) => d.screens ?? 0);
  const max = Math.max(threshold, ...known);
  // Round up so the mid gridline is a whole number too.
  const step = max > 50 ? 20 : max > 10 ? 10 : 2;
  const niceMax = Math.ceil(max / step) * step;
  const bw = (W - padL) / data.length;
  const y = (v) => padT + (H - padT - padB) * (1 - v / niceMax);
  const ticks = [0, niceMax / 2, niceMax];
  let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${label} per month, last ${data.length} months`)}">`;
  for (const t of ticks) svg += `<line class="gridline" x1="${padL}" x2="${W}" y1="${y(t)}" y2="${y(t)}"/><text x="${padL - 6}" y="${y(t) + 4}" text-anchor="end">${t}</text>`;
  data.forEach((d, i) => {
    const x = padL + i * bw;
    const partial = partialLast && i === data.length - 1;
    const tip = `${monthLabel(d.month)}${partial ? ' (so far)' : ''}: ${fmt(d.screens)} ${label.toLowerCase()}`;
    if (d.screens === null) {
      svg += `<text x="${x + bw / 2}" y="${y(0) - 4}" text-anchor="middle">&lt;${threshold}</text>`;
    } else if (d.screens > 0) {
      const top = y(d.screens);
      const h = y(0) - top;
      const w = Math.max(4, bw - 8);
      const r = Math.min(4, h / 2);
      svg += `<path class="col${partial ? ' partial' : ''}" d="M${x + 4},${y(0)} V${top + r} q0,-${r} ${r},-${r} H${x + 4 + w - r} q${r},0 ${r},${r} V${y(0)} Z"/>`;
    }
    svg += `<rect class="hit" x="${x}" y="${padT}" width="${bw}" height="${H - padT - padB}" data-tip="${esc(tip)}" tabindex="0" aria-label="${esc(tip)}"/>`;
    if (i % 2 === data.length % 2 || data.length <= 6) svg += `<text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${esc(monthLabel(d.month))}</text>`;
  });
  svg += `<line class="baseline" x1="${padL}" x2="${W}" y1="${y(0)}" y2="${y(0)}"/></svg>`;
  const legend = partialLast ? `<div class="chart-legend"><span><span class="swatch" style="background:var(--s1)"></span>${esc(label)}</span><span><span class="swatch" style="background:var(--seq-200)"></span>Current month so far</span></div>` : '';
  return svg + legend + tableView(['Month', label], data.map((d) => [monthLabel(d.month), fmt(d.screens)]));
}

/** Screening cascade: nested steps, widths relative to the first. steps: [{ label, value }] */
export function cascade(steps) {
  const first = steps[0]?.value || 0;
  const colours = ['var(--seq-700)', 'var(--seq-600)', 'var(--seq-500)', 'var(--seq-400)'];
  const html = steps.map((s, i) => {
    const prev = steps[i - 1];
    const width = first && s.value !== null ? Math.max(3, (s.value / first) * 100) : 3;
    const rate = i && prev?.value && s.value !== null ? `${Math.round((s.value / prev.value) * 100)}% of ${prev.label.toLowerCase()}` : '';
    const tip = `${s.label}: ${fmt(s.value)}${rate ? ` (${rate})` : ''}`;
    return `<div class="cascade-row">
      <span>${esc(s.label)}${rate ? `<br><span class="rate">${esc(rate)}</span>` : ''}</span>
      <span style="display:flex;align-items:center;gap:8px;min-width:0">
        <span class="cascade-bar" style="width:${width}%;background:${colours[i] || colours[3]}" data-tip="${esc(tip)}" tabindex="0" role="img" aria-label="${esc(tip)}"></span>
        <strong>${esc(fmt(s.value))}</strong>
      </span>
    </div>`;
  }).join('');
  return html + tableView(['Step', 'People', 'Of previous step'], steps.map((s, i) => [s.label, fmt(s.value),
    i && steps[i - 1].value && s.value !== null ? `${Math.round((s.value / steps[i - 1].value) * 100)}%` : '—']));
}

/** Single stacked bar of parts of a whole, with legend. parts: [{ label, value (number|null) }] (max 4 series) */
export function stackedBar(parts) {
  const colours = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)'];
  const total = parts.reduce((a, p) => a + (p.value || 0), 0);
  const segs = parts.map((p, i) => {
    if (!p.value || !total) return '';
    const tip = `${p.label}: ${fmt(p.value)} (${Math.round((p.value / total) * 100)}%)`;
    return `<span style="flex:${p.value} 0 0;background:${colours[i]}" data-tip="${esc(tip)}" tabindex="0" role="img" aria-label="${esc(tip)}"></span>`;
  }).join('');
  const legend = `<div class="chart-legend">${parts.map((p, i) => `<span><span class="swatch" style="background:${colours[i]}"></span>${esc(p.label)}: <strong>${esc(fmt(p.value))}</strong></span>`).join('')}</div>`;
  return `<div class="stack">${segs}</div>${legend}${tableView(['Result', 'People'], parts.map((p) => [p.label, fmt(p.value)]))}`;
}

/** Coverage colour for heat-table cells (sequential blue), with readable text. */
export function heatStyle(p) {
  if (p === null || p === undefined) return '';
  const step = p >= 70 ? 700 : p >= 55 ? 600 : p >= 40 ? 500 : p >= 25 ? 400 : p >= 10 ? 300 : 200;
  const dark = matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme !== 'light'
    || document.documentElement.dataset.theme === 'dark';
  const lightText = dark ? step <= 400 : step >= 500;
  return `background:var(--seq-${step});color:${lightText ? '#ffffff' : '#0b0b0b'}`;
}

export function scoreRing(score) {
  const colour = score >= 90 ? 'var(--good)' : score >= 75 ? 'var(--warning)' : 'var(--critical)';
  return `<div class="score-ring" style="--v:${score};--ring:${colour}" role="img" aria-label="Quality score ${score} out of 100"><div>${score}</div></div>`;
}

// --- Data table: search, sort, pagination, empty and loading states ----------
export function dataTable(container, { columns, rows, pageSize = 25, searchable = true, rowClass = () => '', empty = 'Nothing to show.', tools = '' }) {
  const state = { q: '', page: 0, sort: null, dir: 1 };
  const text = (r) => columns.map((c) => (c.text ? c.text(r) : r[c.key])).join(' ').toLowerCase();
  function render() {
    let list = rows.filter((r) => !state.q || text(r).includes(state.q));
    if (state.sort) {
      const c = columns.find((x) => x.key === state.sort);
      const v = (r) => (c.sortValue ? c.sortValue(r) : r[c.key]) ?? '';
      list = [...list].sort((a, b) => (v(a) > v(b) ? 1 : v(a) < v(b) ? -1 : 0) * state.dir);
    }
    const pages = Math.max(1, Math.ceil(list.length / pageSize));
    state.page = Math.min(state.page, pages - 1);
    const shown = list.slice(state.page * pageSize, (state.page + 1) * pageSize);
    container.innerHTML = `
      <div class="table-tools">${searchable ? `<input type="search" placeholder="Search" aria-label="Search table" value="${esc(state.q)}">` : '<span></span>'}<div class="actions">${tools}</div></div>
      <div class="table-wrap"><table>
        <thead><tr>${columns.map((c) => `<th class="${c.num ? 'num' : ''}" aria-sort="${state.sort === c.key ? (state.dir > 0 ? 'ascending' : 'descending') : 'none'}">${c.sortable === false ? esc(c.label) : `<button class="sort" data-key="${esc(c.key)}">${esc(c.label)}${state.sort === c.key ? (state.dir > 0 ? ' ▲' : ' ▼') : ''}</button>`}</th>`).join('')}</tr></thead>
        <tbody>${shown.length ? shown.map((r) => `<tr class="${rowClass(r)}">${columns.map((c) => `<td class="${c.num ? 'num' : ''}">${c.html ? c.html(r) : esc(r[c.key])}</td>`).join('')}</tr>`).join('')
          : `<tr><td colspan="${columns.length}" class="empty">${esc(state.q ? 'No matches.' : empty)}</td></tr>`}</tbody>
      </table></div>
      <div class="pager"><span>${list.length.toLocaleString('en')} ${list.length === 1 ? 'row' : 'rows'}</span>
        <button class="btn secondary small" data-page="-1" ${state.page === 0 ? 'disabled' : ''}>Previous</button>
        <span>Page ${state.page + 1} of ${pages}</span>
        <button class="btn secondary small" data-page="1" ${state.page >= pages - 1 ? 'disabled' : ''}>Next</button></div>`;
    const search = container.querySelector('input[type="search"]');
    search?.addEventListener('input', (e) => {
      state.q = e.target.value.toLowerCase(); state.page = 0; render();
      const s = container.querySelector('input[type="search"]'); s.focus(); s.setSelectionRange(s.value.length, s.value.length);
    });
    container.querySelectorAll('button.sort').forEach((b) => b.addEventListener('click', () => {
      state.dir = state.sort === b.dataset.key ? -state.dir : 1; state.sort = b.dataset.key; render();
      container.querySelector(`button.sort[data-key="${CSS.escape(b.dataset.key)}"]`)?.focus();
    }));
    container.querySelectorAll('button[data-page]').forEach((b) => b.addEventListener('click', () => { state.page += Number(b.dataset.page); render(); }));
  }
  render();
  return { update(newRows) { rows = newRows; state.page = 0; render(); } };
}

export function loadingTable(container, cols = 5, rowsCount = 6) {
  container.innerHTML = `<div class="table-wrap" aria-busy="true"><table><tbody>${Array.from({ length: rowsCount }, () =>
    `<tr>${Array.from({ length: cols }, () => '<td><div class="skeleton"></div></td>').join('')}</tr>`).join('')}</tbody></table></div><p class="sr-only" role="status">Loading…</p>`;
}

export function downloadCsv(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const csvCell = (v) => {
  const s = String(v ?? '');
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
export const toCsv = (header, rows) => [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';

// Shared header and footer.
const LOGO = `<svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true"><rect width="34" height="34" rx="9" fill="var(--accent)"/><path d="M17 7.5c-3.6 3.4-6 6.9-6 10.2a6 6 0 0 0 12 0c0-3.3-2.4-6.8-6-10.2Z" fill="none" stroke="var(--on-accent)" stroke-width="2.2"/><path d="M13.6 18.6l2.4 2.4 4.4-4.6" fill="none" stroke="var(--on-accent)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
export function chrome(page, { publicSite = false, sourceUrl = '' } = {}) {
  const links = publicSite
    ? [['Dashboard', './', 'dashboard'], ['Source code', sourceUrl, 'source']]
    : [['Dashboard', './', 'dashboard'], ['Facility portal', 'portal', 'portal'], ['Administration', 'admin', 'admin']];
  const header = document.querySelector('header.topbar');
  if (header) {
    header.innerHTML = `<div class="wrap"><a class="brand" href="./">${LOGO}<span>Cancer Screening Registry<small>Open, de-identified, standards-based</small></span></a>
      <nav class="nav" aria-label="Main">${links.map(([label, href, id]) => `<a href="${esc(href)}"${id === page ? ' aria-current="page"' : ''}>${esc(label)}</a>`).join('')}</nav></div>`;
  }
  const footer = document.querySelector('footer.site');
  if (footer) {
    footer.innerHTML = `<div class="wrap"><span>Owned by <strong>RHEAP</strong> · Developed by <strong>BYTEBUZ</strong> · Open source (MIT) · HL7 FHIR R4</span><span>Demonstration with synthetic data only</span></div>`;
  }
}

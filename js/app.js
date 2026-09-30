import {
  DEFAULT_DRILL, DEFAULT_TONES, TONE_GAP_EXTRA, validate, buildPlan, timeline, planLength, drillLabel, completedBySteps,
} from './drill.js';
import { TonePlayer, verifyTiming } from './audio.js';
import { DrillRunner } from './runner.js';
import * as db from './db.js';
import { windows, byPar, stamp } from './stats.js';
import { isSqlite, readLegacyTables, mapLegacy, loadSqlJs } from './legacy.js';
import { PACK_KIND, makePack, checkPack, planMerge } from './packs.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ---- per-device preferences (tones, theme): localStorage is fine for these ----
function load(key, fallback) {
  try { return { ...fallback, ...JSON.parse(localStorage.getItem(key) || '{}') }; } catch { return { ...fallback }; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode etc. */ }
}

const freqs = load('pt.freqs', Object.fromEntries(Object.entries(DEFAULT_TONES).map(([k, t]) => [k, t.freq])));
let theme = (() => { try { return localStorage.getItem('pt.theme') || 'dark'; } catch { return 'dark'; } })();

const tones = () => Object.fromEntries(
  Object.entries(DEFAULT_TONES).map(([k, t]) => [k, { ...t, freq: Number(freqs[k]) }]));

const player = new TonePlayer();
const runner = new DrillRunner(player);

// ---- library state ----
let drills = [];
let sets = [];
let current = null;          // the drill record the form edits
let activeSetId = null;      // filter prev/next/picker to a drill set
let usage = new Map();       // drillId -> { last, runs }

const busy = () => runner.state === 'running' || runner.state === 'paused';
const nameOf = (d) => d.name || '(unnamed drill)';
const byName = (a, b) => nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: 'base', numeric: true });

function orderedDrills() {
  const set = sets.find((s) => s.id === activeSetId);
  if (set) return set.members.map((id) => drills.find((d) => d.id === id)).filter(Boolean);
  return [...drills].sort(byName);
}

async function rebuildUsage() {
  usage = new Map();
  for (const h of await db.getAll('history')) {
    const u = usage.get(h.drillId) || { last: '', runs: 0 };
    u.runs++;
    if (h.at > u.last) u.last = h.at;
    usage.set(h.drillId, u);
  }
}

async function loadLibrary() {
  drills = await db.getAll('drills');
  sets = await db.getAll('sets');
  if (!drills.length) {
    const id = await db.put('drills', { ...DEFAULT_DRILL, name: 'New drill', description: '', created: stamp(), updated: stamp() });
    drills = [await db.get('drills', id)];
  }
  await rebuildUsage();
  activeSetId = await db.getMeta('currentSet', null);
  if (!sets.some((s) => s.id === activeSetId)) activeSetId = null;
  const cid = await db.getMeta('currentDrill', null);
  const recent = [...usage.entries()].sort((a, b) => (a[1].last < b[1].last ? 1 : -1))[0];
  const pick = drills.find((d) => d.id === cid) || (recent && drills.find((d) => d.id === recent[0])) || orderedDrills()[0];
  select(pick);
}

async function select(d) {
  await flushSave();
  current = d;
  db.setMeta('currentDrill', d.id);
  renderHeader();
  renderForm();
  if ($('#histCard').open) renderHistory();
}

// ---- saving the drill being edited ----
let saveTimer = 0;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
}
async function flushSave() {
  if (!saveTimer || !current) return;
  clearTimeout(saveTimer);
  saveTimer = 0;
  current.updated = stamp();
  await db.put('drills', current);
}

// ---- theme ----
function applyTheme() {
  document.documentElement.dataset.theme = theme;
  $('meta[name=theme-color]').content = theme === 'light' ? '#f2f4f7' : '#111418';
}
$('#btnTheme').onclick = () => {
  theme = theme === 'light' ? 'dark' : 'light';
  try { localStorage.setItem('pt.theme', theme); } catch { /* ignore */ }
  applyTheme();
};
applyTheme();

// ---- drill header ----
function renderHeader() {
  $('#drillName').textContent = nameOf(current);
  $('#drillLabel').textContent = drillLabel(current);
  $('#drillDesc').textContent = current.description || '';
  const set = sets.find((s) => s.id === activeSetId);
  $('#setChip').hidden = !set;
  if (set) $('#setChip').textContent = `Set: ${set.name} ✕`;
  $('#importHint').hidden = !(drills.length <= 1 && usage.size === 0);
}

function step(dir) {
  if (busy()) return;
  const list = orderedDrills();
  if (!list.length) return;
  const i = list.findIndex((d) => d.id === current.id);
  select(list[(i + dir + list.length) % list.length]);
}
$('#btnPrev').onclick = () => step(-1);
$('#btnNext').onclick = () => step(1);
$('#setChip').onclick = () => {
  if (confirm('Leave the drill set and show all drills?')) { activeSetId = null; db.setMeta('currentSet', null); renderHeader(); }
};

// ---- picker ----
function renderPicker() {
  $('#pickSet').innerHTML = `<option value="">All drills</option>` +
    sets.map((s) => `<option value="${s.id}"${s.id === activeSetId ? ' selected' : ''}>${esc(s.name)} (${s.members.length})</option>`).join('');
  const q = $('#pickSearch').value.trim().toLowerCase();
  let list = orderedDrills().filter((d) => !q || nameOf(d).toLowerCase().includes(q) || (d.description || '').toLowerCase().includes(q));
  const sort = $('#pickSort').value;
  const u = (d) => usage.get(d.id) || { last: '', runs: 0 };
  if (sort === 'recent') list = list.sort((a, b) => (u(a).last < u(b).last ? 1 : u(a).last > u(b).last ? -1 : byName(a, b)));
  if (sort === 'used') list = list.sort((a, b) => u(b).runs - u(a).runs || byName(a, b));
  $('#pickList').innerHTML = list.map((d) => {
    const x = u(d);
    const meta = x.runs ? `${x.runs} runs · last ${x.last.slice(0, 10)}` : 'never run';
    return `<li><button data-id="${d.id}"${d.id === current.id ? ' aria-current="true"' : ''}>` +
      `<span class="n">${esc(nameOf(d))}</span><span class="l">${esc(drillLabel(d))}</span><span class="d">${meta}</span></button></li>`;
  }).join('') || '<li class="diag" style="padding:14px">No matching drills.</li>';
}
$('#btnPick').onclick = () => {
  if (busy()) return;
  $('#pickSearch').value = '';
  renderPicker();
  $('#picker').showModal();
  $('#pickList [aria-current]')?.scrollIntoView({ block: 'center' });
};
$('#pickClose').onclick = () => $('#picker').close();
$('#picker').addEventListener('click', (e) => { if (e.target === $('#picker')) $('#picker').close(); });
$('#pickSearch').oninput = renderPicker;
$('#pickSort').onchange = renderPicker;
$('#pickSet').onchange = () => {
  activeSetId = $('#pickSet').value ? Number($('#pickSet').value) : null;
  db.setMeta('currentSet', activeSetId);
  renderPicker();
  renderHeader();
};
$('#pickList').onclick = (e) => {
  const b = e.target.closest('button[data-id]');
  if (!b) return;
  $('#picker').close();
  select(drills.find((d) => d.id === Number(b.dataset.id)));
};

// ---- drill form ----
function renderForm() {
  $$('.seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.format === current.format)));
  $$('[data-for]').forEach((g) => { g.hidden = g.dataset.for !== current.format; });
  $$('[data-k]').forEach((el) => {
    if (el.type === 'checkbox') el.checked = !!current[el.dataset.k];
    else el.value = current[el.dataset.k] ?? '';
  });
  $('[data-k=randomMax]').disabled = !current.randomize || busy();
  refreshSummary();
}

$$('.seg button').forEach((b) => (b.onclick = () => {
  if (busy()) return;
  current.format = b.dataset.format;
  scheduleSave(); renderForm(); renderHeader();
}));
$$('[data-k]').forEach((el) => (el.oninput = () => {
  const k = el.dataset.k;
  if (el.type === 'checkbox') current[k] = el.checked;
  else if (el.type === 'number') current[k] = el.value === '' ? '' : Number(el.value);
  else current[k] = el.value;
  scheduleSave();
  $('[data-k=randomMax]').disabled = !current.randomize;
  renderHeader();
  refreshSummary();
}));

$('#btnNew').onclick = async () => {
  await flushSave();
  const d = { ...DEFAULT_DRILL, name: 'New drill', description: '', created: stamp(), updated: stamp() };
  d.id = await db.put('drills', d);
  drills.push(d);
  await select(d);
  $('#editCard').open = true;
  $('[data-k=name]').select();
};
$('#btnDup').onclick = async () => {
  await flushSave();
  const { id, ...rest } = current;
  const d = { ...rest, name: `${nameOf(current)} (copy)`, created: stamp(), updated: stamp() };
  d.id = await db.put('drills', d);
  drills.push(d);
  await select(d);
};
$('#btnDel').onclick = async () => {
  const runs = (usage.get(current.id) || { runs: 0 }).runs;
  if (!confirm(`Delete "${nameOf(current)}"${runs ? ` and its ${runs} history entries` : ''}? This cannot be undone.`)) return;
  clearTimeout(saveTimer); saveTimer = 0;
  const gone = current.id;
  const list = orderedDrills();
  const next = list[list.findIndex((d) => d.id === gone) + 1] || list.find((d) => d.id !== gone);
  await db.deleteDrill(gone);
  drills = drills.filter((d) => d.id !== gone);
  sets = await db.getAll('sets');
  usage.delete(gone);
  if (!drills.length) { await loadLibrary(); return; }
  await select(next || drills[0]);
};

function fmtClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function refreshSummary() {
  const errs = validate(current);
  const ul = $('#errors');
  ul.hidden = errs.length === 0;
  ul.innerHTML = errs.map((e) => `<li>${esc(e)}</li>`).join('');
  if (!busy()) $('#btnStart').disabled = errs.length > 0;
  if (errs.length) { $('#summary').textContent = ''; $('#stepList').innerHTML = ''; return; }
  const plan = buildPlan(current, () => 0.5); // zero random offset for the estimate
  const n = plan.reps.length;
  $('#summary').textContent =
    `${n} reps${plan.steps.length > 1 ? ` in ${plan.steps.length} steps` : ''} · about ${fmtClock(planLength(plan, tones()))}`;
  $('#stepList').innerHTML = plan.steps.length > 1
    ? plan.steps.map((s) => `<span>${(s.par / 1000).toFixed(2)}s × ${s.count}</span>`).join('') : '';
  renderPlanTable(plan, 'Planned (random offsets shown as zero)');
}

// ---- history ----
async function renderHistory() {
  const rows = (await db.historyFor(current.id)).sort((a, b) => (a.at < b.at ? 1 : -1));
  const body = $('#histBody');
  if (!rows.length) { body.innerHTML = '<div class="diag">No runs recorded for this drill yet.</div>'; return; }
  const f2 = (x) => (x == null ? '—' : x.toFixed(2));
  const w = windows(rows);
  const bp = byPar(rows);
  body.innerHTML = `
    <table class="tbl"><thead><tr><th>Period</th><th>Runs</th><th>Reps</th><th>Avg par</th></tr></thead><tbody>
      ${w.map((x) => `<tr><td>${x.label}</td><td>${x.runs}</td><td>${x.reps.toLocaleString()}</td><td>${f2(x.avgPar)}</td></tr>`).join('')}
    </tbody></table>
    <h3>By par time</h3>
    <table class="tbl"><thead><tr><th>Par</th><th>Runs</th><th>Reps</th><th>Last</th></tr></thead><tbody>
      ${bp.map((x) => `<tr><td>${f2(x.par)}s</td><td>${x.runs}</td><td>${x.reps.toLocaleString()}</td><td>${x.last.slice(0, 10)}</td></tr>`).join('')}
    </tbody></table>
    <h3>Recent runs</h3>
    <table class="tbl"><thead><tr><th>When</th><th>Par</th><th>Reps</th><th></th></tr></thead><tbody>
      ${rows.slice(0, 30).map((r) => `<tr><td>${esc(r.at.slice(0, 16))}</td><td>${f2(r.par)}</td><td>${r.reps}</td>` +
        `<td><button class="x" data-hid="${r.id}" aria-label="Delete run">✕</button></td></tr>`).join('')}
    </tbody></table>
    ${rows.length > 30 ? `<div class="diag">${rows.length - 30} older runs not shown.</div>` : ''}
    <div class="row"><button id="btnClearDrill" class="danger">Clear this drill's history</button></div>`;
  $('#btnClearDrill').onclick = () => clearDrillHistory(rows.length);
}

async function clearDrillHistory(n) {
  if (busy()) return;
  const name = nameOf(current);
  if (!confirm(`Delete all ${n.toLocaleString()} run${n === 1 ? '' : 's'} recorded for "${name}"?\n\n` +
    'The drill and its settings stay. This cannot be undone.')) return;
  const removed = await db.clearDrillHistory(current.id);
  usage.delete(current.id);
  renderHistory();
  renderHeader();
  if ($('#dataCard').open) renderDataInfo();
  $('#dataOut').textContent = `Cleared ${removed.toLocaleString()} runs for "${name}".`;
}

$('#btnClearAll').onclick = async () => {
  if (busy()) return;
  const c = await db.counts();
  if (!c.history && !c.sessions) { $('#dataOut').textContent = 'There is no history to clear.'; return; }
  $('#clearWhat').textContent = `This deletes ${c.history.toLocaleString()} recorded runs across all drills and ` +
    `${c.sessions.toLocaleString()} practice-time entries.`;
  $('#clearType').value = '';
  $('#clearBackup').checked = true;
  $('#clearGo').disabled = true;
  $('#clearDlg').showModal();
  $('#clearType').focus();
};
$('#clearType').oninput = () => { $('#clearGo').disabled = $('#clearType').value.trim().toUpperCase() !== 'CLEAR'; };
$('#clearCancel').onclick = () => $('#clearDlg').close();
$('#clearGo').onclick = async () => {
  if ($('#clearType').value.trim().toUpperCase() !== 'CLEAR') return;
  $('#clearDlg').close();
  if ($('#clearBackup').checked) await exportBackup();
  const removed = await db.clearAllHistory();
  await rebuildUsage();
  renderHeader();
  if ($('#histCard').open) renderHistory();
  renderDataInfo();
  $('#dataOut').textContent = `Cleared ${removed.history.toLocaleString()} runs and ` +
    `${removed.sessions.toLocaleString()} practice-time entries.` +
    ($('#clearBackup').checked ? ' A backup of them was downloaded first.' : '');
};
$('#histCard').addEventListener('toggle', () => { if ($('#histCard').open) renderHistory(); });
$('#histBody').onclick = async (e) => {
  const b = e.target.closest('[data-hid]');
  if (!b) return;
  const row = b.closest('tr').children;
  if (!confirm(`Delete the run from ${row[0].textContent} (par ${row[1].textContent}, ${row[2].textContent} reps)?`)) return;
  await db.del('history', Number(b.dataset.hid));
  await rebuildUsage();
  renderHistory();
};

// ---- data: import / export ----
async function renderDataInfo() {
  const c = await db.counts();
  let persisted = '';
  try { persisted = (await navigator.storage.persisted()) ? ' · storage: persistent' : ' · storage: best-effort'; } catch { /* ignore */ }
  $('#dataInfo').textContent = `${c.drills} drills · ${c.history.toLocaleString()} runs · ${c.sessions.toLocaleString()} practice sessions · ${c.sets} sets${persisted}`;
}
$('#dataCard').addEventListener('toggle', () => { if ($('#dataCard').open) renderDataInfo(); });

async function confirmReplace(incoming) {
  const c = await db.counts();
  const hasData = c.history > 0 || c.drills > 1;
  return !hasData || confirm(
    `Replace your current ${c.drills} drills and ${c.history.toLocaleString()} runs with ` +
    `${incoming.drills.length} drills and ${incoming.history.length.toLocaleString()} runs from the file? ` +
    'Export a backup first if you want to keep what is here.');
}

async function afterReplace(msg) {
  await loadLibrary();
  renderDataInfo();
  $('#dataOut').textContent = msg;
}

$('#btnImportDb').onclick = () => { if (!busy()) $('#fileDb').click(); };
$('#fileDb').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const out = $('#dataOut');
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!isSqlite(bytes)) throw new Error('That file is not a SQLite database. Pick the DryFire_….db file the old app\'s Backup made.');
    out.textContent = 'Reading backup…';
    const SQL = await loadSqlJs();
    const data = mapLegacy(readLegacyTables(SQL, bytes));
    if (!(await confirmReplace(data))) { out.textContent = 'Import cancelled.'; return; }
    await flushSave();
    await db.replaceAll(data);
    await afterReplace(`Imported ${data.drills.length} drills, ${data.history.length.toLocaleString()} runs, ` +
      `${data.sessions.length.toLocaleString()} practice sessions and ${data.sets.length} sets from ${file.name}.` +
      (data.orphans ? ` Skipped ${data.orphans} runs for drills that no longer exist.` : ''));
  } catch (err) {
    out.textContent = `Import failed: ${err.message}`;
  }
};

async function exportBackup() {
  await flushSave();
  const data = await db.exportAll();
  download(JSON.stringify(data), `par-timer-backup-${stamp().replace(/[-: ]/g, '').slice(0, 12)}.json`);
  return data;
}
$('#btnExport').onclick = async () => {
  const data = await exportBackup();
  $('#dataOut').textContent = `Exported ${data.drills.length} drills and ${data.history.length.toLocaleString()} runs.`;
};

$('#btnRestore').onclick = () => { if (!busy()) $('#fileJson').click(); };
$('#fileJson').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.kind === PACK_KIND) throw new Error('That is a drill pack, not a backup. Use Import drill pack for it.');
    if (data.app !== 'par-timer' || !Array.isArray(data.drills) || !Array.isArray(data.history)) {
      throw new Error('Not a Par Timer backup file.');
    }
    data.sets = data.sets || []; data.sessions = data.sessions || [];
    if (!(await confirmReplace(data))) { $('#dataOut').textContent = 'Restore cancelled.'; return; }
    await flushSave();
    await db.replaceAll(data);
    await afterReplace(`Restored ${data.drills.length} drills and ${data.history.length.toLocaleString()} runs from ${file.name}.`);
  } catch (err) {
    $('#dataOut').textContent = `Restore failed: ${err.message}`;
  }
};

// ---- drill packs ----
async function importPack(pack, source) {
  checkPack(pack);
  await flushSave();
  const plan = planMerge(pack, drills, sets);
  const setNames = plan.sets.map((s) => s.name);
  if (!plan.add.length && !plan.sets.length) {
    return `Nothing new in ${source}: you already have all ${plan.skipped.length} of its drills.`;
  }
  const blankStart = drills.length === 1 && usage.size === 0 && drills[0].name === 'New drill';
  if (!blankStart && !confirm(
    `Add ${plan.add.length} drill${plan.add.length === 1 ? '' : 's'} from "${pack.name || source}"` +
    (setNames.length ? ` and set${setNames.length === 1 ? '' : 's'} ${setNames.join(', ')}` : '') + '?' +
    (plan.skipped.length ? `\n\n${plan.skipped.length} drill(s) you already have by name will be left as they are.` : ''))) {
    return 'Pack import cancelled.';
  }
  const added = await db.applyMerge(plan, stamp());
  // A fresh install's placeholder drill has served its purpose.
  if (blankStart && added.length) await db.deleteDrill(drills[0].id);
  const keep = blankStart ? added[0] : current.id;
  await db.setMeta('currentDrill', keep);
  await loadLibrary();
  return `Added ${plan.add.length} drills` + (setNames.length ? ` and sets ${setNames.join(', ')}` : '') +
    (plan.skipped.length ? `. Kept your existing ${plan.skipped.join(', ')}.` : '.') +
    (plan.invalid.length ? ` Check the settings of: ${plan.invalid.join(', ')}.` : '');
}

$('#btnStarter').onclick = async () => {
  try {
    const pack = await (await fetch('packs/starter.json')).json();
    const msg = await importPack(pack, 'the starter pack');
    $('#dataOut').textContent = msg;
    $('#dataCard').open = true;
    renderDataInfo();
  } catch (err) {
    alert(`Could not load the starter drills: ${err.message}`);
  }
};

$('#btnPackImport').onclick = () => { if (!busy()) $('#filePack').click(); };
$('#filePack').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.app === 'par-timer' && data.kind !== PACK_KIND && Array.isArray(data.history)) {
      throw new Error('That is a full backup, not a drill pack. Use Restore backup for it.');
    }
    $('#dataOut').textContent = await importPack(data, file.name);
    renderDataInfo();
  } catch (err) {
    $('#dataOut').textContent = `Pack import failed: ${err.message}`;
  }
};

function renderPackList(checked) {
  $('#packList').innerHTML = orderedDrillsAll().map((d) => `<li><label>
    <input type="checkbox" value="${d.id}"${checked.has(d.id) ? ' checked' : ''}>
    <span>${esc(nameOf(d))}</span><span class="l">${esc(drillLabel(d))}</span></label></li>`).join('');
  updatePackCount();
}
const orderedDrillsAll = () => [...drills].sort(byName);
const packChecked = () => new Set($$('#packList input:checked').map((i) => Number(i.value)));
function updatePackCount() {
  const n = packChecked().size;
  $('#packCount').textContent = `${n} drill${n === 1 ? '' : 's'} selected`;
  $('#packGo').disabled = n === 0;
}
$('#packList').onchange = updatePackCount;
$('#btnPackExport').onclick = async () => {
  await flushSave();
  const set = sets.find((s) => s.id === activeSetId);
  $('#packName').value = set ? set.name : 'My drills';
  renderPackList(new Set(set ? set.members : [current.id]));
  $('#packSet').disabled = !set;
  $('#packDlg').showModal();
};
$('#packClose').onclick = () => $('#packDlg').close();
$('#packAll').onclick = () => renderPackList(new Set(drills.map((d) => d.id)));
$('#packNone').onclick = () => renderPackList(new Set());
$('#packSet').onclick = () => {
  const set = sets.find((s) => s.id === activeSetId);
  if (set) renderPackList(new Set(set.members));
};
$('#packGo').onclick = () => {
  const ids = packChecked();
  const name = $('#packName').value.trim() || 'My drills';
  const chosen = orderedDrillsAll().filter((d) => ids.has(d.id));
  const pack = makePack({ name, drills: chosen, sets });
  download(JSON.stringify(pack, null, 1), `${name.replace(/[^\w.-]+/g, '-').replace(/^-|-$/g, '') || 'drills'}.drillpack.json`);
  $('#packDlg').close();
  $('#dataOut').textContent = `Saved "${name}" with ${chosen.length} drills. Send the file to anyone using Par Timer; they add it with Import drill pack.`;
};

function download(text, filename) {
  const blob = new Blob([text], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ---- tones ----
const toneNames = { start: 'Start', stop: 'Stop', step: 'Step', finish: 'Finish' };
$('#tones').innerHTML = Object.keys(DEFAULT_TONES).map((k) => `
  <div class="tone"><span>${toneNames[k]}</span>
    <input type="range" min="500" max="2500" step="10" data-tone="${k}" aria-label="${toneNames[k]} pitch">
    <span data-hz="${k}"></span></div>`).join('') + (() => {
  const s = (ms) => `${(ms / 1000).toFixed(2)} s`;
  const t = DEFAULT_TONES;
  return `<div class="diag" style="margin-top:10px">Tone lengths are fixed: start ${s(t.start.ms)}, stop ${s(t.stop.ms)}, ` +
    `step ${s(t.step.ms)}, finish ${s(t.finish.ms)}. The par is timed from the start of the start tone to the start ` +
    `of the stop tone. Step and finish tones begin ${s(TONE_GAP_EXTRA)} after the stop tone ends ` +
    `(${s(t.stop.ms + TONE_GAP_EXTRA)} after it starts).</div>`;
})();
let previewTimer = 0;
$$('[data-tone]').forEach((el) => {
  const k = el.dataset.tone;
  el.value = freqs[k];
  const hz = () => { $(`[data-hz=${k}]`).textContent = `${freqs[k]} Hz · ${(DEFAULT_TONES[k].ms / 1000).toFixed(2)} s`; };
  hz();
  el.oninput = () => {
    freqs[k] = Number(el.value);
    hz();
    save('pt.freqs', freqs);
    if (runner.state === 'running') return;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      await player.unlock();
      const t = tones()[k];
      player.setTone(k, t.freq, t.ms);
      player.preview(k);
    }, 90);
  };
});

// ---- wake lock ----
let wakeLock = null;
let wakeState = 'off';
async function lockScreen() {
  if (!('wakeLock' in navigator)) { wakeState = 'unsupported'; return; }
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeState = 'on';
    wakeLock.addEventListener('release', () => { wakeState = 'released'; });
  } catch (e) { wakeState = `failed: ${e.message}`; }
}
function unlockScreen() {
  if (wakeLock) wakeLock.release().catch(() => {});
  wakeLock = null; wakeState = 'off';
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && runner.state === 'running') lockScreen();
  if (document.visibilityState === 'hidden') flushSave();
});

// ---- controls ----
function setRunningUI(active) {
  $('#btnStart').disabled = active;
  $('#btnPause').disabled = !active;
  $('#btnStop').disabled = !active;
  $$('#drillCard input, #drillCard textarea, #drillCard button, .drillbar button').forEach((el) => { el.disabled = active; });
  if (!active) { $('[data-k=randomMax]').disabled = !current.randomize; refreshSummary(); }
}

let runDrill = null;   // the drill as it was when Start was pressed
let runPlan = null;
let runStarted = null;

$('#btnStart').onclick = async () => {
  if (validate(current).length) return;
  await flushSave();
  await player.unlock();
  player.setTones(tones());
  runDrill = current;
  runPlan = buildPlan(current);
  runStarted = new Date();
  renderPlanTable(runPlan, 'This run');
  runner.start(runPlan, tones());
  setRunningUI(true);
  $('#btnPause').textContent = 'Pause';
  lockScreen();
  paint();
  loop();
};

$('#btnPause').onclick = async () => {
  if (runner.state === 'running') {
    runner.pause();
    $('#btnPause').textContent = 'Resume';
  } else if (runner.state === 'paused') {
    await player.unlock();
    runner.resume();
    $('#btnPause').textContent = 'Pause';
    lockScreen();
    loop();
  }
  paint();
};

$('#btnStop').onclick = () => runner.stop();

runner.onEnd = async (state, completed) => {
  unlockScreen();
  setRunningUI(false);
  $('#btnPause').textContent = 'Pause';
  lastEnd = { state, completed, saved: null };
  paint();
  const steps = completedBySteps(runPlan, completed);
  if (!steps.length) return;
  const end = new Date();
  try {
    await db.recordRun(runDrill.id, steps, stamp(end), {
      start: stamp(runStarted), end: stamp(end), seconds: Math.round((end - runStarted) / 10) / 100,
    });
    const u = usage.get(runDrill.id) || { last: '', runs: 0 };
    usage.set(runDrill.id, { last: stamp(end), runs: u.runs + steps.length });
    lastEnd.saved = true;
    if ($('#histCard').open && current.id === runDrill.id) renderHistory();
    renderHeader();
  } catch (e) {
    lastEnd.saved = false;
    console.error('recordRun', e);
  }
  paint();
};

// If the OS interrupts audio (call, another app, screen off), pause rather than drift.
player.onStateChange = (state) => {
  if (state !== 'running' && runner.state === 'running') {
    runner.pause();
    $('#btnPause').textContent = 'Resume';
    interrupted = true;
    paint();
  }
};

// ---- display ----
let lastEnd = null;
let interrupted = false;
let raf = 0;
let backstop = 0;
function loop() {
  cancelAnimationFrame(raf);
  clearInterval(backstop);
  const tick = () => {
    paint();
    if (runner.state === 'running') raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  // rAF stops while the page is hidden; this keeps end-of-drill detection (wake lock release,
  // the history write) happening anyway. Beeps don't depend on either.
  backstop = setInterval(() => {
    if (runner.state === 'running') runner.status(); else clearInterval(backstop);
  }, 500);
}

function paint() {
  const s = runner.status();
  const st = $('#status'), big = $('#big');
  const r = s.rep;
  const stepTxt = r && r.stepCount > 1 ? ` · step ${r.step + 1}/${r.stepCount}` : '';
  $('#repInfo').textContent = r ? `Rep ${s.idx + 1} of ${s.total}${stepTxt} · par ${(r.par / 1000).toFixed(2)}` : '—';
  st.className = '';
  if (s.state === 'running') {
    interrupted = false;
    $('#remaining').textContent = fmtClock(s.remainingMs);
    if (s.phase === 'par') {
      st.className = 'par'; st.textContent = 'GO';
      big.classList.remove('dim'); big.textContent = (s.parLeftMs / 1000).toFixed(2);
    } else if (s.phase === 'delay') {
      // Deliberately no delay countdown: it would let you anticipate the start beep.
      st.className = 'delay'; st.textContent = 'Stand by';
      big.classList.add('dim'); big.textContent = (r.par / 1000).toFixed(2);
    } else {
      st.className = 'delay'; st.textContent = 'Stand by';
      big.classList.add('dim'); big.textContent = '0.00';
    }
  } else if (s.state === 'paused') {
    st.className = 'paused';
    st.textContent = interrupted ? 'Paused: audio was interrupted' : 'Paused';
    big.classList.add('dim'); big.textContent = (r.par / 1000).toFixed(2);
    $('#remaining').textContent = '--:--';
  } else if (s.state === 'finished' || s.state === 'stopped') {
    st.className = s.state === 'finished' ? 'finished' : '';
    const n = lastEnd ? lastEnd.completed : 0;
    const reps = `${n} rep${n === 1 ? '' : 's'}`;
    const saved = lastEnd && lastEnd.saved === true ? ' · saved' : lastEnd && lastEnd.saved === false ? ' · NOT saved' : '';
    st.textContent = (s.state === 'finished' ? `Finished · ${reps}` : `Stopped · ${reps} completed`) + saved;
    big.classList.add('dim'); big.textContent = '0.00';
    $('#remaining').textContent = '--:--';
    $('#repInfo').textContent = '—';
  } else {
    st.textContent = 'Ready';
  }
  paintDiag();
}

function paintDiag() {
  if (!$('#diagCard').open) return;
  const c = player.ctx;
  $('#diag').textContent = [
    `audio: ${c ? `${c.state}, ${c.sampleRate} Hz` : 'not started (tap Start or move a tone slider)'}`,
    c ? `latency: base ${((c.baseLatency || 0) * 1000).toFixed(1)} ms, output ${((c.outputLatency || 0) * 1000).toFixed(1)} ms` : '',
    `wake lock: ${wakeState}`,
    `runner: ${runner.state}`,
    `install: ${standalone() ? 'running as installed app'
      : window.__installPrompt ? 'Chrome says installable (Install button ready)'
      : 'no install prompt from Chrome yet'}`,
    `display mode: ${standalone() ? 'standalone' : 'browser'}`,
    `service worker: ${!('serviceWorker' in navigator) ? 'not supported'
      : navigator.serviceWorker.controller ? 'active (works offline)' : 'not controlling this page'}`,
    `browser: ${browserInfo}`,
  ].filter(Boolean).join('\n');
}
$('#diagCard').addEventListener('toggle', paintDiag);

function renderPlanTable(plan, caption) {
  const tl = timeline(plan, tones());
  const rows = tl.reps.map((x) => {
    const r = plan.reps[x.idx];
    return `<tr><td>${x.idx + 1}</td><td>${r.step + 1}</td><td>${(r.par / 1000).toFixed(2)}</td>` +
      `<td>${((x.startAt - x.delayAt) / 1000).toFixed(2)}</td><td>${(x.startAt / 1000).toFixed(3)}</td></tr>`;
  }).join('');
  $('#planWrap').innerHTML = `<div class="diag">${caption}</div><table><thead><tr><th>#</th><th>step</th>` +
    `<th>par</th><th>delay</th><th>start @</th></tr></thead><tbody>${rows}</tbody></table>`;
}

$('#btnVerify').onclick = async () => {
  const out = $('#verifyOut');
  if (validate(current).length) { out.textContent = 'Fix the drill first.'; return; }
  out.className = 'diag'; out.textContent = 'Rendering…';
  try {
    const tl = timeline(buildPlan(current), tones());
    const res = await verifyTiming(tl.events, tones());
    const good = res.maxErrMs < 1 && res.maxParErrMs < 1;
    out.className = `diag ${good ? 'ok' : 'bad'}`;
    out.textContent = `${res.checked} beeps rendered. Max onset error ${res.maxErrMs.toFixed(3)} ms; ` +
      `max start→stop error ${res.maxParErrMs.toFixed(3)} ms. ${good ? 'PASS' : 'FAIL'}`;
  } catch (e) {
    out.className = 'diag bad'; out.textContent = `FAIL: ${e.message}`;
  }
};

// ---- install button ----
// Chrome hands over an install prompt (captured in index.html) when the app is installable;
// otherwise, and on iOS, the button shows the steps for this device instead.
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
let browserInfo = navigator.userAgent; // refined below when the browser shares more detail
function refreshInstall() {
  $('#btnInstall').hidden = standalone();
  // Highlighted once Chrome has said the app is installable (it waits for some use of the page).
  $('#btnInstall').classList.toggle('ready', !!window.__installPrompt);
  paintDiag();
}
refreshInstall();
window.addEventListener('pt-installable', refreshInstall);
$('#btnInstall').onclick = async () => {
  const prompt = window.__installPrompt;
  if (prompt) {
    window.__installPrompt = null; // a prompt can only be used once
    prompt.prompt();
    const { outcome } = await prompt.userChoice;
    if (outcome === 'accepted') $('#btnInstall').hidden = true;
    refreshInstall();
    return;
  }
  const ua = navigator.userAgent;
  const os = /Android/i.test(ua) ? 'android'
    : /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'ios' : 'desktop';
  $$('#installDlg [data-os]').forEach((el) => { el.hidden = el.dataset.os !== os; });
  $('#installDlg').showModal();
};
$('#installClose').onclick = () => $('#installDlg').close();
window.addEventListener('appinstalled', () => { $('#btnInstall').hidden = true; window.__installPrompt = null; paintDiag(); });

// Browser details for Diagnostics: the full Chrome/Android versions and model when the browser shares them.
if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
  navigator.userAgentData.getHighEntropyValues(['fullVersionList', 'platformVersion', 'model']).then((v) => {
    const b = (v.fullVersionList || []).filter((x) => !/Not.?A.?Brand/i.test(x.brand)).map((x) => `${x.brand} ${x.version}`).join(', ');
    browserInfo = `${b} · ${v.platform || ''} ${v.platformVersion || ''}${v.model ? ` · ${v.model}` : ''}`;
    paintDiag();
  }).catch(() => {});
}

// ---- offline / install (service worker) ----
// Skipped on localhost so edits show up without cache games; add ?sw=1 to test it locally.
const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
if ('serviceWorker' in navigator && (!local || new URLSearchParams(location.search).has('sw'))) {
  let waiting = null;
  const offer = (w) => { waiting = w; $('#updateBar').hidden = false; };
  navigator.serviceWorker.register('sw.js').then((reg) => {
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
      });
    });
    // Look for a new version whenever the app comes back to the foreground.
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update(); });
  }).catch((e) => console.warn('service worker', e));
  // Reload when the version the user asked for takes over; the first install taking control
  // of an already-open page needs no reload.
  let updating = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (updating) { updating = false; location.reload(); }
  });
  $('#btnUpdate').onclick = async () => {
    if (busy()) { alert('Finish or stop the drill first.'); return; }
    await flushSave();
    if (waiting) { updating = true; waiting.postMessage('skipWaiting'); }
  };
}

loadLibrary().then(paint).catch((e) => {
  $('#status').textContent = `Storage error: ${e.message}`;
  console.error(e);
});

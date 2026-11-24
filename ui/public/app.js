// Demo Agent UI — plain JS, no build step.
const $ = s => document.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k instanceof Node ? k : String(k));
  return el;
};
const api = async (url, body) => {
  const r = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
};

const FIXTURE = 'http://127.0.0.1:5050/index.html';
const EXAMPLES = ['invite a member', 'open the reports', 'show how to create your first invoice', 'show all features'];
const LENGTHS = [30, 45, 60, 90, 120];
const STEPS = [
  { id: 'map', label: 'Map site' },
  { id: 'plan', label: 'Plan' },
  { id: 'sample', label: 'Sample' },
  { id: 'record', label: 'Record' },
  { id: 'assemble', label: 'Voice + render' },
  { id: 'done', label: 'Done' }
];
const PHASE_STEP = { map: 0, plan: 1, sample: 2, style: 2, record: 3, assemble: 4, review: 4, done: 5 };
const STYLE_TEXT = {
  calm: 'Normal speed, deeper zoom, longer holds',
  fast: 'Sped up, light zoom, short holds',
  compare: 'Record the opening, render both, then pick'
};

const ui = { style: 'calm', seconds: 60, store: 'none', ffmpeg: true, job: null, es: null, viewing: null };

// ── Options / environment ────────────────────────────────────────────────────
async function loadOptions() {
  const o = await api('/api/options');
  ui.ffmpeg = o.env.ffmpeg;
  const chips = $('#envChips');
  chips.replaceChildren(...[
    h('span', { class: 'chip ' + (o.env.llm ? 'ok' : '') , title: o.env.llm ? `Planning and narration by ${o.env.llmModel}` : 'Set GROQ_API_KEY in .env for LLM planning and narration' }, o.env.llm ? 'Planner: Groq' : 'Planner: keyword rules'),
    h('span', { class: 'chip ' + (o.env.voice === 'elevenlabs' ? 'ok' : ''), title: o.env.voice === 'elevenlabs' ? 'ElevenLabs voice' : 'Set ELEVENLABS_API_KEY for a real voice; captions still work' }, o.env.voice === 'elevenlabs' ? 'Voice: ElevenLabs' : 'Voice: silent + captions'),
    h('span', { class: 'chip ' + (o.env.ffmpeg ? 'ok' : 'warn') }, o.env.ffmpeg ? 'FFmpeg: ready' : 'FFmpeg: missing'),
    o.env.vision ? h('span', { class: 'chip ok' }, 'Take review: vision') : null].filter(Boolean)
  );
  $('#allowHosts').textContent = o.env.allowHosts.join(', ');
  if (!o.env.ffmpeg) {
    const b = $('#banner');
    b.hidden = false;
    b.textContent = 'FFmpeg was not found on this machine. Mapping, planning and screen recording work, and you can watch the recorded takes, but the final MP4 cannot be rendered. Install FFmpeg (or set FFMPEG_PATH in .env), restart the UI, then press "Continue" on the run.';
  }
  buildStyles(o.styles);
  if (o.active) follow(o.active);
}

function buildStyles(presets) {
  const box = $('#styles');
  const cards = [...presets.map(p => ({ id: p.name, title: p.name[0].toUpperCase() + p.name.slice(1), sub: `${STYLE_TEXT[p.name] || ''} · ${p.speed}× · zoom ${p.zoomDepth}` })), { id: 'compare', title: 'Compare', sub: STYLE_TEXT.compare }];
  box.replaceChildren(...cards.map(c => h('button', {
    type: 'button', class: 'style' + (ui.style === c.id ? ' on' : ''), disabled: c.id === 'compare' && !ui.ffmpeg, title: c.id === 'compare' && !ui.ffmpeg ? 'Needs FFmpeg to render the samples' : '',
    onclick: () => { ui.style = c.id; buildStyles(presets); }
  }, h('b', {}, c.title), h('small', {}, c.sub))));
}

function buildLengths() {
  const seg = $('#lengths');
  const custom = h('input', { type: 'number', min: 10, max: 600, placeholder: 'sec', title: 'Custom length in seconds', value: LENGTHS.includes(ui.seconds) ? '' : ui.seconds,
    oninput: e => { const n = Number(e.target.value); if (n) { ui.seconds = n; seg.querySelectorAll('button').forEach(b => b.classList.remove('on')); } } });
  seg.replaceChildren(...LENGTHS.map(s => h('button', { type: 'button', class: ui.seconds === s ? 'on' : '', onclick: () => { ui.seconds = s; buildLengths(); } }, s < 60 ? `${s}s` : `${s / 60 % 1 ? s + 's' : s / 60 + ' min'}`)), custom);
}

$('#examples').append(...EXAMPLES.map(e => h('button', { type: 'button', onclick: () => { $('#goal').value = e; } }, e)));
$('#useFixture').addEventListener('click', e => { e.preventDefault(); $('#url').value = FIXTURE; checkMode(); });
$('#url').addEventListener('change', checkMode);
async function checkMode() {
  const badge = $('#modeBadge');
  const url = $('#url').value.trim();
  if (!url) { badge.hidden = true; return; }
  const { mode } = await api('/api/mode?url=' + encodeURIComponent(url)).catch(() => ({}));
  badge.hidden = !mode;
  if (mode) { badge.className = 'mode ' + mode; badge.textContent = mode + ' mode'; }
}
$('#storeSeg').addEventListener('click', e => {
  const v = e.target.dataset?.v;
  if (!v) return;
  ui.store = v;
  $('#storeSeg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  $('#storeUri').hidden = v !== 'graph';
});

// ── Start a run ──────────────────────────────────────────────────────────────
$('#compose').addEventListener('submit', async e => {
  e.preventDefault();
  const err = $('#composeErr');
  err.hidden = true;
  const body = {
    url: $('#url').value.trim(), goal: $('#goal').value.trim(), audience: $('#audience').value.trim(),
    style: ui.style === 'compare' ? undefined : ui.style, seconds: ui.seconds, review: $('#review').checked,
    takes: Number($('#takes').value), pages: Number($('#pages').value), deepen: $('#deepen').checked, extras: $('#extras').checked,
    headed: $('#headed').checked, rebuild: $('#rebuild').checked,
    store: ui.store, storeUri: $('#storeUri').value.trim(), graphFile: $('#graphFile').value.trim(), storageState: $('#storageState').value.trim()
  };
  try { follow(await api('/api/runs', body)); }
  catch (x) { err.textContent = x.message; err.hidden = false; }
});

// ── Follow a job (SSE) ───────────────────────────────────────────────────────
function follow(job) {
  ui.es?.close();
  ui.job = job;
  ui.viewing = null;
  $('#idle').hidden = true;
  $('#result').hidden = true;
  $('#job').hidden = false;
  $('#log').textContent = '';
  $('#logWrap').open = true;
  renderJob();
  const es = new EventSource(`/api/jobs/${job.id}/events`);
  ui.es = es;
  es.addEventListener('snapshot', e => { const d = JSON.parse(e.data); $('#log').textContent = d.logs.join('\n'); delete d.logs; ui.job = d; renderJob(); scrollLog(); });
  es.addEventListener('log', e => { const pre = $('#log'); pre.textContent += (pre.textContent ? '\n' : '') + JSON.parse(e.data); scrollLog(); });
  es.addEventListener('state', e => {
    ui.job = JSON.parse(e.data);
    renderJob();
    if (ui.job.status === 'done' || ui.job.status === 'error') { es.close(); loadHistory(); if (ui.job.runId) showRun(ui.job.runId, true); }
  });
}
function scrollLog() { const pre = $('#log'); pre.scrollTop = pre.scrollHeight; $('#logCount').textContent = `· ${pre.textContent.split('\n').length} lines`; }

function renderJob() {
  const j = ui.job;
  $('#jobTitle').textContent = j.kind === 'make' ? j.label : j.label[0].toUpperCase() + j.label.slice(1);
  $('#jobSub').textContent = j.runId ? `run ${j.runId}` : 'starting…';
  const st = $('#jobStatus');
  st.className = 'pill ' + j.status;
  st.textContent = { running: 'Working', waiting: 'Needs you', done: 'Finished', error: 'Stopped' }[j.status];
  $('#start').disabled = j.status === 'running' || j.status === 'waiting';

  const at = j.kind === 'make' || j.kind === 'resume' ? (PHASE_STEP[j.phase] ?? 0) : 4;
  $('#stepper').replaceChildren(...STEPS.map((s, i) => {
    let c = i < at || j.status === 'done' ? 'done' : i === at ? 'now' : '';
    if (c === 'now' && j.status === 'waiting') c += ' wait';
    if (c.startsWith('now') && j.status === 'error') c = 'fail';
    const label = i === at && j.status === 'waiting' ? (j.pending?.kind === 'style' ? 'Pick a style' : 'Approve plan') : s.label;
    return h('li', { class: c }, label);
  }));

  const p = $('#pending');
  p.replaceChildren();
  if (j.status === 'waiting' && j.pending) p.append(j.pending.kind === 'storyboard' ? storyboardCard(j) : styleCard(j));
  if (j.status === 'error') p.append(h('div', { class: 'err' }, j.error));
}

function storyboardCard(j) {
  const input = h('input', { placeholder: 'or ask for a change: "drop 3", "90 seconds", "focus on roles"…' });
  const answer = async a => { try { await api(`/api/jobs/${j.id}/answer`, { answer: a }); } catch (x) { alert(x.message); } };
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && input.value.trim()) answer(input.value.trim()); });
  return h('div', { class: 'card ask' },
    h('h3', {}, j.pending.round > 1 ? `Revised storyboard (round ${j.pending.round})` : 'Approve the storyboard'),
    h('pre', {}, j.pending.text),
    h('div', { class: 'quick' }, ['drop 2', '30 seconds', '90 seconds'].map(q => h('button', { type: 'button', onclick: () => { input.value = q; input.focus(); } }, q))),
    h('div', { class: 'row' }, input,
      h('button', { class: 'secondary', type: 'button', onclick: () => input.value.trim() && answer(input.value.trim()) }, 'Send change'),
      h('button', { class: 'primary', style: 'width:auto;padding:8px 18px', type: 'button', onclick: () => answer('approve') }, 'Approve & record'),
      h('button', { class: 'ghost', type: 'button', onclick: () => api(`/api/jobs/${j.id}/cancel`, {}).catch(x => alert(x.message)) }, 'Cancel run')));
}

function styleCard(j) {
  return h('div', { class: 'card ask' },
    h('h3', {}, 'Pick a style for the full video'),
    h('div', { class: 'samples' }, j.pending.samples.map(s => h('figure', {},
      h('video', { src: s.url, controls: true, preload: 'metadata' }),
      h('button', { class: 'secondary', type: 'button', onclick: () => api(`/api/jobs/${j.id}/answer`, { answer: s.name }).catch(x => alert(x.message)) }, `Use ${s.name}`)))),
    h('div', { class: 'row' }, h('button', { class: 'ghost', type: 'button', onclick: () => api(`/api/jobs/${j.id}/cancel`, {}).catch(x => alert(x.message)) }, 'Cancel run')));
}

// ── Show a run's result ──────────────────────────────────────────────────────
async function showRun(runId, keepJob = false) {
  const d = await api('/api/runs/' + encodeURIComponent(runId)).catch(() => null);
  if (!d) return;
  ui.viewing = runId;
  if (!keepJob) { ui.es?.close(); $('#job').hidden = true; }
  $('#idle').hidden = true;
  const r = $('#result');
  r.hidden = false;
  const s = d.state;
  const busy = ui.job && (ui.job.status === 'running' || ui.job.status === 'waiting');
  const stills = d.outputs.filter(o => o.name.startsWith('stills/'));
  const files = d.outputs.filter(o => !o.name.startsWith('stills/') && !o.name.startsWith('sample-'));
  const samples = d.outputs.filter(o => /^sample-.*\.mp4$/.test(o.name));
  const edit = h('input', { placeholder: 'e.g. "shorten the intro", "re-record shot 3", "slower"' });
  const doEdit = async () => { if (!edit.value.trim()) return; try { follow(await api(`/api/runs/${runId}/edit`, { request: edit.value.trim() })); } catch (x) { alert(x.message); } };
  edit.addEventListener('keydown', e => { if (e.key === 'Enter') doEdit(); });

  r.replaceChildren(...[
    !keepJob ? h('div', { class: 'jobhead' }, h('div', {}, h('div', { class: 'jobtitle' }, s.goal), h('div', { class: 'jobsub' }, `${d.url} · run ${runId}`)), h('span', { class: 'pill ' + (s.phase === 'done' ? 'done' : 'waiting') }, s.phase === 'done' ? 'Finished' : `Stopped at ${s.phase}`)) : null,
    h('div', { class: 'meta' },
      h('span', { class: 'chip' }, `style: ${s.style || '—'}`), h('span', { class: 'chip' }, `target ${s.seconds}s`),
      s.audience ? h('span', { class: 'chip' }, `audience: ${s.audience}`) : null, s.version ? h('span', { class: 'chip' }, `version ${s.version}`) : null,
      h('span', { class: 'chip' }, `${d.takes.filter(t => t.ok).length}/${d.storyboard?.shots?.length ?? d.takes.length} shots recorded`)),
    d.video
      ? h('div', { class: 'player' }, h('video', { src: d.video, controls: true, preload: 'metadata' }, d.outputs.some(o => o.name === 'demo.vtt') ? h('track', { kind: 'captions', src: d.outputs.find(o => o.name === 'demo.vtt').url, default: true, label: 'Captions' }) : null))
      : h('div', { class: 'card' }, h('b', {}, 'No final video yet. '), s.phase === 'done' ? '' : `The run stopped at "${s.phase}". `, 'The recorded takes are below.',
          h('div', { class: 'row' }, h('button', { class: 'secondary', type: 'button', disabled: busy, onclick: async () => { try { follow(await api(`/api/runs/${runId}/resume`, {})); } catch (x) { alert(x.message); } } }, 'Continue this run'))),
    files.length ? h('div', { class: 'sect' }, h('h3', {}, 'Files'), h('div', { class: 'files' }, files.map(f => h('a', { href: f.url, target: '_blank', download: f.name.endsWith('.mp4') || f.name.endsWith('.gif') ? null : f.name }, f.name)))) : null,
    s.findings?.length ? h('div', { class: 'sect' }, h('h3', {}, `Checks: ${s.findings.length} issue(s)`), h('ul', { class: 'findings' }, s.findings.map(f => h('li', {}, h('code', {}, f.rule), ' ', f.shotId ? `${f.shotId}: ` : '', f.message)))) : (d.video ? h('div', { class: 'sect' }, h('h3', {}, 'Checks: all passed')) : null),
    s.notes?.length ? h('div', { class: 'sect' }, h('h3', {}, 'Notes'), h('ul', { class: 'findings' }, s.notes.map(n => h('li', {}, n)))) : null,
    d.video ? h('div', { class: 'sect' }, h('h3', {}, 'Edit'),
      h('div', { class: 'row' }, edit, h('button', { class: 'secondary', type: 'button', disabled: busy, onclick: doEdit }, 'Apply'),
        d.versions.length > 1 ? h('button', { class: 'ghost', type: 'button', disabled: busy, onclick: async () => { try { follow(await api(`/api/runs/${runId}/undo`, {})); } catch (x) { alert(x.message); } } }, 'Undo last edit') : null),
      d.versions.length ? h('ol', { class: 'versions', style: 'margin-top:10px' }, d.versions.map(v => h('li', { class: v.current ? 'cur' : '', value: v.version }, `${v.note} · ${v.duration.toFixed(1)}s${v.current ? ' (current)' : ''}`))) : null) : null,
    samples.length ? h('div', { class: 'sect' }, h('h3', {}, 'Style samples'), h('div', { class: 'samples' }, samples.map(f => h('figure', {}, h('video', { src: f.url, controls: true, preload: 'none' }), h('figcaption', {}, f.name))))) : null,
    stills.length ? h('div', { class: 'sect' }, h('h3', {}, 'Stills'), h('div', { class: 'stills' }, stills.map(f => h('a', { href: f.url, target: '_blank' }, h('img', { src: f.url, loading: 'lazy', alt: f.name }))))) : null,
    d.takes.length ? h('details', { class: 'sect', open: !d.video }, h('summary', {}, h('b', {}, `Recorded takes (${d.takes.length})`)),
      h('div', { class: 'takes', style: 'margin-top:10px' }, d.takes.map(t => h('figure', {}, h('video', { src: t.url, controls: true, preload: 'metadata' }),
        h('figcaption', {}, `${t.shotId}${t.title ? ' · ' + t.title : ''} · ${t.ok ? `ok, score ${t.score}` : 'failed' + (t.error ? ': ' + t.error : '')}`))))) : null
  ].filter(Boolean));
}

// ── History ──────────────────────────────────────────────────────────────────
async function loadHistory() {
  const list = await api('/api/runs').catch(() => []);
  const ul = $('#history');
  if (!list.length) { ul.replaceChildren(h('li', { class: 'empty' }, 'No demos yet.')); return; }
  ul.replaceChildren(...list.slice(0, 30).map(r => h('li', { onclick: () => showRun(r.runId) },
    h('div', { style: 'min-width:0' }, h('div', { class: 'g' }, r.goal), h('div', { class: 'u' }, r.url || r.runId)),
    h('div', { class: 'r' }, r.video ? '🎞 video' : r.phase, h('br'), new Date(r.mtime).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })))));
}
$('#refresh').addEventListener('click', loadHistory);

buildLengths();
loadOptions().catch(x => { const b = $('#banner'); b.hidden = false; b.textContent = 'Cannot reach the UI server: ' + x.message; });
loadHistory();

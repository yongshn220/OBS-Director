// ============================================================
//  X32 Auto-Director — redesign frontend (LIVE / SETUP)
//  Reuses the existing backend contract: WS /ws + REST /api/*.
// ============================================================

const state = {
  config: null,
  ws: null,
  screen: 'live',          // 'live' | 'setup'
  setupStep: 0,            // 0..5
  editRuleId: null,
  fps: { n: 0, t0: Date.now() },
  liveShell: false,
  controlsSig: '',
  chanSig: '',
  channelCells: [],
  lastTick: null,
};

// ── tiny DOM helper ────────────────────────────────────────
function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    const v = attrs[k];
    if (v == null) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── palette / format helpers ───────────────────────────────
const CAMC = { 1: '#ffb02e', 2: '#4488ff', 3: '#00d68f', 4: '#ff5da2', 5: '#b06bff', 6: '#33c5ff', 7: '#ff8a5b' };
const FADER = 'linear-gradient(to top,#1fbf6b 0%,#2ad07a 52%,#c9c23a 74%,#e0913a 87%,#e8503a 100%)';
const SWATCHES = ['#3ddc97', '#5b9bff', '#e8c14a', '#ff6b85', '#b06bff', '#33c5ff', '#ff8a5b', '#7c8694'];
function camColor(cam) {
  if (cam == null || cam === '') return '#7c8694';
  const n = parseInt(cam, 10);
  if (!isNaN(n)) return CAMC[((n - 1) % 7) + 1] || '#7c8694';
  let h = 0; for (const c of String(cam)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return SWATCHES[h % SWATCHES.length];
}
const camLabel = (c) => (c == null || c === '') ? '—' : 'CAM ' + c;
const pct = (db) => Math.max(0, Math.min(100, (db + 78) / 78 * 100));
function fmtDb(db) { if (db == null || !isFinite(db)) return '−∞'; return (db >= 0 ? '+' : '') + db.toFixed(1); }
function groupColor(name) { const g = state.config?.groups?.[name]; return g ? g.color : '#7c8694'; }

// ── subjects ("role:Piano" | "team:instruments" | "WIDE") ──
const WIDE = 'WIDE';
function splitSubject(s) {
  if (!s) return { kind: 'none', name: '' };
  if (s === WIDE) return { kind: 'wide', name: '전체' };
  const i = s.indexOf(':');
  if (i < 0) return { kind: 'none', name: '' };
  const kind = s.slice(0, i), name = s.slice(i + 1);
  return (kind === 'role' || kind === 'team') && name ? { kind, name } : { kind: 'none', name: '' };
}
function subjectLabel(s) {
  const { kind, name } = splitSubject(s);
  return kind === 'wide' ? '전체 뷰' : kind === 'none' ? '미지정' : name;
}
// A team and a role may share a name (e.g. "Pastor"), so anywhere both kinds
// appear in one list the label has to say which is which.
function subjectsLabel(list) {
  const a = (list || []).map(subjectLabel);
  return a.length ? a.join(' + ') : '미배정';
}
function subjectLabelQualified(s) {
  const { kind, name } = splitSubject(s);
  return kind === 'team' ? `${name} (팀)` : subjectLabel(s);
}
function subjectColor(s) {
  const { kind, name } = splitSubject(s);
  if (kind === 'wide') return '#c9d1db';
  if (kind === 'role') return state.config?.roles?.[name]?.color || '#5b9bff';
  if (kind === 'team') return groupColor(name);
  return '#7c8694';
}
// Does this subject still point at something that exists?
function subjectExists(s) {
  const { kind, name } = splitSubject(s);
  if (kind === 'wide') return true;
  if (kind === 'role') return !!state.config?.roles?.[name];
  if (kind === 'team') return !!state.config?.groups?.[name];
  return false;
}
const SIZE_LABEL = { wide: 'W', mid: 'M', tight: 'T' };
const SIZE_NEXT = { wide: 'mid', mid: 'tight', tight: 'wide' };
// Why the planner cut here — surfaced so the operator can tell a deliberate
// early cut from a plain cadence one.
const CUT_CAUSE = {
  open: '장면 시작', cadence: '정상 컷', interrupt: '새 소스 등장', manual: '수동',
};

// ── REST helpers ───────────────────────────────────────────
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) { console.error('api', method, path, await res.text().catch(() => '')); throw new Error('api ' + res.status); }
  return res.status === 200 ? res.json().catch(() => null) : null;
}
async function loadConfig() { state.config = await api('GET', '/api/config'); }
const patchRuntime = (b) => api('PATCH', '/api/runtime', b).then(rt => { if (state.config) state.config.runtime = rt; });
const setOverride = (rid) => api('POST', '/api/override', { rule_id: rid });
const setShot = (mid) => api('POST', '/api/override/shot', { macro_id: mid });
async function patchChannel(id, body) { state.config = await api('PATCH', `/api/channels/${id}`, body); refreshSetup(); }
async function upsertGroup(name, body) { await api('PUT', `/api/groups/${encodeURIComponent(name)}`, body); await loadConfig(); refreshSetup(); }
async function deleteGroup(name) { await api('DELETE', `/api/groups/${encodeURIComponent(name)}`); await loadConfig(); refreshSetup(); }
async function reorderRoles(order) { await api('POST', '/api/roles/reorder', { order }); await loadConfig(); refreshSetup(); }
async function reorderGroups(order) { await api('POST', '/api/groups/reorder', { order }); await loadConfig(); refreshSetup(); }
// Move one name within its own list; the server rebuilds the map in that order.
function moveName(list, name, dir, apply) {
  const i = list.indexOf(name), j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  const next = [...list];
  [next[i], next[j]] = [next[j], next[i]];
  apply(next);
}
async function upsertRole(name, body) { await api('PUT', `/api/roles/${encodeURIComponent(name)}`, body); await loadConfig(); refreshSetup(); }
async function deleteRole(name) { await api('DELETE', `/api/roles/${encodeURIComponent(name)}`); await loadConfig(); refreshSetup(); }
async function createMacro(patch) { const m = await api('POST', '/api/macros', patch || {}); await loadConfig(); refreshSetup(); return m; }
async function updateMacro(id, patch) { await api('PUT', `/api/macros/${encodeURIComponent(id)}`, patch); await loadConfig(); }
async function deleteMacro(id) { await api('DELETE', `/api/macros/${encodeURIComponent(id)}`); await loadConfig(); refreshSetup(); }
async function updateRule(id, body) { await api('PUT', `/api/rules/${id}`, body); await loadConfig(); refreshSetup(); }
// A scene's profile is patched as a whole object — merge locally, send merged.
async function updateProfile(id, patch) {
  const r = (state.config.rules || []).find(x => x.id === id);
  if (!r) return;
  await updateRule(id, { profile: { ...(r.profile || {}), ...patch } });
}
const patchDefaultProfile = (patch) => patchRuntime({ profile: patch }).then(() => loadConfig()).then(refreshSetup);
async function deleteRuleApi(id) { await api('DELETE', `/api/rules/${id}`); await loadConfig(); refreshSetup(); }
async function addRuleApi() { const r = await api('POST', '/api/rules', {}); await loadConfig(); state.editRuleId = r.id; refreshSetup(); renderModal(); }
async function reorderRules(ids) { await api('POST', '/api/rules/reorder', { order: ids }); await loadConfig(); refreshSetup(); }
async function patchAss(url) { await api('PATCH', '/api/connections/ass_http', { url }); await loadConfig(); }

// ── boot ───────────────────────────────────────────────────
async function boot() {
  await loadConfig();
  bindHeader();
  buildLiveShell();
  buildSetupNav();
  applyScreen();
  connectWS();
}

// ── WebSocket ──────────────────────────────────────────────
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => setX32(true, '연결됨');
  ws.onclose = () => { setX32(false, '끊김 — 재연결…'); setTimeout(connectWS, 1500); };
  ws.onerror = () => { try { ws.close(); } catch {} };
  ws.onmessage = (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type !== 'tick') return;
    state.lastTick = msg;
    // fps
    state.fps.n++;
    const now = Date.now();
    if (now - state.fps.t0 >= 1000) { $('fps-text').textContent = state.fps.n + ' fps'; state.fps.n = 0; state.fps.t0 = now; }
    try { renderTick(msg); } catch (err) { console.error(err); }
  };
}
function setX32(ok, txt) {
  const d = $('x32-dot');
  if (!d) return;
  d.className = 'hdr-dot' + (ok ? '' : ' err');
  $('x32-text').textContent = txt;
}

function renderTick(msg) {
  renderHeader(msg);
  renderAudioAlarm(msg.status || {});
  if (state.screen === 'live') renderLiveTick(msg);
  // SETUP is where thresholds get calibrated and scenes get written — both are
  // guesswork without the live signal in front of you, so the panes that need
  // it are driven by the same tick as the LIVE screen.
  else if (state.setupStep === 0) renderSetupChannels(msg);
  else if (state.setupStep === 3) renderSetupScenes(msg);
}

// ── Header ─────────────────────────────────────────────────
function bindHeader() {
  $('tg-live').onclick = () => { state.screen = 'live'; applyScreen(); };
  $('tg-setup').onclick = () => { state.screen = 'setup'; applyScreen(); };
  $('tg-auto').onclick = () => { if (rt().auto !== true) patchRuntime({ auto: true }); };
  $('tg-manual').onclick = () => { if (rt().auto !== false) patchRuntime({ auto: false }); };
  $('tg-rules').onclick = () => { if (rt().director_mode !== 'rules') patchRuntime({ director_mode: 'rules' }); };
  ['fast', 'normal', 'slow'].forEach(p => {
    $('tg-' + p).onclick = () => { if (rt().pace !== p) patchRuntime({ pace: p }); };
  });
  ['fast', 'normal', 'slow'].forEach(p => {
    $('tg-' + p).onclick = () => { if (rt().pace !== p) patchRuntime({ pace: p }); };
  });
  $('tg-dynamic').onclick = () => { if (rt().director_mode !== 'dynamic') patchRuntime({ director_mode: 'dynamic' }); };
  $('tg-dry').onclick = () => { if (rt().dry_run !== true) patchRuntime({ dry_run: true }); };
  $('tg-send').onclick = () => {
    if (rt().dry_run === false) return;
    if (!confirm('LIVE 출력으로 전환하면 실제로 OBS에 HTTP 명령을 보냅니다. 계속할까요?')) return;
    patchRuntime({ dry_run: false });
  };
  $('project-btn').onclick = (e) => { e.stopPropagation(); toggleProjectMenu(); };
  document.addEventListener('click', () => $('project-menu').classList.add('hidden'));
  renderHeaderStatic();
}
function rt() { return (state.config && state.config.runtime) || {}; }

function renderHeaderStatic() {
  $('project-name').textContent = state.config?.current_project || '—';
}
function seg(id, on, cls) {
  const b = $(id); if (!b) return;
  b.classList.toggle('on', on && !cls);
  ['on-nav', 'on-green', 'on-plan', 'on-out-dry', 'on-out-live'].forEach(c => { if (c !== cls) b.classList.remove(c); });
  if (cls) b.classList.toggle(cls, on);
}
function renderHeader(msg) {
  const r = msg.runtime || rt();
  const dry = r.dry_run !== false;
  // screen
  seg('tg-live', state.screen === 'live', 'on-nav');
  seg('tg-setup', state.screen === 'setup', 'on-nav');
  // engine
  seg('tg-auto', r.auto !== false, 'on-green');
  seg('tg-manual', r.auto === false, 'on-nav');
  // planner
  const dyn = r.director_mode === 'dynamic';
  seg('tg-rules', !dyn, 'on-plan');
  seg('tg-dynamic', dyn, 'on-plan');
  // pace + beat lock
  const pace = r.pace || 'normal';
  ['fast', 'normal', 'slow'].forEach(p => seg('tg-' + p, pace === p, 'on-plan'));
  const b = (msg.engine || {}).beat || {};
  const bo = $('beat-readout');
  if (bo) {
    bo.textContent = b.locked ? `${b.bpm} BPM` : '박자 없음';
    bo.className = 'hdr-beat' + (b.locked ? ' on' : '');
  }
  // output
  seg('tg-dry', dry, 'on-out-dry');
  seg('tg-send', !dry, 'on-out-live');
  // accent rail + out status
  $('accent-rail').style.background = dry ? '#a8801f' : 'var(--live)';
  const os = $('out-status');
  os.textContent = dry ? 'DRY · NOT SENDING' : 'SENDING HTTP';
  os.style.color = dry ? 'var(--dry-tx)' : 'var(--live-tx)';
  // x32 status
  const st = msg.status || {};
  const dot = $('x32-dot'), txt = $('x32-text');
  if (st.mode === 'live') { dot.className = 'hdr-dot'; txt.textContent = 'x32 connected'; }
  else if (st.mode === 'error') { dot.className = 'hdr-dot err'; txt.textContent = '오디오 없음'; }
  else if (st.mode === 'demo') { dot.className = 'hdr-dot warn'; txt.textContent = 'demo'; }
  else { dot.className = 'hdr-dot warn'; txt.textContent = st.mode || '—'; }
  if (state.config && $('project-name').textContent !== state.config.current_project)
    $('project-name').textContent = state.config.current_project || '—';
}

function renderAudioAlarm(status) {
  const a = $('audio-alarm');
  const err = status && status.mode === 'error';
  a.classList.toggle('hidden', !err);
  if (err) a.textContent = '⚠ 오디오 입력 없음 — ' + (status.error || 'X32 신호 없음') + ' · 자동 재연결 시도 중…';
}

function applyScreen() {
  $('screen-live').classList.toggle('hidden', state.screen !== 'live');
  $('screen-setup').classList.toggle('hidden', state.screen !== 'setup');
  seg('tg-live', state.screen === 'live', 'on-nav');
  seg('tg-setup', state.screen === 'setup', 'on-nav');
  if (state.screen === 'live') { buildLiveControls(); if (state.lastTick) renderLiveTick(state.lastTick); }
  else refreshSetup();
}

// ════════════════════════════════════════════════════════════
//  LIVE SCREEN
// ════════════════════════════════════════════════════════════
function buildLiveShell() {
  const root = $('screen-live');
  root.innerHTML = '';

  // 1) TAKE A SHOT + PIN TRANSITION
  const cShot = el('div', { class: 'card' },
    el('div', { class: 'card-hd' }, el('span', { class: 'lbl' }, 'TAKE A SHOT'), el('span', { class: 'grow' }),
      el('button', { class: 'btn-ghost', onclick: () => setShot(null) }, 'RELEASE')),
    el('div', { id: 'live-shots', class: 'shot-rows' }),
    el('div', { class: 'hair', style: 'margin:2px 0' }),
    el('span', { class: 'lbl' }, 'PIN SCENE'),
    el('div', { id: 'live-pins', class: 'pins' }),
  );

  // 2) ON AIR + NEXT CUTS
  const cAir = el('div', { class: 'card raised' },
    el('div', { class: 'card-hd' }, el('span', { class: 'lbl' }, 'ON AIR'),
      el('span', { class: 'meta', id: 'air-meta' }, ''), el('span', { class: 'grow' }),
      el('span', { class: 'tally', id: 'air-tally' }, 'LIVE')),
    el('div', { class: 'onair-row' },
      el('div', { class: 'cam-badge', id: 'air-badge' },
        el('span', { class: 'cb-l', id: 'air-badge-l' }, 'CAM'), el('span', { class: 'cb-n', id: 'air-badge-n' }, '—')),
      el('div', { class: 'onair-mid' },
        el('div', { class: 'onair-name', id: 'air-name' }, '대기 중'),
        el('div', { class: 'onair-sub', id: 'air-sub' })),
      el('div', { class: 'onair-next' },
        el('span', { class: 'lbl-sm' }, 'NEXT CUT IN'),
        el('span', { class: 'count-num', id: 'air-count' }, '—'),
        el('span', { class: 'count-track' }, el('span', { class: 'count-fill', id: 'air-fill' })))),
    el('div', { class: 'hair' }),
    el('div', { class: 'card-hd' }, el('span', { class: 'lbl' }, 'NEXT CUTS'),
      el('span', { class: 'meta' }, '지금 소리 기준 · 소리 바뀌면 달라짐')),
    el('div', { id: 'live-next', class: 'nextcuts' }),
  );

  // 3) ACTIVE SCENE
  const cRule = el('div', { class: 'card' },
    el('div', { class: 'card-hd' }, el('span', { class: 'lbl' }, 'ACTIVE SCENE'), el('span', { class: 'grow' }),
      el('button', { class: 'btn-ghost', id: 'matched-edit' }, 'EDIT')),
    el('div', { id: 'matched-body' }),
    el('div', { style: 'display:flex;flex-direction:column;gap:5px;padding-top:10px;border-top:1px solid var(--bd-hair)' },
      el('span', { class: 'lbl-sm', style: 'font-size:8px' }, 'ALSO MATCHING'),
      el('div', { id: 'matched-queue', style: 'display:flex;flex-direction:column;gap:6px' })),
  );

  // 4) CHANNELS (span 2)
  const cChan = el('div', { class: 'card chan-card' },
    el('div', { class: 'card-hd' }, el('span', { class: 'lbl' }, 'CHANNELS'),
      el('span', { class: 'meta', id: 'chan-summary' }, ''), el('span', { class: 'grow' }),
      el('span', { class: 'meta', id: 'chan-peak', style: 'color:var(--mut)' }, ''),
      el('span', { style: 'display:flex;align-items:center;gap:5px', class: 'meta' },
        el('span', { style: 'width:14px;height:1px;background:var(--tx);opacity:.5;display:block' }), 'threshold')),
    el('div', { id: 'vu-grid', class: 'vu-grid' }),
  );

  // 5) LISTENING
  const cListen = el('div', { class: 'card listen-card' },
    el('span', { class: 'lbl' }, 'LISTENING'),
    el('div', { id: 'group-bars', style: 'display:flex;flex-direction:column;gap:11px' }),
    el('div', { class: 'roles-on', id: 'roles-on' }, el('span', { class: 'lbl-sm', style: 'font-size:8px' }, 'ROLES ON')),
  );

  // Column order: ACTIVE SCENE, ON AIR, TAKE A SHOT. The cards flow in DOM
  // order across the three-column grid, so swapping them here is the swap.
  root.append(cRule, cAir, cShot, cChan, cListen);
  state.liveShell = true;
  $('matched-edit').onclick = () => { const id = state._matchedRuleId; if (id) { state.editRuleId = id; renderModal(); } };
  buildChannelsGrid();
  buildLiveControls();
}

function buildChannelsGrid() {
  const grid = $('vu-grid');
  if (!grid) return;
  const chans = state.config?.channels || [];
  const sig = 'n:' + chans.length;
  if (sig === state.chanSig && state.channelCells.length) return;
  state.chanSig = sig;
  grid.innerHTML = '';
  state.channelCells = [];
  chans.forEach(ch => {
    const fill = el('span', { class: 'vu-fill' });
    const thr = el('span', { class: 'vu-thr' });
    const name = el('span', { class: 'vu-name' });
    const grp = el('span', { class: 'vu-grp' });
    const num = el('span', { class: 'vu-num' }, 'CH' + String(ch.id).padStart(2, '0'));
    const db = el('span', { class: 'vu-db' }, '—');
    const track = el('div', { class: 'vu-track' }, fill, thr,
      el('div', { class: 'vu-info' }, name, grp, el('span', { class: 'grow' }), num));
    const cell = el('div', { class: 'vu-cell' }, track, db);
    grid.append(cell);
    state.channelCells.push({ cell, track, fill, thr, name, grp, num, db, id: ch.id });
  });
}

function buildLiveControls() {
  if (!state.liveShell) return;
  const macros = state.config?.macros || [];
  const scenes = state.config?.rules || [];
  const sig = 'M:' + macros.map(m => m.id + m.name + m.camera).join(',') + '|S:' + scenes.map(r => r.id + r.name).join(',');
  if (sig === state.controlsSig) return;
  state.controlsSig = sig;

  // shot palette by camera
  const shots = $('live-shots');
  shots.innerHTML = '';
  const byCam = {};
  macros.forEach(m => { const c = (m.camera == null || m.camera === '') ? '' : String(m.camera); (byCam[c] = byCam[c] || []).push(m); });
  if (!macros.length) shots.append(el('span', { class: 'hint' }, 'SETUP → Shot map에서 샷을 먼저 만드세요.'));
  Object.keys(byCam).sort().forEach(c => {
    const color = camColor(c);
    const row = el('div', { class: 'shot-row' },
      el('span', { class: 'shot-cam', style: `color:${color}` }, camLabel(c)),
      el('div', { class: 'shot-btns' },
        byCam[c].map(m => el('button', { class: 'shot', 'data-mid': m.id, style: `border-left-color:${color}`,
          title: subjectsLabel(m.subjects),
          onclick: () => { const cur = state.lastTick?.engine?.override_macro_id; setShot(cur === m.id ? null : m.id); } },
          m.name || m.token || m.id))));
    shots.append(row);
  });

  // pin scenes
  const pins = $('live-pins');
  pins.innerHTML = '';
  pins.append(el('button', { class: 'pin', 'data-tid': '__auto__', onclick: () => setOverride(null) }, 'Auto (scenes)'));
  scenes.forEach(r => pins.append(el('button', { class: 'pin', 'data-tid': r.id, onclick: () => setOverride(r.id) }, r.name || '(이름 없음)')));
}

function renderLiveTick(msg) {
  if (!state.liveShell) return;
  buildLiveControls();
  buildChannelsGrid();
  const eng = msg.engine || {};
  const d = eng.director || {};
  const dry = (msg.runtime || {}).dry_run !== false;
  const heldShot = eng.override_macro_id || null;
  const pinScene = eng.override_rule_id || null;
  const cur = d.current || null;

  // control on-states
  document.querySelectorAll('#live-shots .shot').forEach(b => b.classList.toggle('on', b.dataset.mid === heldShot));
  document.querySelectorAll('#live-pins .pin').forEach(b => {
    b.classList.toggle('on', b.dataset.tid === '__auto__' ? (!pinScene && !heldShot) : b.dataset.tid === pinScene);
  });

  // ON AIR
  const badge = $('air-badge'), col = camColor(cur?.camera);
  $('air-badge-l').style.color = col; $('air-badge-n').style.color = col; badge.style.borderColor = cur ? col : 'var(--bd-strong)';
  badge.style.background = cur ? 'rgba(255,255,255,0.03)' : 'transparent';
  $('air-badge-n').textContent = cur?.camera ?? '—';
  $('air-name').textContent = cur?.name || '대기 중';
  const sub = $('air-sub'); sub.innerHTML = '';
  if (cur) {
    (cur.subjects || []).forEach(sj => sub.append(
      el('span', { class: 'chip', style: `border-color:${subjectColor(sj)}` }, subjectLabel(sj))));
    const live = d.active_subjects || [];
    sub.append(el('span', {}, live.length ? ('활성: ' + live.map(subjectLabel).join(' · ')) : '활성 소스 없음'));
  }
  const tally = $('air-tally');
  tally.textContent = dry ? 'DRY' : 'LIVE';
  tally.style.color = dry ? 'var(--dry-tx)' : 'var(--live-tx)';
  tally.style.borderColor = dry ? 'var(--dry)' : 'var(--live)';
  // meta line — scene, why we cut here, and the hold floor if it's still locked
  const flags = [];
  if (d.scene_name) flags.push(d.scene_name);
  if (d.cause) flags.push(CUT_CAUSE[d.cause] || d.cause);
  if (d.beats) flags.push(`${d.beats}비트`);
  $('air-meta').textContent = flags.join(' · ');
  // countdown
  const interval = (!heldShot && cur) ? (d.interval || 0) : 0;
  const nextIn = (!heldShot && cur && d.next_in != null) ? d.next_in : null;
  $('air-count').textContent = heldShot ? '고정' : (nextIn != null ? nextIn.toFixed(1) + 's' : (cur ? (d.held ? '고정 샷' : '정지') : '—'));
  $('air-fill').style.width = (interval > 0 && nextIn != null ? Math.max(0, Math.min(100, (1 - nextIn / interval) * 100)) : 0) + '%';

  // NEXT CUTS
  const nx = $('live-next'); nx.innerHTML = '';
  const up = heldShot ? [] : (d.upcoming || []);
  up.slice(0, 5).forEach((u, i) => {
    const c = camColor(u.camera);
    const at = (nextIn != null && interval) ? '+' + (nextIn + i * interval).toFixed(1) + 's' : '';
    nx.append(el('div', { class: 'nc', style: `border-top-color:${c}` },
      el('div', { class: 'nc-top' }, el('span', { class: 'nc-cam', style: `color:${c}` }, camLabel(u.camera)),
        el('span', { class: 'grow' }), el('span', { class: 'nc-idx' }, '#' + (i + 1))),
      el('div', { class: 'nc-name' }, u.name || u.macro_id),
      el('div', { class: 'nc-at' }, subjectsLabel(u.subjects) + (at ? ' · ' + at : ''))));
  });
  if (!up.length) nx.append(el('span', { class: 'hint', style: 'grid-column:1/-1' }, heldShot ? '수동 샷 고정 중' : '대기 중'));

  // MATCHED RULE
  renderMatched(msg);

  // CHANNELS
  renderChannels(msg);

  // LISTENING
  renderListening(msg);
}

function renderMatched(msg) {
  const eng = msg.engine || {};
  const body = $('matched-body'), queue = $('matched-queue');
  body.innerHTML = ''; queue.innerHTML = '';
  const rules = state.config?.rules || [];
  const activeId = eng.active_rule_id;
  const ruleCfg = rules.find(r => r.id === activeId);
  state._matchedRuleId = ruleCfg ? ruleCfg.id : null;
  $('matched-edit').style.visibility = ruleCfg ? 'visible' : 'hidden';

  if (ruleCfg) {
    const rank = rules.slice().sort((a, b) => (b.priority || 0) - (a.priority || 0)).findIndex(r => r.id === ruleCfg.id) + 1;
    body.append(
      el('div', { style: 'display:flex;align-items:center;gap:9px;margin-bottom:8px' },
        el('span', { class: 'mr-name' }, ruleCfg.name || '—'),
        el('span', { class: 'mr-rank' }, '#' + rank)),
      el('div', { class: 'pill-row' }, condPills(ruleCfg.conditions || [])),
    );
  } else {
    const d = eng.director || {};
    const modeName = eng.override_macro_id ? '수동 샷'
      : (d.scene_name || (eng.director_mode === 'dynamic' ? '기본 장면 (DYNAMIC)' : '대기 중'));
    body.append(el('div', { style: 'display:flex;align-items:center;gap:9px;margin-bottom:8px' }, el('span', { class: 'mr-name' }, modeName)));
    if (d.active_subjects?.length)
      body.append(el('div', { class: 'pill-row' }, d.active_subjects.map(s =>
        el('span', { class: 'cond on' }, subjectLabel(s)))));
  }

  // A scene held open by its hold time can outlive its own conditions, so show
  // which of them still hold rather than implying all of them do.
  markCondPills(body, liveStates(msg));

  // ...and how much of that hold is left, since that is what explains a
  // higher-priority scene visibly waiting its turn.
  const dd = eng.director || {};
  if (dd.hold_s) {
    const left = dd.hold_left ?? 0;
    const pctDone = Math.max(0, Math.min(100, (1 - left / dd.hold_s) * 100));
    body.append(el('div', { style: 'display:flex;align-items:center;gap:9px;margin-top:11px' },
      el('span', { class: 'lbl-sm' }, 'HOLD'),
      el('span', { class: 'grow', style: 'height:3px;border-radius:2px;background:var(--bd-hair);overflow:hidden;display:block' },
        el('span', { style: `display:block;height:100%;width:${pctDone}%;background:${left > 0 ? 'var(--dry)' : 'var(--mut3)'}` })),
      el('span', { class: 'meta', style: 'color:#a8b1bd' },
        left > 0 ? left.toFixed(1) + 's 남음' : '해제')));
  }

  (eng.matching || []).filter(m => m.id !== activeId).slice(0, 3).forEach((m, i) => {
    const rank = rules.slice().sort((a, b) => (b.priority || 0) - (a.priority || 0)).findIndex(r => r.id === m.id) + 1;
    queue.append(el('div', { class: 'also' },
      el('span', { class: 'meta', style: 'width:26px' }, '#' + (rank || '?')),
      el('span', {}, m.name), el('span', { class: 'grow' }),
      el('span', { class: 'meta' }, m.preview || '')));
  });
  if (!(eng.matching || []).filter(m => m.id !== activeId).length)
    queue.append(el('span', { class: 'meta' }, '—'));
}
function condPills(conds) {
  return conds.map(c => {
    const on = c.state === 'active';
    // data-* lets the tick loop mark which conditions currently hold without
    // rebuilding the pills — a rebuild would fight the operator mid-edit.
    return el('span', {
      class: 'cond ' + (on ? 'on' : 'off'), 'data-cond': c.group, 'data-want': on ? '1' : '0',
    }, el('span', { class: 'cond-dot' }), c.group + ' ' + (on ? 'on' : 'off'));
  });
}
// Bare team/role name -> is it live right now. Teams last, so a team wins a
// name collision — the same precedence the engine's matcher uses.
function liveStates(msg) {
  const out = {};
  Object.entries(msg.roles || {}).forEach(([n, s]) => { out[n] = !!s.active; });
  Object.entries(msg.groups || {}).forEach(([n, s]) => { out[n] = !!s.active; });
  return out;
}
// Mark every condition pill on screen with whether it is satisfied right now.
function markCondPills(root, live) {
  root.querySelectorAll('.cond[data-cond]').forEach(p => {
    const on = !!live[p.dataset.cond];
    p.classList.toggle('holds', on === (p.dataset.want === '1'));
  });
}

function renderChannels(msg) {
  const chans = state.config?.channels || [];
  const dbs = msg.levels_db || [];
  const groups = msg.groups || {};
  let peakIdx = -1, peakDb = -Infinity;
  state.channelCells.forEach((cell, i) => {
    const ch = chans[i]; if (!ch) return;
    const db = dbs[ch.id - 1];
    const has = !!ch.group;
    const on = has && db != null && db >= (ch.threshold_db ?? -45);
    const idle = !has;
    if (db != null && db > peakDb) { peakDb = db; peakIdx = ch.id; }
    // vu fill
    const h = db != null ? pct(db) : 0;
    cell.fill.style.height = h + '%';
    if (on) {
      cell.fill.style.backgroundImage = FADER;
      cell.fill.style.backgroundSize = '100% ' + cell.track.clientHeight + 'px';
      cell.fill.style.backgroundPosition = 'left bottom';
      cell.fill.style.backgroundRepeat = 'no-repeat';
    } else { cell.fill.style.backgroundImage = 'none'; cell.fill.style.background = '#2b313a'; }
    cell.thr.style.bottom = pct(ch.threshold_db ?? -45) + '%';
    cell.name.textContent = ch.name || '—';
    cell.grp.textContent = ch.role || ch.group || '';
    cell.grp.style.color = has ? groupColor(ch.group) : 'var(--mut3)';
    cell.db.textContent = db != null ? db.toFixed(1) : '—';
    cell.cell.classList.toggle('idle', idle);
    cell.name.style.color = on ? '#f2f5f8' : 'var(--tx-dim)';
    cell.num.style.color = on ? '#cdd4dd' : '#8a94a2';
    cell.db.style.color = on ? '#a8b1bd' : 'var(--mut3)';
  });
  const assigned = chans.filter(c => c.group).length;
  $('chan-summary').textContent = `${chans.length} in · ${assigned} assigned`;
  if (peakIdx > 0) {
    const ch = chans.find(c => c.id === peakIdx);
    $('chan-peak').innerHTML = `PEAK CH${peakIdx} ${esc(ch?.name || '')} <span style="color:var(--tx)">${peakDb.toFixed(1)}</span> dB`;
  }
}

function renderListening(msg) {
  const groups = state.config?.groups || {};
  const gstates = msg.groups || {};
  const bars = $('group-bars'); bars.innerHTML = '';
  Object.keys(groups).forEach(name => {
    const g = gstates[name] || {};
    const on = !!g.active, color = groups[name].color;
    const level = g.peak_db != null && isFinite(g.peak_db) ? pct(g.peak_db) : 4;
    bars.append(el('div', { class: 'gbar' },
      el('div', { class: 'gbar-top' },
        el('span', { class: 'gbar-dot', style: `background:${on ? color : 'var(--bd-strong)'}` }),
        el('span', { class: 'gbar-name', style: on ? 'color:var(--tx)' : '' }, name),
        el('span', { class: 'grow' }),
        el('span', { class: 'gbar-db', style: on ? `color:${color}` : '' }, g.peak_db != null && isFinite(g.peak_db) ? fmtDb(g.peak_db) + ' dB' : '—')),
      el('div', { class: 'gbar-track' }, el('span', { class: 'gbar-fill', style: `width:${level}%;background:${on ? color : 'var(--bd-strong)'}` }))));
  });
  // roles on
  const roles = msg.roles || {};
  const ro = $('roles-on');
  ro.querySelectorAll('.role-tag').forEach(n => n.remove());
  Object.keys(roles).filter(r => roles[r].active).forEach(r => ro.append(el('span', { class: 'role-tag' }, r)));
  if (!Object.keys(roles).some(r => roles[r].active)) ro.append(el('span', { class: 'role-tag', style: 'opacity:.5' }, '—'));
}

// ════════════════════════════════════════════════════════════
//  SETUP SCREEN
// ════════════════════════════════════════════════════════════
const SETUP_STEPS = [
  ['01', 'Channels', '32 inputs · team · role'],
  ['02', 'Teams & roles', 'groups, attack / release'],
  ['03', 'Shots', '샷 정의 — 이름 · 토큰 · 카메라'],
  ['04', 'Assign', '누구를 어느 샷으로 잡을지'],
  ['05', 'Scenes', '언제 · 어떤 방식으로'],
  ['06', 'Connection', 'ASS HTTP endpoint'],
];
function buildSetupNav() {
  const nav = $('setup-nav'); nav.innerHTML = '';
  nav.append(el('div', { class: 'nav-hd' }, 'SIGNAL FLOW'));
  SETUP_STEPS.forEach(([num, title, sub], i) => {
    nav.append(el('button', { class: 'nav-item' + (state.setupStep === i ? ' on' : ''), onclick: () => { state.setupStep = i; buildSetupNav(); refreshSetup(); } },
      el('span', { class: 'nav-num' }, num),
      el('span', { class: 'grow' }, el('span', { class: 'nav-title' }, title), el('span', { class: 'nav-sub' }, sub))));
  });
  nav.append(el('div', { style: 'height:1px;background:var(--bd-soft);margin:10px 12px' }));
  nav.append(el('div', { class: 'nav-note' }, 'SETUP은 별도 모드라, 서비스 중 실수로 건드릴 일이 없습니다.'));
}
function refreshSetup() { if (state.screen === 'setup') renderSetupPane(); }

const PANE_META = [
  ['Channels', '각 입력의 이름·팀·역할을 정하고, 소리로 인정되는 dB 임계값을 설정합니다.', null, null],
  ['Teams & roles', '팀(그룹)은 장면이 매칭하는 단위, 역할은 팀 안의 사람/악기입니다.', '+ Add team', () => { const n = prompt('새 팀 이름'); if (n) upsertGroup(n.trim(), { attack_ms: 200, release_ms: 1500, color: SWATCHES[Math.floor(Math.random() * SWATCHES.length)] }); }],
  ['Shots', '샷을 먼저 만듭니다. ASS로 보낼 토큰과 카메라·프레이밍만 정하세요. 누구를 잡는지는 다음 단계에서.', '+ 샷 추가', () => createMacro({ name: '', token: '', camera: '', size: 'tight' })],
  ['Assign', '만들어 둔 샷을 각 대상에 배정합니다. 빈 칸은 그 사람을 잡을 샷이 없다는 뜻입니다.', '+ 카메라', () => addCamera()],
  ['Scenes', '위가 우선순위. 장면은 "언제"만 정하고, 그 안에서 어떤 방식으로 돌릴지 고릅니다.', '+ Add scene', () => addRuleApi()],
  ['Connection', '모든 샷 토큰이 나가는 곳.', null, null],
];
function renderSetupPane() {
  const pane = $('setup-pane'); pane.innerHTML = '';
  const [title, sub, action, actionFn] = PANE_META[state.setupStep];
  pane.append(el('div', { class: 'pane-hd' },
    el('div', {}, el('div', { class: 'pane-title' }, title), el('div', { class: 'pane-sub' }, sub)),
    el('span', { class: 'grow' }),
    action ? el('button', { class: 'pane-action', onclick: actionFn }, action) : null));
  const body = el('div', { class: 'pane-body' });
  pane.append(body);
  ({ 0: paneChannels, 1: paneTeams, 2: paneShots, 3: paneAssign, 4: paneScenes, 5: paneConn }[state.setupStep])(body);
}

function paneChannels(body) {
  const cfg = state.config;
  body.append(el('div', { class: 'chtbl-head' },
    ...['CH', 'NAME', 'TEAM', 'ROLE', '박자', 'LEVEL / THRESHOLD'].map(h => el('span', {}, h))));
  const groups = cfg.groups || {}, roles = cfg.roles || {};
  state.chanCal = [];
  cfg.channels.forEach(ch => {
    const has = !!ch.group;
    const groupOpts = [el('option', { value: '' }, '— team —'), ...Object.keys(groups).map(g => el('option', { value: g }, g))];
    const rolesInGroup = Object.entries(roles).filter(([, r]) => r.group === ch.group).map(([n]) => n);
    const roleOpts = [el('option', { value: '' }, '— role —'), ...rolesInGroup.map(r => el('option', { value: r }, r))];
    const gsel = el('select', { class: 'inp', style: 'border-left:2px solid ' + (has ? groupColor(ch.group) : 'var(--bd)'),
      onchange: (e) => patchChannel(ch.id, { role: null, group: e.target.value || null }) }, ...groupOpts);
    gsel.value = ch.group || '';
    const rsel = el('select', { class: 'inp', onchange: (e) => patchChannel(ch.id, { role: e.target.value || null }) }, ...roleOpts);
    rsel.value = ch.role || ''; rsel.disabled = !has;
    const nameI = el('input', { class: 'inp', type: 'text', placeholder: '—', onchange: (e) => patchChannel(ch.id, { name: e.target.value }) });
    nameI.value = ch.name || '';

    // Meter and slider share one −78..0 scale and one width, so the slider
    // handle sits directly under the point on the meter it is cutting at.
    // Calibrating is then "drag the handle above the noise", not arithmetic.
    const fill = el('span', { class: 'cal-fill' });
    const thrTick = el('span', { class: 'cal-thr' });
    const meter = el('div', { class: 'cal-meter' }, fill, thrTick);
    const dbTxt = el('span', { class: 'cal-db' }, '—');
    const overTxt = el('span', { class: 'cal-over' }, '');
    const thrLabel = el('span', { class: 'cal-thrval' }, (ch.threshold_db ?? -45) + ' dB');
    const thr = el('input', { type: 'range', class: 'cal-slider', min: '-78', max: '0',
      oninput: (e) => { thrLabel.textContent = e.target.value + ' dB'; thrTick.style.left = pct(+e.target.value) + '%'; },
      onchange: (e) => patchChannel(ch.id, { threshold_db: +e.target.value }) });
    thr.value = ch.threshold_db ?? -45;
    thrTick.style.left = pct(ch.threshold_db ?? -45) + '%';

    // Percussive channels drive the tempo tracker. Marking them is far more
    // reliable than guessing from role names, and it is a rig fact, not a
    // per-service one, so it belongs with the channel.
    const beatI = el('input', { type: 'checkbox', class: 'beat-chk',
      title: '이 채널로 박자를 추적합니다 (드럼/퍼커션 권장)',
      onchange: (e) => patchChannel(ch.id, { beat_source: e.target.checked }) });
    beatI.checked = !!ch.beat_source;

    const row = el('div', { class: 'chtbl-row' + (has ? '' : ' unassigned') },
      el('span', { class: 'chtbl-ch' }, 'CH' + ch.id), nameI, gsel, rsel,
      el('div', { style: 'text-align:center' }, beatI),
      el('div', { class: 'cal-cell' },
        el('div', { class: 'cal-top' }, meter, dbTxt, overTxt),
        el('div', { class: 'cal-bot' }, thr, thrLabel)));
    state.chanCal.push({ id: ch.id, fill, thrTick, dbTxt, overTxt, row });
    body.append(row);
  });
}

function renderSetupChannels(msg) {
  const cells = state.chanCal;
  if (!cells || !cells.length) return;
  const chans = state.config?.channels || [];
  const dbs = msg.levels_db || [];
  cells.forEach(c => {
    const ch = chans.find(x => x.id === c.id);
    if (!ch) return;
    const db = dbs[c.id - 1];
    const thrDb = ch.threshold_db ?? -45;
    const over = db != null ? db - thrDb : null;
    const hot = over != null && over >= 0;
    c.fill.style.width = (db != null ? pct(db) : 0) + '%';
    c.fill.classList.toggle('hot', hot);
    c.fill.style.background = hot ? (ch.group ? groupColor(ch.group) : '#3ddc97') : '#39414c';
    c.dbTxt.textContent = db != null ? db.toFixed(1) : '—';
    c.dbTxt.style.color = hot ? 'var(--tx)' : 'var(--mut3)';
    // The margin above threshold is the number you actually calibrate against:
    // a channel sitting at +30 while nobody plays is noise, not signal.
    c.overTxt.textContent = over == null ? '' : (over >= 0 ? '+' : '') + over.toFixed(0);
    c.overTxt.className = 'cal-over' + (over == null ? '' : over >= 20 ? ' loud' : hot ? ' on' : '');
  });
}

function paneTeams(body) {
  const cfg = state.config;
  const grid = el('div', { class: 'teams-grid' });
  Object.entries(cfg.groups || {}).forEach(([name, g]) => {
    const rolesIn = Object.entries(cfg.roles || {}).filter(([, r]) => r.group === name).map(([n]) => n);
    const nameI = el('input', { class: 'team-name', type: 'text', onchange: (e) => { const nv = e.target.value.trim(); if (nv && nv !== name) { /* rename via delete+add not supported; just color/timing edit */ } } });
    nameI.value = name; nameI.disabled = true;   // rename not supported by API; keep read-only
    const attackVal = el('span', { class: 'sr-val' }, (g.attack_ms ?? 200) + ' ms');
    const releaseVal = el('span', { class: 'sr-val' }, (g.release_ms ?? 1000) + ' ms');
    const roleList = el('div', { class: 'role-list' },
      rolesIn.length ? rolesIn.map(r => el('span', { class: 'role-pill' }, r, el('button', { class: 'role-x', onclick: () => deleteRole(r) }, '×')))
        : el('span', { class: 'hint' }, '역할 없음'));
    const draft = el('input', { class: 'inp mono', type: 'text', placeholder: 'new role, e.g. Drum',
      onkeydown: (e) => { if (e.key === 'Enter' && e.target.value.trim()) upsertRole(e.target.value.trim(), { group: name, color: g.color }); } });
    const swatch = renderSwatch(g.color, (c) => upsertGroup(name, { color: c }));
    grid.append(el('div', { class: 'team-card' },
      el('div', { class: 'team-hd' }, swatch, nameI,
        el('button', { class: 'mini-btn danger', style: 'font-family:var(--mono);font-size:11px',
          onclick: () => { if (confirm(`팀 "${name}" 삭제? 이 팀의 역할도 함께 삭제됩니다.`)) deleteGroup(name); } }, 'delete')),
      slider('Attack', '켜지는 시간', g.attack_ms ?? 200, attackVal, (v) => upsertGroup(name, { attack_ms: v })),
      slider('Release', '꺼지는 시간', g.release_ms ?? 1000, releaseVal, (v) => upsertGroup(name, { release_ms: v })),
      el('div', { class: 'team-roles' },
        el('div', { class: 'lbl-sm', style: 'margin-bottom:8px' }, 'ROLES IN THIS TEAM'), roleList,
        el('div', { class: 'team-add' }, draft, el('button', { class: 'mini-btn', onclick: () => { if (draft.value.trim()) upsertRole(draft.value.trim(), { group: name, color: g.color }); } }, '+ role')))));
  });
  body.append(grid);
}
function slider(label, note, value, valEl, onDone) {
  const inp = el('input', { type: 'range', min: '0', max: '2500', step: '50', style: 'width:100%',
    oninput: (e) => valEl.textContent = e.target.value + ' ms', onchange: (e) => onDone(+e.target.value) });
  inp.value = value;
  return el('div', { class: 'slider-row' },
    el('div', { class: 'sr-top' }, el('span', {}, label), valEl), inp, el('div', { class: 'sr-note' }, note));
}
function renderSwatch(color, onPick) {
  const w = el('span', { class: 'swatch', style: `background:${color || '#3a4250'};position:relative;cursor:pointer` });
  const inp = el('input', { type: 'color', value: color || '#888888', style: 'position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%' });
  inp.addEventListener('input', () => w.style.background = inp.value);
  inp.addEventListener('change', () => onPick(inp.value));
  w.append(inp);
  return w;
}

// ── Shot map: rows = subjects, columns = cameras ────────────
// The old editor listed one row per shot and asked you to tick sources from a
// wall of every role and team — the inverse of how a director thinks, and it
// made a missing shot invisible. Here a hole in the grid IS the missing shot.
// The rig, stated in the project — so a camera exists (and gets a column to
// fill in) before any shot uses it.
const cameraColumns = () => state.config.cameras || [];
async function putCameras(cams) {
  try { await api('PUT', '/api/cameras', { cameras: cams }); }
  catch { alert('이 카메라를 쓰는 샷이 남아 있어 지울 수 없습니다. 먼저 Shots에서 옮기거나 삭제하세요.'); }
  await loadConfig(); refreshSetup();
}
function addCamera() {
  const name = (prompt('카메라 번호 또는 이름 (예: 4)') || '').trim();
  if (!name) return;
  if (cameraColumns().includes(name)) return;
  putCameras([...cameraColumns(), name]);
}

function subjectRows() {
  const cfg = state.config;
  const rows = [{ subject: WIDE, indent: 0, kind: 'wide' }];
  Object.keys(cfg.groups || {}).forEach(g => {
    rows.push({ subject: `team:${g}`, indent: 0, kind: 'team' });
    Object.entries(cfg.roles || {})
      .filter(([, r]) => r.group === g)
      .forEach(([r]) => rows.push({ subject: `role:${r}`, indent: 1, kind: 'role' }));
  });
  // Roles whose team was deleted still need somewhere to live.
  Object.entries(cfg.roles || {})
    .filter(([, r]) => !r.group || !cfg.groups?.[r.group])
    .forEach(([r]) => rows.push({ subject: `role:${r}`, indent: 1, kind: 'role' }));
  return rows;
}

// ── 03 Shots: the library ───────────────────────────────────
// A shot is defined here once — what to send and from which camera. Nothing
// about WHO it covers: that is assignment, and it belongs to the next step.
function paneShots(body) {
  const cfg = state.config;
  const shots = cfg.macros || [];
  body.append(el('div', { class: 'shotlib-head' },
    ...['NAME', 'TOKEN SENT TO ASS', 'CAM', 'FRAMING', 'ASSIGNED TO', ''].map(h => el('span', {}, h))));
  if (!shots.length) {
    body.append(el('span', { class: 'hint' }, '아직 샷이 없습니다. 우측 상단 “+ 샷 추가”.'));
    return;
  }
  shots.forEach(m => {
    const col = camColor(m.camera);
    const nameI = el('input', { class: 'inp', style: 'border-left:2px solid ' + col, type: 'text',
      placeholder: '이름', onchange: (e) => updateMacro(m.id, { name: e.target.value }).then(refreshSetup) });
    nameI.value = m.name || '';
    const tokI = el('input', { class: 'inp mono', type: 'text', placeholder: 'ASS 토큰',
      onchange: (e) => {
        const v = e.target.value.trim();
        // The name is a label for the token, so keep it in step unless the
        // operator has deliberately given the shot a different one.
        const patch = { token: v };
        if (!m.name || m.name === m.token) patch.name = v;
        updateMacro(m.id, patch).then(refreshSetup);
      } });
    tokI.value = m.token || '';
    // Picked from the rig, not typed — a free-text camera was how shots ended
    // up on columns that did not exist anywhere else.
    const cams = cameraColumns();
    const camI = el('select', { class: 'inp mono', style: 'text-align:center',
      onchange: (e) => {
        if (e.target.value === '__new__') { addCamera(); e.target.value = m.camera ?? ''; return; }
        updateMacro(m.id, { camera: e.target.value || null }).then(refreshSetup);
      } },
      el('option', { value: '' }, '—'),
      ...cams.map(c => el('option', { value: c }, camLabel(c))),
      el('option', { value: '__new__' }, '+ 새 카메라…'));
    camI.value = m.camera ?? '';
    const sizeSel = el('select', { class: 'inp', onchange: (e) => updateMacro(m.id, { size: e.target.value }).then(refreshSetup) },
      el('option', { value: 'wide' }, '와이드'), el('option', { value: 'mid' }, '미디엄'), el('option', { value: 'tight' }, '타이트'));
    sizeSel.value = m.size || 'tight';
    const assigned = (m.subjects || []);
    const asg = el('div', { class: 'shot-asg' },
      assigned.length
        ? assigned.map(s => el('span', { class: 'asg-chip', style: `--sc:${subjectColor(s)}` }, subjectLabelQualified(s)))
        : el('button', { class: 'asg-none', onclick: () => { state.setupStep = 3; buildSetupNav(); refreshSetup(); } }, '미배정 — Assign에서'));
    // No token = nothing is actually sent, so the planner skips it. Say so
    // rather than letting it sit in the list looking finished.
    const empty = !(m.token || '').trim();
    if (empty) tokI.classList.add('warn');
    body.append(el('div', { class: 'shotlib-row' + (empty ? ' incomplete' : '') },
      nameI, tokI, camI, sizeSel, asg,
      el('button', { class: 'role-x', onclick: () => { if (confirm(`샷 "${m.name || m.token || m.id}" 삭제?`)) deleteMacro(m.id); } }, '×')));
  });
  const empties = shots.filter(m => !(m.token || '').trim());
  body.append(el('div', { class: 'sm-foot' },
    el('span', {}, `샷 ${shots.length}개`),
    empties.length ? el('span', { class: 'sm-warn' },
      `⚠ 토큰이 빈 샷 ${empties.length}개 — 보낼 게 없어서 자동 선택에서 제외됩니다. 채우거나 지우세요.`) : null,
    el('span', { class: 'grow' }),
    el('span', { class: 'meta' }, '프레이밍은 샷 길이에 반영됩니다 — 와이드는 길게, 타이트는 짧게')));
}

// ── 04 Assign: which shots cover whom ───────────────────────
// Rows are subjects, columns are cameras. A hole in the grid is a person no
// camera can cover, which is the reason to show it this way rather than as a
// per-shot list. Cells PICK from the library; they never create shots.
function paneAssign(body) {
  const cfg = state.config;
  const cams = cameraColumns();
  const rows = subjectRows();
  const known = new Set(rows.map(r => r.subject));
  // A shot pointing at a deleted role/team keeps its own row rather than
  // vanishing — otherwise a rename would silently orphan it.
  const orphans = [...new Set((cfg.macros || [])
    .flatMap(m => m.subjects || []).filter(s => !known.has(s)))];

  if (!cams.length) {
    body.append(el('div', { class: 'hint' }, '카메라가 없습니다. 우측 상단 “+ 카메라”로 먼저 추가하세요.'));
    return;
  }
  if (!(cfg.macros || []).length) {
    body.append(el('div', { class: 'hint' }, '샷이 없습니다. Shots에서 먼저 만들면 여기서 배정할 수 있습니다.'));
    return;
  }

  const byCell = {};
  (cfg.macros || []).forEach(m => {
    const cam = m.camera == null ? '' : String(m.camera);
    (m.subjects || []).forEach(s => { (byCell[`${s}|${cam}`] = byCell[`${s}|${cam}`] || []).push(m); });
  });

  const grid = el('div', { class: 'shotmap', style: `grid-template-columns:200px repeat(${cams.length},minmax(128px,1fr))` });
  grid.append(el('div', { class: 'sm-corner' }, '대상 \\ 카메라'));
  cams.forEach(c => {
    const used = (cfg.macros || []).filter(m => String(m.camera ?? '') === String(c)).length;
    grid.append(el('div', { class: 'sm-camhd', style: `--cam:${camColor(c)}` },
      el('span', { class: 'grow' }, camLabel(c)),
      el('span', { class: 'sm-camn' }, used ? `${used}샷` : '샷 없음'),
      el('button', {
        class: 'sm-camx', title: used ? '이 카메라를 쓰는 샷이 있어 삭제할 수 없습니다' : '카메라 삭제',
        onclick: () => {
          if (used) { alert(`이 카메라를 쓰는 샷이 ${used}개 있습니다. 먼저 Shots에서 옮기거나 삭제하세요.`); return; }
          if (confirm(`${camLabel(c)} 삭제?`)) putCameras(cams.filter(x => x !== c));
        },
      }, '×')));
  });

  const addRow = (row) => {
    const { subject, indent, kind } = row;
    const n = cams.reduce((acc, c) => acc + (byCell[`${subject}|${c}`] || []).length, 0);
    const dangling = !subjectExists(subject);
    // Only a ROLE with no shot is a real gap — that person cannot be cut to at
    // all. A team without one just means nobody wanted a whole-team framing.
    const missing = n === 0 && kind === 'role';
    // Row order is the rotation's seed order, so it is worth arranging — hence
    // the arrows on anything that has siblings to move among.
    const name = splitSubject(subject).name;
    let move = null;
    if (kind === 'role' && subjectExists(subject)) {
      const grp = cfg.roles[name]?.group;
      const sibs = Object.entries(cfg.roles || {})
        .filter(([, r]) => r.group === grp).map(([n]) => n);
      if (sibs.length > 1) move = [sibs, name, (nx) => {
        // Send the full role list with this team's block reordered in place.
        const all = Object.keys(cfg.roles || {});
        let k = 0;
        reorderRoles(all.map(n => (sibs.includes(n) ? nx[k++] : n)));
      }];
    } else if (kind === 'team' && subjectExists(subject)) {
      const all = Object.keys(cfg.groups || {});
      if (all.length > 1) move = [all, name, reorderGroups];
    }
    grid.append(el('div', {
      class: 'sm-sub' + (kind === 'wide' ? ' wide' : '') + (indent ? ' in' : '') + (missing ? ' miss' : ''),
      style: `--sc:${subjectColor(subject)}`,
    },
      move ? el('span', { class: 'sm-move' },
        el('button', { title: '위로', disabled: move[0].indexOf(move[1]) === 0 ? '' : null,
          onclick: () => moveName(move[0], move[1], -1, move[2]) }, '▲'),
        el('button', { title: '아래로', disabled: move[0].indexOf(move[1]) === move[0].length - 1 ? '' : null,
          onclick: () => moveName(move[0], move[1], 1, move[2]) }, '▼')) : el('span', { class: 'sm-move ph' }),
      el('span', { class: 'sm-dot' }),
      el('span', { class: 'sm-subname' }, subjectLabel(subject)),
      el('span', { class: 'sm-subkind' },
        dangling ? '삭제된 대상' : missing ? '샷 없음'
          : kind === 'wide' ? '여러 명 / 정적일 때' : kind === 'team' ? '팀 전체' : '')));
    cams.forEach(c => {
      const cell = el('div', { class: 'sm-cell' });
      (byCell[`${subject}|${c}`] || []).forEach(m => cell.append(assignedChip(m, subject)));
      cell.append(assignPicker(subject, c));
      grid.append(cell);
    });
  };

  rows.forEach(addRow);
  orphans.forEach(s => addRow({ subject: s, indent: 0, kind: splitSubject(s).kind }));
  body.append(grid);

  const holes = rows.filter(r => r.kind === 'role'
    && cams.every(c => !(byCell[`${r.subject}|${c}`] || []).length)).length;
  const unassigned = (cfg.macros || []).filter(m => !(m.subjects || []).length).length;
  body.append(el('div', { class: 'sm-foot' },
    holes ? el('span', { class: 'sm-warn' }, `⚠ 잡을 샷이 없는 역할 ${holes}개 — 이 사람만 소리 나면 전체 뷰로 넘어갑니다.`) : null,
    unassigned ? el('span', { class: 'meta' }, `미배정 샷 ${unassigned}개 (수동 샷·장면 목록에서는 계속 쓸 수 있습니다)`) : null,
    el('span', { class: 'grow' }),
    el('span', { class: 'meta' }, '▲▼ 로 순서 변경 — 이 순서가 로테이션 시작 순서입니다')));
}

function assignedChip(m, subject) {
  return el('div', { class: 'sm-shot', style: `--cam:${camColor(m.camera)}`, title: m.token || '' },
    el('span', { class: 'sm-tokname' }, m.name || m.token || m.id),
    el('span', { class: 'sm-size ro' }, SIZE_LABEL[m.size] || 'T'),
    el('button', {
      class: 'sm-x', title: '이 대상에서 배정 해제 (샷은 남습니다)',
      onclick: () => updateMacro(m.id, { subjects: (m.subjects || []).filter(s => s !== subject) }).then(refreshSetup),
    }, '×'));
}

// A picker, not a creator: assignment can only ever reference the library.
function assignPicker(subject, cam) {
  const pool = (state.config.macros || []).filter(m =>
    String(m.camera ?? '') === String(cam) && !(m.subjects || []).includes(subject));
  const sel = el('select', {
    class: 'sm-add-sel', disabled: pool.length ? null : '',
    onchange: (e) => {
      const m = (state.config.macros || []).find(x => x.id === e.target.value);
      if (!m) return;
      updateMacro(m.id, { subjects: [...(m.subjects || []), subject] }).then(refreshSetup);
    },
  }, el('option', { value: '' }, pool.length ? '+ 샷 배정' : '— 이 카메라에 남은 샷 없음'),
     ...pool.map(m => el('option', { value: m.id }, m.name || m.token || m.id)));
  sel.value = '';
  return sel;
}

function paneScenes(body) {
  const cfg = state.config;
  body.append(el('div', { class: 'rules-note' },
    '장면은 “언제”만 정합니다 — 그 안에서 무엇을 비출지는 매 순간 소리로 다시 고릅니다. ',
    '위가 우선순위이고, 아무 장면도 안 맞으면 맨 아래 기본 장면이 씁니다.'));

  // Live activity, right where conditions are written — otherwise you are
  // guessing which teams are up while deciding what should trigger on them.
  const strip = el('div', { class: 'livestrip', id: 'scene-livestrip' },
    el('span', { class: 'lbl-sm' }, '지금 활성'),
    el('div', { class: 'ls-row', id: 'ls-teams' }),
    el('div', { class: 'ls-row', id: 'ls-roles' }));
  body.append(strip);

  const list = el('div', { class: 'rules-list' });
  // Show them in the order the ENGINE walks them (priority desc), not storage
  // order — otherwise "위가 우선순위" is a lie whenever the two have drifted,
  // and the operator reads the wrong scene as the winner.
  const rules = (cfg.rules || []).slice().sort((a, b) => (b.priority || 0) - (a.priority || 0));
  const activeId = state.lastTick?.engine?.active_rule_id;
  rules.forEach((r, i) => {
    list.append(el('div', { class: 'rule-card' + (r.id === activeId ? ' matched' : ''), 'data-rule': r.id },
      el('div', { class: 'rule-move' },
        el('button', { onclick: () => moveRule(rules, i, -1), disabled: i === 0 ? '' : null }, '▲'),
        el('button', { onclick: () => moveRule(rules, i, 1), disabled: i === rules.length - 1 ? '' : null }, '▼')),
      el('span', { class: 'rule-rank' }, i + 1),
      el('div', {}, el('div', { class: 'rule-name' }, r.name || '—'),
        el('div', { class: 'rule-cd' }, profileSummary(r.profile))),
      el('div', { class: 'rule-conds' }, (r.conditions || []).length ? condPills(r.conditions) : el('span', { class: 'meta' }, '(항상 매칭)')),
      el('div', { style: 'display:flex;justify-content:flex-end' },
        el('span', { class: 'rule-trans' }, profileSummary(r.profile))),
      el('div', { class: 'rule-acts' },
        el('button', { class: 'mini-btn', onclick: () => { state.editRuleId = r.id; renderModal(); } }, 'edit'),
        el('button', { class: 'mini-btn danger', onclick: () => { if (confirm(`장면 "${r.name}" 삭제?`)) deleteRuleApi(r.id); } }, '×'))));
  });
  if (!rules.length) list.append(el('span', { class: 'hint' }, '아직 장면이 없습니다. 기본 장면만으로도 동작합니다.'));
  body.append(list);

  // Default scene — the fallback when nothing matches, and what DYNAMIC mode
  // runs on its own. Same knobs as any scene, so there is one thing to learn.
  const dp = cfg.runtime?.profile || {};
  body.append(el('div', { class: 'defscene' },
    el('div', { class: 'team-hd' },
      el('span', { class: 'rule-name' }, '기본 장면'),
      el('span', { class: 'meta' }, '매칭되는 장면이 없을 때 · DYNAMIC 모드'),
      el('span', { class: 'grow' }),
      el('span', { class: 'rule-trans' }, profileSummary(dp))),
    profileEditor(dp, (patch) => patchDefaultProfile(patch), { forced: false })));
}

function renderSetupScenes(msg) {
  const strip = $('scene-livestrip');
  if (!strip) return;
  const cfg = state.config || {};
  const live = liveStates(msg);

  const paint = (host, names, colorOf, defs) => {
    if (!host) return;
    // Rebuild only when the roster changes; otherwise just re-flag, so the
    // dots don't visibly churn 20× a second.
    const sig = names.join(',');
    if (host.dataset.sig !== sig) {
      host.dataset.sig = sig;
      host.innerHTML = '';
      names.forEach(n => host.append(el('span', { class: 'ls-pill', 'data-n': n, style: `--pc:${colorOf(n)}` },
        el('span', { class: 'ls-dot' }), n)));
    }
    host.querySelectorAll('.ls-pill').forEach(p => {
      const on = !!live[p.dataset.n];
      p.classList.toggle('on', on);
      const st = (defs === 'role' ? msg.roles : msg.groups)?.[p.dataset.n];
      p.title = st?.peak_db != null ? `${st.peak_db} dB` : '';
    });
  };
  paint($('ls-teams'), Object.keys(cfg.groups || {}), groupColor, 'team');
  paint($('ls-roles'), Object.keys(cfg.roles || {}), (n) => cfg.roles?.[n]?.color || '#5b9bff', 'role');

  markCondPills(strip.parentElement, live);
  // Follow the scene the engine is actually in, live.
  const activeId = msg.engine?.active_rule_id;
  strip.parentElement.querySelectorAll('.rule-card[data-rule]').forEach(c => {
    c.classList.toggle('matched', c.dataset.rule === activeId);
  });
}

function profileSummary(p) {
  const who = (p || {}).who || [];
  const cams = (p || {}).cameras || [];
  const parts = [who.length ? who.map(subjectLabel).join(' · ') : '대상 전체'];
  if (cams.length) parts.push(cams.map(c => 'CAM' + c).join('/'));
  parts.push(`유지 ${((p || {}).hold_s ?? 3).toFixed(1)}s`);
  return parts.join('  ·  ');
}

// The only per-scene setting: which subjects it may cut to. Everything about
// HOW to shoot is one algorithm shared by every scene, so there is nothing
// else here to get out of sync between services.
function profileEditor(p, onPatch) {
  const cfg = state.config;
  const who = new Set((p || {}).who || []);
  const picked = new Set((p || {}).cameras || []);
  const shots = (cfg.macros || []).filter(m => (m.token || '').trim());
  const covered = new Set(shots.flatMap(m => m.subjects || []));
  // Coverage is judged against the cameras this scene may actually use, so a
  // subject only reachable from an excluded camera reads as uncovered HERE —
  // which is exactly what it is, and the pair of settings stays honest.
  const inScene = picked.size
    ? shots.filter(m => picked.has(m.camera == null ? '' : String(m.camera)))
    : shots;
  const reachable = new Set(inScene.flatMap(m => m.subjects || []));

  const set = (next) => onPatch({ who: [...next] });

  // ── Cameras: one list for the whole scene ──
  const camRow = el('div', { class: 'who-row' },
    (cfg.cameras || []).map(c => el('button', {
      class: 'who-cam big' + (picked.size === 0 || picked.has(c) ? ' on' : '')
        + (picked.size === 0 ? ' all' : ''),
      style: `--cam:${camColor(c)}`,
      title: picked.size === 0 ? '전체 사용 중 — 누르면 이 카메라만' : camLabel(c),
      onclick: () => {
        const n = new Set(picked);
        // The first pick narrows from "all" to just that camera; after that it
        // is a plain toggle. Emptying it means "no limit" rather than "none",
        // so a scene can never be clicked into having no cameras at all.
        if (picked.size === 0) onPatch({ cameras: [c] });
        else { n.has(c) ? n.delete(c) : n.add(c); onPatch({ cameras: [...n] }); }
      },
    }, camLabel(c))),
    picked.size ? el('button', { class: 'who-cam big clr',
      onclick: () => onPatch({ cameras: [] }) }, '전체') : null);

  const pill = (s) => {
    const on = who.has(s);
    const has = reachable.has(s);
    const elsewhere = !has && covered.has(s);   // has a shot, but not on these cameras
    return el('button', {
      class: 'cyc' + (on ? ' on' : '') + (has ? '' : ' nocov'),
      title: has ? '' : elsewhere
        ? '이 장면이 쓰는 카메라에는 이 대상의 샷이 없습니다'
        : '이 대상을 잡을 샷이 없습니다 — Assign에서 배정하세요',
      onclick: () => { const n = new Set(who); n.has(s) ? n.delete(s) : n.add(s); set(n); },
    }, subjectLabelQualified(s),
       has ? null : el('span', { class: 'cyc-tag' }, elsewhere ? '이 캠엔 없음' : '샷 없음'));
  };
  const band = (title, subjects, note) => subjects.length ? el('div', { class: 'who-band' },
    el('div', { class: 'who-band-hd' }, el('span', {}, title),
      note ? el('span', { class: 'hint' }, note) : null),
    el('div', { class: 'who-row' }, subjects.map(pill))) : null;

  // Grouped by team so the list reads like the room does, instead of one flat
  // wall where a team and its members sit unrelated next to each other.
  const bands = [band('전체', [WIDE], '아무도 안 할 때 · 여러 명일 때')];
  Object.keys(cfg.groups || {}).forEach(g => {
    const members = Object.entries(cfg.roles || {})
      .filter(([, r]) => r.group === g).map(([n]) => `role:${n}`);
    bands.push(band(g, [`team:${g}`, ...members]));
  });
  const orphanRoles = Object.entries(cfg.roles || {})
    .filter(([, r]) => !r.group || !cfg.groups?.[r.group]).map(([n]) => `role:${n}`);
  bands.push(band('팀 없음', orphanRoles));
  // Subjects that only exist because some shot still points at them — a role
  // rename leaves these behind, and they are invisible anywhere else.
  const known = new Set([WIDE, ...Object.keys(cfg.groups || {}).map(g => `team:${g}`),
    ...Object.keys(cfg.roles || {}).map(r => `role:${r}`)]);
  bands.push(band('삭제된 대상', [...covered].filter(s => !known.has(s)),
    '샷은 아직 이 이름을 가리키지만 역할/팀이 없습니다'));

  const holdI = el('input', { class: 'inp mono', type: 'number', step: '0.5', min: '0', max: '60',
    style: 'width:90px',
    onchange: (e) => onPatch({ hold_s: Math.max(0, parseFloat(e.target.value) || 0) }) });
  holdI.value = (p || {}).hold_s ?? 3;

  return el('div', { class: 'prof' },
    el('div', { class: 'field' },
      el('div', { style: 'display:flex;align-items:baseline;gap:10px;flex-wrap:wrap' },
        el('span', { class: 'lbl-sm' }, 'HOLD — 이 장면 최소 유지 (초)'),
        el('span', { class: 'hint' },
          '한 번 이 장면이 되면 이 시간은 유지 — 더 높은 우선순위 룰이 맞아도 기다립니다')),
      holdI),
    el('div', { class: 'field' },
      el('div', { style: 'display:flex;align-items:baseline;gap:10px;flex-wrap:wrap' },
        el('span', { class: 'lbl-sm' }, 'CAMERAS — 이 장면에서 쓸 카메라'),
        el('span', { class: 'hint' }, picked.size
          ? '고른 카메라만 사용합니다' : '안 고르면 전부 사용')),
      camRow),
    el('div', { class: 'field' },
      el('div', { style: 'display:flex;align-items:baseline;gap:10px;flex-wrap:wrap' },
        el('span', { class: 'lbl-sm' }, 'WHO — 이 장면에서 잡을 대상'),
        el('span', { class: 'hint' }, who.size
          ? '고른 대상만 순회합니다' : '비우면 배정된 대상 전부'),
        el('span', { class: 'grow' }),
        el('button', { class: 'mini-btn', onclick: () => set(new Set(reachable)) }, '샷 있는 대상 전체'),
        el('button', { class: 'mini-btn', onclick: () => set(new Set()) }, '비우기')),
      el('div', { class: 'who-bands' }, bands)));
}

// priorities from the order it receives, which re-syncs storage with display.
function moveRule(rules, i, dir) {
  const j = i + dir; if (j < 0 || j >= rules.length) return;
  const ids = rules.map(r => r.id); [ids[i], ids[j]] = [ids[j], ids[i]]; reorderRules(ids);
}

function paneConn(body) {
  const cfg = state.config;
  const url = cfg.connections?.ass_http?.url || '';
  const urlI = el('input', { class: 'inp mono', type: 'text', onchange: (e) => patchAss(e.target.value.trim()) }); urlI.value = url;
  body.append(el('div', { class: 'conn-box' },
    el('div', { class: 'conn-title' }, 'ASS HTTP server'),
    el('div', { class: 'conn-sub' }, '모든 룰 액션이 매크로 토큰을 이 주소로 POST합니다.'),
    el('div', { class: 'conn-row' }, urlI, el('span', { class: 'conn-method' }, 'POST'))));
  body.append(el('div', { class: 'lbl-sm', style: 'margin-top:14px' }, 'SCENES USING IT'));
  const cards = el('div', { class: 'trans-cards' });
  (cfg.rules || []).forEach(r => cards.append(el('div', { class: 'trans-card' },
    el('div', { style: 'font-size:13px;font-weight:500' }, r.name || '—'),
    el('div', { class: 'meta', style: 'margin-top:3px' }, profileSummary(r.profile)))));
  body.append(cards);
}

// ── Rule edit modal ────────────────────────────────────────
function renderModal() {
  const root = $('modal-root'); root.innerHTML = '';
  const id = state.editRuleId; if (!id) return;
  const cfg = state.config;
  const rule = (cfg.rules || []).find(r => r.id === id);
  if (!rule) { state.editRuleId = null; return; }
  const condMap = {}; (rule.conditions || []).forEach(c => condMap[c.group] = c.state);
  const cycle = (name) => {
    const cur = condMap[name] || 'any';
    const next = cur === 'any' ? 'active' : cur === 'active' ? 'inactive' : 'any';
    const conds = (rule.conditions || []).filter(c => c.group !== name);
    if (next !== 'any') conds.push({ group: name, state: next });
    updateRule(id, { conditions: conds }).then(renderModal);
  };
  const pill = (name, sm) => {
    const st = condMap[name] || 'any';
    return el('button', { class: 'cyc' + (sm ? ' sm' : '') + (st === 'active' ? ' on' : st === 'inactive' ? ' off' : ''), onclick: () => cycle(name) }, name);
  };
  const rank = cfg.rules.slice().sort((a, b) => (b.priority || 0) - (a.priority || 0)).findIndex(r => r.id === id) + 1;
  const nameI = el('input', { class: 'inp', type: 'text', onchange: (e) => updateRule(id, { name: e.target.value }) }); nameI.value = rule.name || '';

  const teams = Object.keys(cfg.groups || {});
  const roles = Object.keys(cfg.roles || {});
  const preview = el('div', { class: 'scene-prev' }, el('span', { class: 'hint' }, '미리보기 불러오는 중…'));
  loadScenePreview(id, preview);

  root.append(el('div', { class: 'modal-bg', onclick: () => { state.editRuleId = null; renderModal(); } },
    el('div', { class: 'modal wide', onclick: (e) => e.stopPropagation() },
      el('div', { class: 'modal-hd' }, el('span', { class: 'lbl' }, 'EDIT SCENE'), el('span', { class: 'meta' }, 'priority #' + rank),
        el('span', { class: 'grow' }), el('button', { class: 'modal-x', onclick: () => { state.editRuleId = null; renderModal(); } }, '×')),
      el('div', { class: 'modal-body' },
        el('label', { class: 'field' }, el('span', { class: 'lbl-sm' }, 'SCENE NAME'), nameI),
        el('div', { style: 'display:flex;flex-direction:column;gap:9px' },
          el('div', { style: 'display:flex;align-items:baseline;gap:10px' }, el('span', { class: 'lbl-sm' }, 'WHEN — TEAMS'), el('span', { class: 'hint' }, '클릭으로 순환: any → on → off')),
          el('div', { class: 'pill-row' }, teams.map(t => pill(t))),
          teams.length ? null : el('span', { class: 'hint' }, '팀이 없습니다.'),
          el('div', { style: 'display:flex;align-items:baseline;gap:10px;margin-top:4px' }, el('span', { class: 'lbl-sm' }, 'WHEN — ROLES'), el('span', { class: 'hint' }, '팀보다 세밀 (예: instruments 안의 Drum)')),
          el('div', { class: 'pill-row' }, roles.map(r => pill(r, true)))),
        el('div', { class: 'hair' }),
        profileEditor(rule.profile, (patch) => updateProfile(id, patch).then(renderModal)),
        el('div', { class: 'hair' }),
        el('div', { style: 'display:flex;align-items:baseline;gap:10px' },
          el('span', { class: 'lbl-sm' }, '지금 열면 이렇게 갑니다'),
          el('span', { class: 'hint' }, '현재 들어오는 소리 기준 — 실제로는 소리 따라 달라집니다')),
        preview),
      el('div', { class: 'modal-ft' },
        el('button', { class: 'mini-btn danger', onclick: () => { if (confirm('장면 삭제?')) { deleteRuleApi(id); state.editRuleId = null; renderModal(); } } }, 'Delete scene'),
        el('span', { class: 'grow' }),
        el('button', { class: 'mini-btn', onclick: () => { state.editRuleId = null; renderModal(); } }, 'Done')))));
}

async function loadScenePreview(ruleId, host) {
  let res;
  try { res = await api('GET', `/api/scenes/${encodeURIComponent(ruleId)}/preview?n=6`); }
  catch { host.innerHTML = ''; host.append(el('span', { class: 'hint' }, '미리보기를 불러오지 못했습니다.')); return; }
  host.innerHTML = '';
  const seq = res?.sequence || [];
  const strip = el('div', { class: 'scene-prev-strip' });
  if (!seq.length) strip.append(el('span', { class: 'hint' }, '지금 들어오는 소리로는 잡을 샷이 없습니다.'));
  seq.forEach(s => strip.append(el('span', { class: 'prev-chip', style: `--cam:${camColor(s.camera)}` },
    el('span', { class: 'prev-cam' }, camLabel(s.camera)),
    el('span', {}, s.name || s.macro_id),
    el('span', { class: 'prev-sub' }, s.subject ? subjectLabel(s.subject) : subjectsLabel(s.subjects)))));
  host.append(strip);

  // The preview only contains subjects that are making sound RIGHT NOW, so a
  // camera can be missing purely because its subject happens to be quiet.
  // Saying which subjects are waiting turns "why is CAM 1 missing?" into an
  // answer instead of a puzzle.
  const rule = (state.config.rules || []).find(r => r.id === ruleId);
  const who = new Set((rule?.profile?.who) || []);
  const live = new Set((state.lastTick?.engine?.director?.active_subjects) || []);
  const idle = (state.config.macros || [])
    .filter(m => (m.token || '').trim())
    .flatMap(m => m.subjects || [])
    .filter(s => (!who.size || who.has(s)) && s !== WIDE && !live.has(s));
  const uniq = [...new Set(idle)];
  if (uniq.length) {
    host.append(el('div', { class: 'prev-idle' },
      el('span', { class: 'prev-idle-lbl' }, '지금 조용해서 빠진 대상'),
      ...uniq.map(s => el('span', { class: 'prev-idle-chip' }, subjectLabel(s))),
      el('span', { class: 'hint' }, '— 소리가 나면 순번에 들어옵니다')));
  }
}

// ── Project menu ───────────────────────────────────────────
function toggleProjectMenu() {
  const menu = $('project-menu');
  if (!menu.classList.contains('hidden')) { menu.classList.add('hidden'); return; }
  buildProjectMenu(menu);
  menu.classList.remove('hidden');
}
async function buildProjectMenu(menu) {
  menu.innerHTML = '';
  menu.append(el('div', { class: 'pm-hd' }, 'PROJECTS'));
  let info; try { info = await api('GET', '/api/projects'); } catch { return; }
  (info.projects || []).forEach(p => {
    const active = p.name === info.current;
    menu.append(el('div', { class: 'pm-item' + (active ? ' active' : ''), onclick: async (e) => { e.stopPropagation(); if (!active) { await api('POST', `/api/projects/${encodeURIComponent(p.name)}/activate`); await rebuildAll(); } menu.classList.add('hidden'); } },
      el('span', {}, active ? '● ' : '○ ', p.name),
      el('span', { class: 'grow' }), el('span', { class: 'meta' }, `${p.channel_count || 0}ch · ${p.rule_count || 0} rules`)));
  });
}
async function rebuildAll() {
  await loadConfig();
  renderHeaderStatic();
  state.chanSig = ''; state.controlsSig = '';
  buildChannelsGrid(); buildLiveControls(); refreshSetup();
  if (state.lastTick) renderLiveTick(state.lastTick);
}

boot();

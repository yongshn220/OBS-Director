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
const setOverride = (tid) => api('POST', '/api/override', { transition_id: tid });
const setShot = (mid) => api('POST', '/api/override/shot', { macro_id: mid });
async function patchChannel(id, body) { state.config = await api('PATCH', `/api/channels/${id}`, body); refreshSetup(); }
async function upsertGroup(name, body) { await api('PUT', `/api/groups/${encodeURIComponent(name)}`, body); await loadConfig(); refreshSetup(); }
async function deleteGroup(name) { await api('DELETE', `/api/groups/${encodeURIComponent(name)}`); await loadConfig(); refreshSetup(); }
async function upsertRole(name, body) { await api('PUT', `/api/roles/${encodeURIComponent(name)}`, body); await loadConfig(); refreshSetup(); }
async function deleteRole(name) { await api('DELETE', `/api/roles/${encodeURIComponent(name)}`); await loadConfig(); refreshSetup(); }
async function createMacro() { await api('POST', '/api/macros', { name: '', token: '', camera: '' }); await loadConfig(); refreshSetup(); }
async function updateMacro(id, patch) { await api('PUT', `/api/macros/${encodeURIComponent(id)}`, patch); await loadConfig(); }
async function deleteMacro(id) { await api('DELETE', `/api/macros/${encodeURIComponent(id)}`); await loadConfig(); refreshSetup(); }
async function updateRule(id, body) { await api('PUT', `/api/rules/${id}`, body); await loadConfig(); refreshSetup(); }
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
}

// ── Header ─────────────────────────────────────────────────
function bindHeader() {
  $('tg-live').onclick = () => { state.screen = 'live'; applyScreen(); };
  $('tg-setup').onclick = () => { state.screen = 'setup'; applyScreen(); };
  $('tg-auto').onclick = () => { if (rt().auto !== true) patchRuntime({ auto: true }); };
  $('tg-manual').onclick = () => { if (rt().auto !== false) patchRuntime({ auto: false }); };
  $('tg-rules').onclick = () => { if (rt().director_mode !== 'rules') patchRuntime({ director_mode: 'rules' }); };
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
    el('span', { class: 'lbl' }, 'PIN TRANSITION'),
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
      el('span', { class: 'meta' }, 'deck에서 뽑음 · 카메라 연속 안 함')),
    el('div', { id: 'live-next', class: 'nextcuts' }),
  );

  // 3) MATCHED RULE
  const cRule = el('div', { class: 'card' },
    el('div', { class: 'card-hd' }, el('span', { class: 'lbl' }, 'MATCHED RULE'), el('span', { class: 'grow' }),
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

  root.append(cShot, cAir, cRule, cChan, cListen);
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
  const trans = state.config?.transitions || [];
  const sig = 'M:' + macros.map(m => m.id + m.name + m.camera).join(',') + '|T:' + trans.map(t => t.id + t.name).join(',');
  if (sig === state.controlsSig) return;
  state.controlsSig = sig;

  // shot palette by camera
  const shots = $('live-shots');
  shots.innerHTML = '';
  const byCam = {};
  macros.forEach(m => { const c = (m.camera == null || m.camera === '') ? '' : String(m.camera); (byCam[c] = byCam[c] || []).push(m); });
  if (!macros.length) shots.append(el('span', { class: 'hint' }, 'SETUP → Macros에서 매크로를 먼저 만드세요.'));
  Object.keys(byCam).sort().forEach(c => {
    const color = camColor(c);
    const row = el('div', { class: 'shot-row' },
      el('span', { class: 'shot-cam', style: `color:${color}` }, camLabel(c)),
      el('div', { class: 'shot-btns' },
        byCam[c].map(m => el('button', { class: 'shot', 'data-mid': m.id, style: `border-left-color:${color}`,
          onclick: () => { const cur = state.lastTick?.engine?.override_macro_id; setShot(cur === m.id ? null : m.id); } },
          m.name || m.token || m.id))));
    shots.append(row);
  });

  // pin transitions
  const pins = $('live-pins');
  pins.innerHTML = '';
  pins.append(el('button', { class: 'pin', 'data-tid': '__auto__', onclick: () => setOverride(null) }, 'Auto (rules)'));
  trans.forEach(t => pins.append(el('button', { class: 'pin', 'data-tid': t.id, onclick: () => setOverride(t.id) }, t.name || '(이름 없음)')));
}

function renderLiveTick(msg) {
  if (!state.liveShell) return;
  buildLiveControls();
  buildChannelsGrid();
  const eng = msg.engine || {};
  const d = eng.director || {};
  const dry = (msg.runtime || {}).dry_run !== false;
  const heldShot = eng.override_macro_id || null;
  const pinTrans = eng.override_transition_id || null;
  const cur = d.current || null;

  // control on-states
  document.querySelectorAll('#live-shots .shot').forEach(b => b.classList.toggle('on', b.dataset.mid === heldShot));
  document.querySelectorAll('#live-pins .pin').forEach(b => {
    b.classList.toggle('on', b.dataset.tid === '__auto__' ? (!pinTrans && !heldShot) : b.dataset.tid === pinTrans);
  });

  // ON AIR
  const badge = $('air-badge'), col = camColor(cur?.camera);
  $('air-badge-l').style.color = col; $('air-badge-n').style.color = col; badge.style.borderColor = cur ? col : 'var(--bd-strong)';
  badge.style.background = cur ? 'rgba(255,255,255,0.03)' : 'transparent';
  $('air-badge-n').textContent = cur?.camera ?? '—';
  $('air-name').textContent = cur?.name || (d.mode === 'dynamic' ? '대기 (소리 없음)' : '대기 중');
  const sub = $('air-sub'); sub.innerHTML = '';
  if (cur) {
    if (cur.group) sub.append(el('span', { class: 'chip' }, cur.group));
    const src = (d.active_sources && d.active_sources.length) ? d.active_sources.join(' · ') : (d.transition_name || '');
    if (src) sub.append(el('span', {}, d.mode === 'dynamic' ? ('활성: ' + src) : src));
  }
  const tally = $('air-tally');
  tally.textContent = dry ? 'DRY' : 'LIVE';
  tally.style.color = dry ? 'var(--dry-tx)' : 'var(--live-tx)';
  tally.style.borderColor = dry ? 'var(--dry)' : 'var(--live)';
  // meta line
  const flags = [];
  if (d.transition_name) flags.push(d.transition_name);
  if (d.interval) flags.push(d.interval.toFixed(1) + 's');
  $('air-meta').textContent = flags.join(' · ');
  // countdown
  const interval = (!heldShot && cur) ? (d.interval || 0) : 0;
  const nextIn = (!heldShot && cur && d.next_in != null) ? d.next_in : null;
  $('air-count').textContent = heldShot ? '고정' : (nextIn != null ? nextIn.toFixed(1) + 's' : (cur ? (interval ? '' : '정지') : '—'));
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
      el('div', { class: 'nc-at' }, at)));
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
      el('div', { style: 'display:flex;align-items:center;gap:9px;margin-top:11px' },
        el('span', { class: 'lbl-sm' }, 'LOCKED'),
        (() => { const cd = ruleCfg.cooldown_s || 0, rem = eng.active_cooldown_remaining;
          const w = (cd > 0 && rem != null) ? Math.max(0, Math.min(100, (1 - rem / cd) * 100)) : 100;
          return el('span', { class: 'grow', style: 'height:3px;border-radius:2px;background:var(--bd-hair);overflow:hidden;display:block' },
            el('span', { style: `display:block;height:100%;width:${w}%;background:var(--mut3)` })); })(),
        el('span', { class: 'meta', style: 'color:#a8b1bd' }, (eng.active_cooldown_remaining != null ? eng.active_cooldown_remaining.toFixed(1) : '0.0') + 's')),
    );
  } else {
    const modeName = eng.override_macro_id ? '수동 샷' : eng.override_transition_id ? '수동 고정' : (eng.director_mode === 'dynamic' ? '자동 플래닝 (동적)' : '대기 중');
    body.append(el('div', { style: 'display:flex;align-items:center;gap:9px;margin-bottom:8px' }, el('span', { class: 'mr-name' }, modeName)));
    const d = eng.director || {};
    if (eng.director_mode === 'dynamic' && d.active_sources?.length)
      body.append(el('div', { class: 'pill-row' }, d.active_sources.map(s => el('span', { class: 'cond on' }, s))));
  }

  (eng.matching || []).filter(m => m.id !== activeId).slice(0, 3).forEach((m, i) => {
    const rank = rules.slice().sort((a, b) => (b.priority || 0) - (a.priority || 0)).findIndex(r => r.id === m.id) + 1;
    queue.append(el('div', { class: 'also' },
      el('span', { class: 'meta', style: 'width:26px' }, '#' + (rank || '?')),
      el('span', {}, m.name), el('span', { class: 'grow' }),
      el('span', { class: 'meta' }, (m.preview || '').replace(/^transition:\s*/, ''))));
  });
  if (!(eng.matching || []).filter(m => m.id !== activeId).length)
    queue.append(el('span', { class: 'meta' }, '—'));
}
function condPills(conds) {
  return conds.map(c => {
    const on = c.state === 'active';
    return el('span', { class: 'cond ' + (on ? 'on' : 'off') }, c.group + ' ' + (on ? 'on' : 'off'));
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
  ['03', 'Macros', 'one macro = one shot'],
  ['04', 'Rules', 'order sets priority'],
  ['05', 'Transitions', 'decks the rules pick'],
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
  ['Teams & roles', '팀(그룹)은 룰이 매칭하는 단위, 역할은 팀 안의 사람/악기입니다.', '+ Add team', () => { const n = prompt('새 팀 이름'); if (n) upsertGroup(n.trim(), { attack_ms: 200, release_ms: 1500, color: SWATCHES[Math.floor(Math.random() * SWATCHES.length)] }); }],
  ['Macros', '매크로는 ASS에서 PTZ 프리셋 이동 + 장면 전환을 합니다. 매크로 1개 = 샷 1개.', '+ Add macro', () => createMacro()],
  ['Rules', '순서가 우선순위 — 위가 이깁니다. 룰을 열어 조건을 편집하세요.', '+ Add rule', () => addRuleApi()],
  ['Transitions', '룰이 고르는 매크로 덱과 회전 파라미터.', '+ Add transition', async () => { await api('POST', '/api/transitions', { name: '새 트랜지션', deck: [], interval_s: 8, camera_alternate: true }); await loadConfig(); refreshSetup(); }],
  ['Connection', '모든 룰 액션이 매크로 토큰을 보내는 곳.', null, null],
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
  ({ 0: paneChannels, 1: paneTeams, 2: paneMacros, 3: paneRules, 4: paneTransitions, 5: paneConn }[state.setupStep])(body);
}

function paneChannels(body) {
  const cfg = state.config;
  body.append(el('div', { class: 'chtbl-head' }, ...['CH', 'NAME', 'TEAM', 'ROLE', 'THRESHOLD', 'LIVE'].map(h => el('span', {}, h))));
  const groups = cfg.groups || {}, roles = cfg.roles || {};
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
    const thrLabel = el('span', { class: 'thr-val' }, (ch.threshold_db ?? -45) + ' dB');
    const thr = el('input', { type: 'range', min: '-78', max: '0', style: 'flex:1',
      oninput: (e) => { thrLabel.textContent = e.target.value + ' dB'; },
      onchange: (e) => patchChannel(ch.id, { threshold_db: +e.target.value }) });
    thr.value = ch.threshold_db ?? -45;
    const liveBar = el('span', { class: 'live-bar' }, el('span'));
    const liveDb = el('span', { class: 'live-db' }, '—');
    const row = el('div', { class: 'chtbl-row' + (has ? '' : ' unassigned') },
      el('span', { class: 'chtbl-ch' }, 'CH' + ch.id), nameI, gsel, rsel,
      el('div', { class: 'thr-cell' }, thr, thrLabel),
      el('div', { class: 'live-cell' }, liveBar, liveDb));
    row._live = { id: ch.id, bar: liveBar.firstChild, db: liveDb, thr: () => ch.threshold_db ?? -45, color: () => groupColor(ch.group), has };
    body.append(row);
  });
  // live update hook
  body._liveRows = [...body.querySelectorAll('.chtbl-row')];
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

function paneMacros(body) {
  const cfg = state.config;
  const roleNames = Object.keys(cfg.roles || {});
  const groupNames = Object.keys(cfg.groups || {});
  body.append(el('div', { class: 'mac-head' }, ...['NAME', 'TOKEN SENT TO ASS', 'CAM', 'SHOT GROUP', 'SOURCE (role/team)', ''].map(h => el('span', {}, h))));
  (cfg.macros || []).forEach(m => {
    const col = camColor(m.camera);
    const nameI = el('input', { class: 'inp', style: 'border-left:2px solid ' + col, type: 'text', onchange: (e) => updateMacro(m.id, { name: e.target.value }) }); nameI.value = m.name || '';
    const tokI = el('input', { class: 'inp mono', type: 'text', onchange: (e) => updateMacro(m.id, { token: e.target.value }) }); tokI.value = m.token || '';
    const camI = el('input', { class: 'inp mono', style: 'text-align:center', type: 'text', placeholder: '—', onchange: (e) => updateMacro(m.id, { camera: e.target.value }) }); camI.value = m.camera ?? '';
    const grpI = el('input', { class: 'inp mono', type: 'text', placeholder: 'subject', onchange: (e) => updateMacro(m.id, { group: e.target.value.trim() || null }) }); grpI.value = m.group || '';
    const cur = new Set(m.sources || []);
    const srcWrap = el('div', { class: 'mac-srcs' });
    [...roleNames.map(r => [r, 'role']), ...groupNames.map(g => [g, 'team'])].forEach(([key, kind]) => {
      const chip = el('button', { class: 'src-chip' + (cur.has(key) ? ' on' : ''), title: kind }, key);
      const color = kind === 'role' ? (cfg.roles[key]?.color || '#5b9bff') : groupColor(key);
      if (cur.has(key)) { chip.style.background = color; chip.style.borderColor = color; }
      if (kind === 'team') chip.style.borderStyle = 'dashed';
      chip.onclick = () => { const next = new Set(m.sources || []); next.has(key) ? next.delete(key) : next.add(key); m.sources = [...next]; updateMacro(m.id, { sources: m.sources }); const on = next.has(key); chip.classList.toggle('on', on); chip.style.background = on ? color : ''; chip.style.borderColor = on ? color : ''; };
      srcWrap.append(chip);
    });
    body.append(el('div', { class: 'mac-row' }, nameI, tokI, camI, grpI, srcWrap,
      el('button', { class: 'role-x', onclick: () => { if (confirm(`매크로 "${m.name || m.id}" 삭제?`)) deleteMacro(m.id); } }, '×')));
  });
}

function paneRules(body) {
  const cfg = state.config;
  body.append(el('div', { class: 'rules-note' }, '순서 = 우선순위. 화살표로 이동, 위가 이깁니다. 룰은 더 높은 룰이 매칭될 때까지 트랜지션을 유지합니다.'));
  const list = el('div', { class: 'rules-list' });
  const rules = cfg.rules || [];
  const activeId = state.lastTick?.engine?.active_rule_id;
  rules.forEach((r, i) => {
    const trans = transName(r);
    list.append(el('div', { class: 'rule-card' + (r.id === activeId ? ' matched' : '') },
      el('div', { class: 'rule-move' },
        el('button', { onclick: () => moveRule(i, -1), disabled: i === 0 ? '' : null }, '▲'),
        el('button', { onclick: () => moveRule(i, 1), disabled: i === rules.length - 1 ? '' : null }, '▼')),
      el('span', { class: 'rule-rank' }, i + 1),
      el('div', {}, el('div', { class: 'rule-name' }, r.name || '—'), el('div', { class: 'rule-cd' }, 'cooldown ' + (r.cooldown_s ?? 3).toFixed(1) + 's')),
      el('div', { class: 'rule-conds' }, (r.conditions || []).length ? condPills(r.conditions) : el('span', { class: 'meta' }, '(항상 매칭)')),
      el('div', { style: 'display:flex;justify-content:flex-end' }, el('span', { class: 'rule-trans' }, trans)),
      el('div', { class: 'rule-acts' },
        el('button', { class: 'mini-btn', onclick: () => { state.editRuleId = r.id; renderModal(); } }, 'edit'),
        el('button', { class: 'mini-btn danger', onclick: () => { if (confirm(`룰 "${r.name}" 삭제?`)) deleteRuleApi(r.id); } }, '×'))));
  });
  if (!rules.length) list.append(el('span', { class: 'hint' }, '아직 룰이 없습니다. + Add rule로 추가하세요.'));
  body.append(list);
}
function transName(rule) {
  const a = (rule.actions || []).find(x => x.type === 'transition' && x.transition_id);
  if (a) { const t = (state.config.transitions || []).find(t => t.id === a.transition_id); return t ? (t.name || '(이름 없음)') : '(삭제됨)'; }
  const h = (rule.actions || []).find(x => x.type === 'http_request');
  return h ? 'HTTP' : '—';
}
function moveRule(i, dir) {
  const rules = state.config.rules; const j = i + dir; if (j < 0 || j >= rules.length) return;
  const ids = rules.map(r => r.id); [ids[i], ids[j]] = [ids[j], ids[i]]; reorderRules(ids);
}

function paneTransitions(body) {
  const cfg = state.config;
  const macros = cfg.macros || [];
  const macroById = Object.fromEntries(macros.map(m => [m.id, m]));
  (cfg.transitions || []).forEach(t => {
    const nameI = el('input', { class: 'team-name', type: 'text', onchange: (e) => tUpdate(t.id, { name: e.target.value }) }); nameI.value = t.name || '';
    const deckWrap = el('div', { style: 'display:flex;flex-wrap:wrap;gap:5px' });
    (t.deck || []).forEach((mid, i) => {
      const m = macroById[mid];
      deckWrap.append(el('span', { class: 'role-pill', style: 'border-left:3px solid ' + camColor(m?.camera) },
        (i === 0 ? '★ ' : '') + (m ? (m.name || mid) : '(삭제됨)'),
        el('button', { class: 'role-x', onclick: () => tUpdate(t.id, { deck: t.deck.filter((_, k) => k !== i) }) }, '×')));
    });
    const addSel = el('select', { class: 'inp', style: 'max-width:220px', onchange: (e) => { if (e.target.value) { tUpdate(t.id, { deck: [...(t.deck || []), e.target.value] }); } } },
      el('option', { value: '' }, '+ 샷 추가'), ...macros.map(m => el('option', { value: m.id }, (m.name || m.id) + ' · cam' + (m.camera ?? '?'))));
    const intv = el('input', { class: 'inp mono', type: 'number', step: '0.5', min: '0', style: 'width:80px', onchange: (e) => tUpdate(t.id, { interval_s: parseFloat(e.target.value) || 0 }) }); intv.value = t.interval_s ?? 8;
    const camAlt = el('input', { type: 'checkbox', onchange: (e) => tUpdate(t.id, { camera_alternate: e.target.checked }) }); camAlt.checked = t.camera_alternate !== false;
    const grpAlt = el('input', { type: 'checkbox', onchange: (e) => tUpdate(t.id, { group_alternate: e.target.checked }) }); grpAlt.checked = !!t.group_alternate;
    body.append(el('div', { class: 'team-card', style: 'margin-bottom:14px' },
      el('div', { class: 'team-hd' }, nameI, el('span', { class: 'meta' }, (t.deck || []).length + '장'),
        el('button', { class: 'mini-btn danger', onclick: () => { if (confirm(`트랜지션 "${t.name}" 삭제?`)) tDelete(t.id); } }, 'delete')),
      el('div', { class: 'lbl-sm' }, 'DECK (첫 장 ★ = 진입 화면)'), deckWrap, addSel,
      el('div', { style: 'display:flex;gap:16px;align-items:center;flex-wrap:wrap;padding-top:8px;border-top:1px solid var(--bd-hair)' },
        el('label', { style: 'display:flex;align-items:center;gap:6px;font-size:12px;color:var(--mut)' }, '회전 간격', intv, '초'),
        el('label', { style: 'display:flex;align-items:center;gap:6px;font-size:12px;color:var(--mut)' }, camAlt, '카메라 교대'),
        el('label', { style: 'display:flex;align-items:center;gap:6px;font-size:12px;color:var(--mut)' }, grpAlt, '그룹 교대'))));
  });
  if (!(cfg.transitions || []).length) body.append(el('span', { class: 'hint' }, '아직 트랜지션이 없습니다.'));
}
async function tUpdate(id, patch) { await api('PUT', `/api/transitions/${id}`, patch); await loadConfig(); refreshSetup(); }
async function tDelete(id) { await api('DELETE', `/api/transitions/${id}`); await loadConfig(); refreshSetup(); }

function paneConn(body) {
  const cfg = state.config;
  const url = cfg.connections?.ass_http?.url || '';
  const urlI = el('input', { class: 'inp mono', type: 'text', onchange: (e) => patchAss(e.target.value.trim()) }); urlI.value = url;
  body.append(el('div', { class: 'conn-box' },
    el('div', { class: 'conn-title' }, 'ASS HTTP server'),
    el('div', { class: 'conn-sub' }, '모든 룰 액션이 매크로 토큰을 이 주소로 POST합니다.'),
    el('div', { class: 'conn-row' }, urlI, el('span', { class: 'conn-method' }, 'POST'))));
  body.append(el('div', { class: 'lbl-sm', style: 'margin-top:14px' }, 'TRANSITIONS USING IT'));
  const cards = el('div', { class: 'trans-cards' });
  (cfg.transitions || []).forEach(t => cards.append(el('div', { class: 'trans-card' },
    el('div', { style: 'font-size:13px;font-weight:500' }, t.name || '—'),
    el('div', { class: 'meta', style: 'margin-top:3px' }, `${(t.deck || []).length} shots · ${(t.interval_s ?? 8).toFixed(1)}s${t.camera_alternate !== false ? ' · alt' : ''}`))));
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
  const cdI = el('input', { class: 'inp mono', type: 'number', step: '0.5', min: '0', onchange: (e) => updateRule(id, { cooldown_s: parseFloat(e.target.value) || 0 }) }); cdI.value = rule.cooldown_s ?? 3;
  // transition select
  const curTid = ((rule.actions || []).find(a => a.type === 'transition') || {}).transition_id || '';
  const transSel = el('select', { class: 'inp', onchange: (e) => updateRule(id, { actions: [{ type: 'transition', transition_id: e.target.value }] }) },
    el('option', { value: '' }, '— 없음 —'), ...(cfg.transitions || []).map(t => el('option', { value: t.id }, t.name || t.id)));
  transSel.value = curTid;

  const teams = Object.keys(cfg.groups || {});
  const roles = Object.keys(cfg.roles || {});
  root.append(el('div', { class: 'modal-bg', onclick: () => { state.editRuleId = null; renderModal(); } },
    el('div', { class: 'modal', onclick: (e) => e.stopPropagation() },
      el('div', { class: 'modal-hd' }, el('span', { class: 'lbl' }, 'EDIT RULE'), el('span', { class: 'meta' }, 'priority #' + rank),
        el('span', { class: 'grow' }), el('button', { class: 'modal-x', onclick: () => { state.editRuleId = null; renderModal(); } }, '×')),
      el('div', { class: 'modal-body' },
        el('label', { class: 'field' }, el('span', { class: 'lbl-sm' }, 'RULE NAME'), nameI),
        el('div', { style: 'display:flex;flex-direction:column;gap:9px' },
          el('div', { style: 'display:flex;align-items:baseline;gap:10px' }, el('span', { class: 'lbl-sm' }, 'IF — TEAMS'), el('span', { class: 'hint' }, '클릭으로 순환: any → on → off')),
          el('div', { class: 'pill-row' }, teams.map(t => pill(t))),
          teams.length ? null : el('span', { class: 'hint' }, '팀이 없습니다.'),
          el('div', { style: 'display:flex;align-items:baseline;gap:10px;margin-top:4px' }, el('span', { class: 'lbl-sm' }, 'IF — ROLES'), el('span', { class: 'hint' }, '팀보다 세밀 (예: instruments 안의 Drum)')),
          el('div', { class: 'pill-row' }, roles.map(r => pill(r, true)))),
        el('div', { class: 'grid-2' },
          el('label', { class: 'field' }, el('span', { class: 'lbl-sm' }, 'THEN — TRANSITION'), transSel),
          el('label', { class: 'field' }, el('span', { class: 'lbl-sm' }, 'COOLDOWN (S)'), cdI))),
      el('div', { class: 'modal-ft' },
        el('button', { class: 'mini-btn danger', onclick: () => { if (confirm('룰 삭제?')) { deleteRuleApi(id); state.editRuleId = null; renderModal(); } } }, 'Delete rule'),
        el('span', { class: 'grow' }),
        el('button', { class: 'mini-btn', onclick: () => { state.editRuleId = null; renderModal(); } }, 'Done')))));
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

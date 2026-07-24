// Director touch controller. Reuses the same backend as the desktop app:
//   WS /ws (live director + runtime), POST /api/override, /api/override/shot,
//   /api/runtime. Editing lives on the desktop; this is live control only.

const S = { cfg: null, ws: null, staticSig: '' };

// ── Camera colors (match desktop app.js) ──────────────────────────
const CAM_PALETTE = ['#ffb02e', '#4488ff', '#00d68f', '#ff5da2', '#b06bff', '#33c5ff', '#ff8a5b'];
function cameraColor(cam) {
  if (cam === null || cam === undefined || cam === '') return '#7a8290';
  const n = parseInt(cam, 10);
  if (!isNaN(n)) return CAM_PALETTE[((n - 1) % CAM_PALETTE.length + CAM_PALETTE.length) % CAM_PALETTE.length];
  let h = 0; for (const ch of String(cam)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CAM_PALETTE[h % CAM_PALETTE.length];
}
const camLabel = (c) => (c === null || c === undefined || c === '') ? '—' : `CAM ${c}`;
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── API actions ───────────────────────────────────────────────────
async function send(method, path, body) {
  try {
    await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) { /* next tick reflects real state */ }
}
const setOverride = (tid) => send('POST', '/api/override', { transition_id: tid });
const setShot = (mid) => send('POST', '/api/override/shot', { macro_id: mid });
// NOTE: /api/runtime is PATCH-only — POST returns 405 (this was the "LIVE
// button does nothing" bug). Overrides use POST; runtime uses PATCH.
const patchRuntime = (b) => send('PATCH', '/api/runtime', b);

// ── Config + static build (pins, shot palette) ────────────────────
async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    S.cfg = await res.json();
    buildStatic();
  } catch (e) { /* retry on next visibility */ }
}

function buildStatic() {
  const transitions = S.cfg.transitions || [];
  const macros = S.cfg.macros || [];
  const sig = 'T:' + transitions.map(t => t.id).join(',') + '|M:' + macros.map(m => m.id).join(',');
  if (sig === S.staticSig) return;   // no structural change → keep DOM (taps stay live)
  S.staticSig = sig;

  // Transition pins
  const pins = document.getElementById('c-pins');
  pins.innerHTML = '';
  const auto = document.createElement('button');
  auto.className = 'c-pin auto'; auto.dataset.pin = 'auto'; auto.textContent = '자동';
  pins.appendChild(auto);
  transitions.forEach(t => {
    const b = document.createElement('button');
    b.className = 'c-pin'; b.dataset.pin = t.id;
    b.textContent = t.name || '(이름 없음)';
    pins.appendChild(b);
  });

  // Shot palette grouped by camera
  const shots = document.getElementById('c-shots');
  shots.innerHTML = '';
  if (!macros.length) {
    shots.innerHTML = '<div class="c-empty">데스크톱 Macros 탭에서 매크로를 먼저 만드세요.</div>';
    return;
  }
  const byCam = {};
  macros.forEach(m => {
    const c = (m.camera === null || m.camera === undefined || m.camera === '') ? '' : String(m.camera);
    (byCam[c] = byCam[c] || []).push(m);
  });
  Object.keys(byCam).sort().forEach(c => {
    const color = cameraColor(c);
    const row = document.createElement('div');
    row.className = 'c-camrow';
    const tag = document.createElement('div');
    tag.className = 'c-camtag'; tag.style.setProperty('--cam', color); tag.textContent = camLabel(c);
    const grid = document.createElement('div');
    grid.className = 'c-camshots';
    byCam[c].forEach(m => {
      const b = document.createElement('button');
      b.className = 'c-shot'; b.dataset.shot = m.id; b.style.setProperty('--cam', color);
      const sub = m.group ? `<div class="c-shot-sub">${esc(m.group)}</div>` : '';
      b.innerHTML = `<span>${esc(m.name || m.token || m.id)}</span>${sub}`;
      grid.appendChild(b);
    });
    row.append(tag, grid);
    shots.appendChild(row);
  });
}

// ── Live tick render ──────────────────────────────────────────────
function onTick(msg) {
  const rt = msg.runtime || {};
  const eng = msg.engine || {};
  const d = eng.director || {};
  const pinTrans = eng.override_transition_id || null;
  const heldShot = eng.override_macro_id || null;
  const dynMode = (rt.director_mode || eng.director_mode) === 'dynamic';

  // Mode toggles
  setSeg('auto', rt.auto === false ? '0' : '1');
  setSeg('mode', dynMode ? 'dynamic' : 'rules');
  setSeg('dry', rt.dry_run === false ? '0' : '1');

  // NOW / NEXT
  const now = document.getElementById('c-now');
  now.classList.toggle('dyn', dynMode && !pinTrans && !heldShot);
  now.classList.toggle('pinned', !!pinTrans);
  now.classList.toggle('shot', !!heldShot);

  const badge = document.getElementById('c-now-badge');
  const modeEl = document.getElementById('c-now-mode');
  const cur = d.current || null;
  const sources = d.active_sources || [];

  let badgeTxt = '○ 대기', badgeCls = '', modeTxt = '';
  if (heldShot) { badgeTxt = '🔴 수동 샷'; badgeCls = 'shot'; modeTxt = ''; }
  else if (pinTrans) { badgeTxt = '🔒 고정'; badgeCls = 'pinned'; modeTxt = d.transition_name || ''; }
  else if (cur && dynMode) { badgeTxt = '🟢 자동'; badgeCls = 'live'; modeTxt = sources.length ? sources.join(' + ') : '대기'; }
  else if (cur) { badgeTxt = 'ON AIR'; badgeCls = 'live'; modeTxt = eng.active_rule_name || d.transition_name || ''; }
  else if (dynMode) { badgeTxt = '🟢 자동 · 대기'; modeTxt = '활성 소스 없음'; }
  badge.textContent = badgeTxt; badge.className = 'c-now-badge ' + badgeCls;
  modeEl.textContent = modeTxt;

  const shotEl = document.getElementById('c-now-shot');
  const camEl = document.getElementById('c-now-cam');
  const nameEl = document.getElementById('c-now-name');
  if (cur) {
    shotEl.style.setProperty('--cam', cameraColor(cur.camera));
    camEl.textContent = camLabel(cur.camera);
    nameEl.textContent = cur.name || cur.macro_id || '';
  } else {
    shotEl.style.setProperty('--cam', 'var(--muted)');
    camEl.textContent = '—';
    nameEl.textContent = dynMode ? '대기 (소리 없음)' : '대기 중';
  }

  // NEXT filmstrip + countdown
  const strip = document.getElementById('c-next-strip');
  const upcoming = heldShot ? [] : (d.upcoming || []);
  strip.innerHTML = upcoming.slice(0, 4).map(u =>
    `<span class="c-next-chip" style="--cam:${cameraColor(u.camera)}">${esc(u.name || u.macro_id)}</span>`
  ).join('') || '<span class="c-next-chip" style="opacity:.5">—</span>';

  const interval = (!heldShot && cur) ? (d.interval || 0) : 0;
  const nextIn = (!heldShot && cur && d.next_in != null) ? d.next_in : null;
  const pct = (interval > 0 && nextIn != null) ? Math.max(0, Math.min(100, (1 - nextIn / interval) * 100)) : 0;
  document.getElementById('c-count-fill').style.width = pct + '%';
  document.getElementById('c-count-num').textContent =
    heldShot ? '고정' : (cur ? (nextIn != null ? `${nextIn.toFixed(1)}s` : (interval ? '' : '정지')) : '');

  // Activity pills (active roles, else active groups)
  renderActivity(msg.roles || {}, msg.groups || {});

  // Pin / shot on-states
  document.querySelectorAll('#c-pins .c-pin').forEach(b => {
    const isAuto = b.dataset.pin === 'auto';
    b.classList.toggle('on', isAuto ? (!pinTrans && !heldShot) : b.dataset.pin === pinTrans);
  });
  document.querySelectorAll('#c-shots .c-shot').forEach(b => {
    b.classList.toggle('on', b.dataset.shot === heldShot);
  });
}

function renderActivity(roles, groups) {
  const wrap = document.getElementById('c-activity');
  const roleNames = Object.keys(S.cfg?.roles || {});
  const useRoles = roleNames.length > 0;
  const src = useRoles ? roles : groups;
  const defs = useRoles ? (S.cfg.roles || {}) : (S.cfg.groups || {});
  const activeNames = Object.keys(src).filter(n => src[n]?.active);
  let html = `<span class="c-act-label">활성 ${useRoles ? '역할' : '그룹'}</span>`;
  if (!activeNames.length) {
    html += '<span class="c-apill" style="opacity:.55">— 없음 —</span>';
  } else {
    html += activeNames.map(n => {
      const color = defs[n]?.color || 'var(--cyan)';
      return `<span class="c-apill on" style="--pc:${color}"><span class="c-apill-dot" style="background:${color}"></span>${esc(n)}</span>`;
    }).join('');
  }
  wrap.innerHTML = html;
}

function setSeg(act, val) {
  document.querySelectorAll(`.c-segbtn[data-act="${act}"]`).forEach(b => {
    b.classList.toggle('on', b.dataset.val === val);
  });
}

// ── Wiring ────────────────────────────────────────────────────────
function bind() {
  document.querySelector('.c-modes').addEventListener('click', (e) => {
    const btn = e.target.closest('.c-segbtn'); if (!btn) return;
    const act = btn.dataset.act, val = btn.dataset.val;
    if (act === 'auto') patchRuntime({ auto: val === '1' });
    else if (act === 'mode') patchRuntime({ director_mode: val });
    else if (act === 'dry') {
      if (val === '0') { if (!confirm('LIVE 전환 — 실제로 OBS에 명령이 나갑니다. 계속할까요?')) return; }
      patchRuntime({ dry_run: val === '1' });
    }
  });

  document.getElementById('c-pins').addEventListener('click', (e) => {
    const b = e.target.closest('.c-pin'); if (!b) return;
    setOverride(b.dataset.pin === 'auto' ? null : b.dataset.pin);
  });
  document.getElementById('c-shots').addEventListener('click', (e) => {
    const b = e.target.closest('.c-shot'); if (!b) return;
    setShot(b.classList.contains('on') ? null : b.dataset.shot);   // tap again = release
  });
  document.getElementById('c-release').addEventListener('click', () => setShot(null));

  // Re-sync palette if the setup changed on the desktop while backgrounded.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadConfig(); });
}

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  S.ws = ws;
  const dot = document.getElementById('c-dot');
  const status = document.getElementById('c-status');
  ws.onopen = () => { dot.className = 'c-dot on'; status.textContent = '연결됨'; };
  ws.onclose = () => { dot.className = 'c-dot off'; status.textContent = '끊김 — 재연결 중…'; setTimeout(connectWS, 1500); };
  ws.onerror = () => { try { ws.close(); } catch (e) {} };
  ws.onmessage = (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch (err) { return; }
    if (msg.type === 'tick') { if (!S.cfg) return; try { onTick(msg); } catch (err) {} }
  };
}

(async function boot() {
  bind();
  await loadConfig();
  connectWS();
  // Keep iOS from sleeping the socket too aggressively when re-shown.
  window.addEventListener('pageshow', () => { if (!S.ws || S.ws.readyState > 1) connectWS(); });
})();

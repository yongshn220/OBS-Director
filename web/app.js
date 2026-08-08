// ── State ──────────────────────────────────────────────────────────
const state = {
  config: null,
  ws: null,
  lastTick: null,
  fps: { count: 0, t0: Date.now() },
  // Per-channel live-dB cells in the Channels tab. Index = channel id - 1.
  // Each entry: { wrap, bar, value }. Cleared & rebuilt when the table is rerendered.
  channelLiveDb: [],
};

const THRESHOLD_CLIP_RMS = 0.9;

// Curated palette: 10 vibrant colors that read well on the dark theme,
// chosen for hue separation so groups stay visually distinguishable.
// Used for group-color swatches in the Groups tab.
const GROUP_COLOR_PALETTE = [
  '#26d68b', // mint
  '#3b8bff', // azure
  '#ffb633', // amber
  '#ff5577', // coral
  '#9b5cff', // violet
  '#ff7a26', // tangerine
  '#22cdd4', // cyan
  '#ff5cb0', // rose
  '#a8e63a', // chartreuse
  '#00bd9b', // emerald
];

// A single circular swatch that IS the native color-picker trigger: the
// visible circle shows the current color, and a fully transparent
// <input type="color"> sits on top capturing the click, so clicking the
// circle opens the browser's native color wheel/picker (any color, not just
// the curated palette). onChange fires once the picker is dismissed.
function renderColorCirclePicker(currentColor, onChange) {
  const wrap = document.createElement('span');
  wrap.className = 'color-circle-picker';
  wrap.style.background = currentColor || '#888';
  wrap.title = '클릭해서 색상 변경';
  const input = document.createElement('input');
  input.type = 'color';
  input.value = currentColor || '#888888';
  input.addEventListener('input', () => { wrap.style.background = input.value; });
  input.addEventListener('change', () => onChange(input.value));
  wrap.appendChild(input);
  return wrap;
}

// ── Boot ───────────────────────────────────────────────────────────
async function boot() {
  await loadConfig();
  buildMonitor();
  buildChannelsTable();
  buildGroups();
  buildMacros();
  buildTransitions();
  buildRules();
  buildConnections();
  bindTabs();
  bindGroupAdd();
  bindRuntimeToggles();
  bindAddRule();
  bindShotButtons();
  bindDirectorOverride();
  bindConnectionsForm();
  bindProjectPill();
  renderRuntimeToggles();
  renderProjectPill();
  connectWS();
}

// Re-fetch config and rebuild every project-scoped view. Called after a
// project switch so channels/groups/macros/transitions/rules reflect the
// newly active project.
async function rebuildAll() {
  await loadConfig();
  buildMonitor();
  buildChannelsTable();
  buildGroups();
  buildMacros();
  buildTransitions();
  buildRules();
  buildConnections();
  renderRuntimeToggles();
  renderProjectPill();
}

async function loadConfig() {
  const res = await fetch('/api/config');
  state.config = await res.json();
}

// ── Tabs ──────────────────────────────────────────────────────────
function bindTabs() {
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('tab-disabled')) return;
      const target = btn.dataset.tab;
      document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === btn));
      document.querySelectorAll('main > .panel').forEach(p => {
        p.classList.toggle('hidden', p.id !== `panel-${target}`);
      });
    });
  });
}

// ── Monitor ───────────────────────────────────────────────────────
let monitorCards = [];

function buildMonitor() {
  const grid = document.getElementById('grid');
  grid.innerHTML = '';
  monitorCards = [];

  state.config.channels.forEach(ch => {
    const card = document.createElement('div');
    card.className = 'channel-card';

    const label = document.createElement('div');
    label.className = 'ch-label';
    label.textContent = `CH${String(ch.id).padStart(2, '0')}`;

    const name = document.createElement('div');
    name.className = 'ch-name';
    name.textContent = ch.name || '';

    const groupTag = document.createElement('div');
    groupTag.className = 'ch-group-tag';
    if (ch.role) {
      const rp = document.createElement('span');
      rp.className = 'ch-role-pill';
      rp.textContent = ch.role;
      const rc = state.config.roles?.[ch.role]?.color;
      if (rc) rp.style.color = rc;
      groupTag.appendChild(rp);
    }
    if (ch.group) {
      if (ch.role) groupTag.appendChild(document.createTextNode(' '));
      const gp = document.createElement('span');
      gp.className = 'ch-group-pill';
      gp.textContent = ch.group;
      const color = state.config.groups[ch.group]?.color;
      if (color) gp.style.color = color;
      groupTag.appendChild(gp);
    }

    const wrap = document.createElement('div');
    wrap.className = 'vu-wrap';
    const fill = document.createElement('div');
    fill.className = 'vu-fill';
    wrap.appendChild(fill);

    const dbEl = document.createElement('div');
    dbEl.className = 'vu-db';
    dbEl.textContent = '—';

    card.append(label, name, groupTag, wrap, dbEl);
    grid.appendChild(card);

    monitorCards.push({ card, fill, dbEl, id: ch.id });
  });
}

function rmsToDb(rms) {
  if (rms < 1e-7) return -Infinity;
  return 20 * Math.log10(rms);
}
function dbToPercent(db) {
  return Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
}

// Always 1 decimal place (e.g., -30.0, -8.5, +0.0). Falsy/non-finite → "—".
function formatDb(db) {
  if (db == null || !isFinite(db)) return '—';
  const sign = db >= 0 ? '+' : '';
  return sign + db.toFixed(1);
}

function renderMonitorTick(msg) {
  msg.levels.forEach((rms, i) => {
    if (i >= monitorCards.length) return;
    const { card, fill, dbEl } = monitorCards[i];
    const db = rmsToDb(rms);
    fill.style.height = dbToPercent(db) + '%';
    const isClipping = rms > THRESHOLD_CLIP_RMS;
    const chCfg = state.config.channels[i];
    const thr = chCfg ? chCfg.threshold_db : -45;
    const isActive = isFinite(db) && db >= thr;
    card.classList.toggle('active', isActive && !isClipping);
    card.classList.toggle('clipping', isClipping);
    dbEl.textContent = formatDb(db);
  });

  // FPS
  state.fps.count++;
  const now = Date.now();
  if (now - state.fps.t0 >= 1000) {
    document.getElementById('fps-display').textContent = state.fps.count + ' fps';
    state.fps.count = 0;
    state.fps.t0 = now;
  }

  // Peak
  let maxIdx = 0, maxVal = -Infinity;
  msg.levels.forEach((v, i) => {
    const db = rmsToDb(v);
    if (db > maxVal) { maxVal = db; maxIdx = i; }
  });
  if (isFinite(maxVal)) {
    const ch = state.config.channels[maxIdx];
    const nm = ch?.name ? `${ch.name} ` : '';
    document.getElementById('peak-display').textContent =
      `PEAK · CH${maxIdx + 1} ${nm}${formatDb(maxVal)} dB`;
  }

  renderGroupPills(msg.groups || {});
  renderRolePills(msg.roles || {});
  renderModePill(msg.status || {});
  renderAudioAlarm(msg.status || {});
  renderChannelsLiveDb(msg.levels);
  applyLiveGroupsToCondPills(msg.groups || {});
}

// Render the cuesheet: live mini-monitor (group activity + mode) above
// the priority-ordered queue of matching rules.
function renderCueSheet(msg) {
  renderCueMiniMonitor(msg.groups || {}, msg.status || {});
  renderCueQueue(msg.engine || {});
}

function renderCueMiniMonitor(groups, audioStatus) {
  const root = document.getElementById('cs-mini-mon');
  if (!root) return;
  const groupNames = Object.keys(state.config.groups || {});
  const rt = state.config.runtime || { auto: true, dry_run: true };

  const parts = [];

  // Group pills with peak dB
  for (const name of groupNames) {
    const g = groups[name];
    const active = !!g?.active;
    const peak = (g?.peak_db != null && isFinite(g.peak_db))
      ? formatDb(g.peak_db) + ' dB'
      : '—';
    parts.push(
      `<span class="cs-mini-group ${active ? 'active' : ''}">
         <span class="mg-dot"></span>
         <span class="mg-name">${escapeHtml(name)}</span>
         <span class="mg-peak">${peak}</span>
       </span>`
    );
  }

  if (groupNames.length) parts.push('<span class="cs-mini-divider"></span>');

  // AUTO / DRY status — at-a-glance reminder while editing rules
  parts.push(
    `<span class="cs-mini-mode">
       <span class="cs-mini-mode-pill mode-${rt.auto ? 'auto' : 'manual'}">${rt.auto ? 'AUTO' : 'MANUAL'}</span>
       <span class="cs-mini-mode-pill mode-${rt.dry_run ? 'dry' : 'live'}">${rt.dry_run ? 'DRY' : 'LIVE'}</span>
     </span>`
  );

  // Audio mode (LIVE / DEMO) — only show if relevant (not idle)
  if (audioStatus && audioStatus.mode && audioStatus.mode !== 'idle') {
    parts.push('<span class="cs-mini-divider"></span>');
    parts.push(
      `<span class="cs-mini-obs">
         <span>Audio · ${escapeHtml(audioStatus.mode.toUpperCase())}</span>
       </span>`
    );
  }

  root.innerHTML = parts.join('');
}

function renderCueQueue(engine) {
  const root = document.getElementById('cs-queue');
  if (!root) return;
  const matching = engine.matching || [];

  if (matching.length === 0) {
    root.innerHTML = '<div class="cs-queue-empty">— 매칭되는 룰 없음 —</div>';
    return;
  }

  root.innerHTML = '';
  matching.forEach((m, idx) => {
    const row = document.createElement('div');
    let cls = 'mq-row';
    let tag;
    if (m.is_active) {
      cls += ' mq-now';     tag = 'NOW';
    } else if (idx === 0 || (idx === 1 && matching[0].is_active)) {
      cls += ' mq-next';    tag = 'NEXT';
    } else {
      cls += ' mq-queued';  tag = '…';
    }
    row.className = cls;

    const cdMeta = (m.is_active && engine.active_cooldown_remaining != null && engine.active_cooldown_remaining > 0)
      ? `cd ${engine.active_cooldown_remaining.toFixed(1)}s`
      : '';

    row.innerHTML = `
      <span class="mq-tag">${tag}</span>
      <span class="mq-priority">P${m.priority}</span>
      <span class="mq-name" data-rule-id="${m.id}" title="클릭해서 해당 룰로 스크롤">${escapeHtml(m.name || '')}</span>
      <span class="mq-preview" title="${escapeHtml(m.preview || '')}">${escapeHtml(m.preview || '')}</span>
      <span class="mq-meta">${cdMeta}</span>
    `;

    row.querySelector('.mq-name').addEventListener('click', () => {
      const card = document.querySelector(`.rule-card[data-rule-id="${m.id}"]`);
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.style.transition = 'box-shadow 0.4s';
        card.style.boxShadow = '0 0 0 2px var(--blue)';
        setTimeout(() => { card.style.boxShadow = ''; }, 800);
      }
    });

    root.appendChild(row);
  });
}

// Toggle the .cp-live class on existing rule-card condition pills based on
// current group activity. Avoids a full rule-card rebuild every tick.
function applyLiveGroupsToCondPills(groups) {
  state.liveGroupState = groups;
  document.querySelectorAll('.rule-card .cond-pill').forEach(pill => {
    const g = pill.dataset.group;
    if (!g) return;
    pill.classList.toggle('cp-live', !!groups[g]?.active);
  });
}

function renderChannelsLiveDb(levels) {
  if (!state.channelLiveDb.length) return;  // Channels tab not yet rendered
  for (let i = 0; i < levels.length && i < state.channelLiveDb.length; i++) {
    const refs = state.channelLiveDb[i];
    if (!refs) continue;
    const rms = levels[i];
    const db = rmsToDb(rms);
    refs.value.textContent = formatDb(db);
    refs.bar.style.width = dbToPercent(db) + '%';
    const chCfg = state.config.channels[i];
    const thr = chCfg ? chCfg.threshold_db : -45;
    const isClipping = rms > THRESHOLD_CLIP_RMS;
    const over = isFinite(db) && db >= thr;
    refs.wrap.classList.toggle('over', over && !isClipping);
    refs.wrap.classList.toggle('clipping', isClipping);
  }
}

// Loud, always-visible alarm when the real audio device drops. status.mode
// becomes "error" (levels forced to zero by the backend watchdog) — the
// operator must know the director is running blind, not that everyone is quiet.
function renderAudioAlarm(status) {
  const el = document.getElementById('audio-alarm');
  if (!el) return;
  const isError = status && status.mode === 'error';
  el.classList.toggle('hidden', !isError);
  if (isError) {
    el.textContent = '⚠ 오디오 입력 없음 — ' + (status.error || 'X32 신호가 잡히지 않습니다')
      + ' · 자동 재연결 시도 중…';
  }
}

function renderModePill(status) {
  const pill = document.getElementById('mode-pill');
  const mode = status.mode || 'idle';
  pill.className = 'mode-pill mode-' + mode;
  pill.textContent = mode.toUpperCase();
  pill.title = status.error || status.device || '';
}

function renderGroupPills(groups) {
  const wrap = document.getElementById('group-pills');
  const names = Object.keys(state.config.groups);
  // Build once; update classes/text inline
  if (wrap.childElementCount !== names.length) {
    wrap.innerHTML = '';
    names.forEach(name => {
      const el = document.createElement('div');
      el.className = 'group-pill';
      el.dataset.group = name;
      const dot = document.createElement('span');
      dot.className = 'pill-dot';
      const label = document.createElement('span');
      label.className = 'pill-label';
      label.textContent = name;
      const meta = document.createElement('span');
      meta.className = 'pill-meta';
      el.append(dot, label, meta);
      wrap.appendChild(el);
    });
  }
  names.forEach(name => {
    const el = wrap.querySelector(`[data-group="${name}"]`);
    if (!el) return;
    const g = groups[name];
    const active = g?.active;
    el.classList.toggle('active', !!active);
    const dot = el.querySelector('.pill-dot');
    const color = state.config.groups[name]?.color;
    if (color) dot.style.background = active ? color : '';
    el.querySelector('.pill-meta').textContent =
      g ? `· ${g.member_count}ch · ${formatDb(g.peak_db)} dB` : '';
  });
}

// Fine role activity — the signal that drives dynamic-mode shot selection.
// Hidden entirely when no roles are defined so the monitor stays uncluttered.
function renderRolePills(roles) {
  const wrap = document.getElementById('role-pills');
  if (!wrap) return;
  const names = Object.keys(state.config.roles || {});
  if (!names.length) { wrap.style.display = 'none'; wrap.innerHTML = ''; return; }
  wrap.style.display = '';
  if (wrap.childElementCount !== names.length + 1) {
    wrap.innerHTML = '<span class="rp-label">역할</span>';
    names.forEach(name => {
      const el = document.createElement('div');
      el.className = 'role-pill';
      el.dataset.role = name;
      const dot = document.createElement('span');
      dot.className = 'pill-dot';
      const label = document.createElement('span');
      label.className = 'pill-label';
      label.textContent = name;
      const meta = document.createElement('span');
      meta.className = 'pill-meta';
      el.append(dot, label, meta);
      wrap.appendChild(el);
    });
  }
  names.forEach(name => {
    const el = wrap.querySelector(`[data-role="${CSS.escape(name)}"]`);
    if (!el) return;
    const r = roles[name];
    const active = r?.active;
    el.classList.toggle('active', !!active);
    const dot = el.querySelector('.pill-dot');
    const color = state.config.roles[name]?.color;
    if (color) dot.style.background = active ? color : '';
    el.querySelector('.pill-meta').textContent =
      r ? `· ${r.member_count}ch · ${formatDb(r.peak_db)} dB` : '';
  });
}

// ── Channels table ────────────────────────────────────────────────
function buildChannelsTable() {
  const root = document.getElementById('channels-table');
  root.innerHTML = '';
  state.channelLiveDb = [];
  const groupNames = Object.keys(state.config.groups);

  state.config.channels.forEach(ch => {
    const row = document.createElement('div');
    row.className = 'channel-row';

    const num = document.createElement('div');
    num.className = 'ch-num';
    num.textContent = `CH ${ch.id}`;

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = '채널 이름 (예: 보컬 메인)';
    nameInput.value = ch.name || '';
    nameInput.addEventListener('change', () => patchChannel(ch.id, { name: nameInput.value }));

    // Role/Group cell: pick a GROUP (coarse), then a ROLE (fine, filtered to
    // that group). Setting a role derives the group on the backend; changing
    // the group clears the role (it may not belong to the new group).
    const rgCell = document.createElement('div');
    rgCell.className = 'ch-rolegroup-cell';

    const groupSel = document.createElement('select');
    groupSel.className = 'ch-group-sel';
    groupSel.appendChild(new Option('그룹 없음', ''));
    groupNames.forEach(g => groupSel.appendChild(new Option(g, g)));
    groupSel.value = ch.group || '';
    {
      const gc = ch.group && state.config.groups[ch.group]?.color;
      groupSel.style.borderColor = gc || '';
    }
    groupSel.addEventListener('change', () => {
      patchChannel(ch.id, { role: null, group: groupSel.value || null });
    });

    const roleSel = document.createElement('select');
    roleSel.className = 'ch-role-sel';
    const rolesInGroup = Object.entries(state.config.roles || {})
      .filter(([, r]) => r.group === ch.group)
      .map(([rn]) => rn);
    roleSel.appendChild(new Option('역할 없음', ''));
    rolesInGroup.forEach(rn => roleSel.appendChild(new Option(rn, rn)));
    roleSel.value = ch.role || '';
    roleSel.disabled = !ch.group;
    roleSel.title = ch.group
      ? (rolesInGroup.length ? '이 채널의 역할 (세부 피사체)' : 'Groups 탭에서 이 그룹에 역할을 먼저 만드세요')
      : '먼저 그룹을 선택하세요';
    {
      const rc = ch.role && state.config.roles[ch.role]?.color;
      roleSel.style.borderColor = rc || '';
    }
    roleSel.addEventListener('change', () => {
      patchChannel(ch.id, { role: roleSel.value || null });
    });

    rgCell.append(groupSel, roleSel);
    const groupCell = rgCell;

    const thrCell = document.createElement('div');
    thrCell.className = 'threshold-cell';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '-80';
    slider.max = '0';
    slider.step = '1';
    slider.value = ch.threshold_db ?? -45;
    const readout = document.createElement('div');
    readout.className = 'db-readout';
    const renderReadout = () => {
      readout.textContent = `${formatDb(parseFloat(slider.value))} dB`;
    };
    renderReadout();
    slider.addEventListener('input', renderReadout);
    slider.addEventListener('change', () => {
      patchChannel(ch.id, { threshold_db: parseFloat(slider.value) });
    });
    thrCell.append(slider, readout);

    // Live-dB cell — updated on every WS tick from renderMonitorTick().
    const live = document.createElement('div');
    live.className = 'live-db';
    const bar = document.createElement('div');
    bar.className = 'live-db-bar';
    const barFill = document.createElement('span');
    bar.appendChild(barFill);
    const liveValue = document.createElement('span');
    liveValue.className = 'live-db-value';
    liveValue.textContent = '—';
    live.append(bar, liveValue);
    state.channelLiveDb[ch.id - 1] = { wrap: live, bar: barFill, value: liveValue };

    row.append(num, nameInput, groupCell, thrCell, live);
    root.appendChild(row);
  });
}

async function patchChannel(id, body) {
  const res = await fetch(`/api/channels/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error('patchChannel failed', await res.text());
    return;
  }
  state.config = await res.json();
  // Refresh dependent views (chips, monitor tags, member counts)
  buildMonitor();
  buildChannelsTable();
  buildGroups();
}

// ── Groups ────────────────────────────────────────────────────────
function buildGroups() {
  const grid = document.getElementById('groups-grid');
  grid.innerHTML = '';
  const groups = state.config.groups;
  const memberCounts = {};
  Object.keys(groups).forEach(g => memberCounts[g] = 0);
  state.config.channels.forEach(c => {
    if (c.group && memberCounts[c.group] !== undefined) memberCounts[c.group]++;
  });

  Object.entries(groups).forEach(([name, g]) => {
    const card = document.createElement('div');
    card.className = 'group-card';

    const header = document.createElement('div');
    header.className = 'group-card-header';
    const title = document.createElement('div');
    title.className = 'group-card-title';

    // Color circle — doubles as the swatch AND the picker trigger. Click it
    // to open the browser's native color wheel and pick any color.
    const dot = renderColorCirclePicker(g.color, async (newColor) => {
      await upsertGroup(name, { color: newColor });
      await loadConfig();
      buildMonitor();       // group pill colors
      buildChannelsTable(); // channel group-tag colors
    });
    dot.classList.add('group-color-dot');

    const titleText = document.createElement('span');
    titleText.textContent = name;
    title.append(dot, titleText);
    const meta = document.createElement('div');
    meta.className = 'group-card-meta';
    meta.textContent = `${memberCounts[name]} 채널`;
    header.append(title, meta);

    const attackRow = makeSliderRow('Attack', 'attack_ms', g.attack_ms ?? 200, 0, 2000, 10);
    const releaseRow = makeSliderRow('Release', 'release_ms', g.release_ms ?? 1000, 0, 5000, 50);

    attackRow.input.addEventListener('change', () => {
      upsertGroup(name, { attack_ms: parseFloat(attackRow.input.value) });
    });
    releaseRow.input.addEventListener('change', () => {
      upsertGroup(name, { release_ms: parseFloat(releaseRow.input.value) });
    });

    // Roles subsection: the fine subject identities inside this group.
    const rolesSection = renderGroupRoles(name);

    const footer = document.createElement('div');
    footer.className = 'group-card-footer';
    const delBtn = document.createElement('button');
    delBtn.className = 'btn small danger';
    delBtn.textContent = '삭제';
    delBtn.addEventListener('click', async () => {
      const roleCount = Object.values(state.config.roles || {})
        .filter(r => r.group === name).length;
      const warn = roleCount
        ? `\n이 그룹의 역할 ${roleCount}개도 함께 삭제되고, 해당 채널은 역할 없음이 됩니다.`
        : '\n이 그룹에 속한 채널은 그룹 없음 상태가 됩니다.';
      if (!confirm(`"${name}" 그룹을 삭제할까요?${warn}`)) return;
      await fetch(`/api/groups/${encodeURIComponent(name)}`, { method: 'DELETE' });
      await loadConfig();
      buildGroups();
      buildChannelsTable();
      buildMonitor();
      buildMacros();
    });
    footer.appendChild(delBtn);

    card.append(header, attackRow.row, releaseRow.row, rolesSection, footer);
    grid.appendChild(card);
  });
}

// A group card's roles: chips (color + name + ×) plus an add-role input.
// Roles are the fine subject identities dynamic mode targets; each belongs to
// exactly this group and inherits its timing.
function renderGroupRoles(groupName) {
  const section = document.createElement('div');
  section.className = 'group-roles';
  const label = document.createElement('div');
  label.className = 'gr-label';
  label.textContent = '역할 (세부 피사체 · 동적 플래닝 대상)';
  section.appendChild(label);

  const list = document.createElement('div');
  list.className = 'gr-list';
  const roles = Object.entries(state.config.roles || {}).filter(([, r]) => r.group === groupName);
  if (!roles.length) {
    const empty = document.createElement('span');
    empty.className = 'gr-empty';
    empty.textContent = '아직 역할이 없습니다';
    list.appendChild(empty);
  } else {
    roles.forEach(([rn, r]) => {
      const chip = document.createElement('span');
      chip.className = 'gr-chip';
      const dot = renderColorCirclePicker(r.color, async (newColor) => {
        await upsertRole(rn, { color: newColor });
        await loadConfig();
        buildGroups(); buildMonitor(); buildMacros();
      });
      dot.classList.add('gr-dot');
      const nm = document.createElement('span');
      nm.className = 'gr-name';
      nm.textContent = rn;
      const x = document.createElement('button');
      x.className = 'gr-x';
      x.textContent = '×';
      x.title = '역할 삭제';
      x.addEventListener('click', async () => {
        if (!confirm(`역할 "${rn}" 삭제? (이 역할을 쓰던 채널은 역할 없음이 됩니다)`)) return;
        await deleteRole(rn);
        await loadConfig();
        buildGroups(); buildChannelsTable(); buildMonitor(); buildMacros();
      });
      chip.append(dot, nm, x);
      list.appendChild(chip);
    });
  }
  section.appendChild(list);

  const add = document.createElement('div');
  add.className = 'gr-add';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = '새 역할 (예: Singer Choi)';
  input.maxLength = 30;
  const btn = document.createElement('button');
  btn.className = 'btn small';
  btn.textContent = '+ 역할';
  const submit = async () => {
    const rn = input.value.trim();
    if (!rn) return;
    if (state.config.roles && state.config.roles[rn]) {
      alert('같은 이름의 역할이 이미 있습니다.');
      return;
    }
    const gc = state.config.groups[groupName]?.color || '#888888';
    await upsertRole(rn, { group: groupName, color: gc });
    input.value = '';
    await loadConfig();
    buildGroups(); buildChannelsTable(); buildMacros();
  };
  btn.addEventListener('click', submit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  add.append(input, btn);
  section.appendChild(add);
  return section;
}

async function upsertRole(name, body) {
  const res = await fetch(`/api/roles/${encodeURIComponent(name)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) { alert('역할 저장 실패: ' + (await res.text())); throw new Error('upsertRole'); }
  return res.json();
}

async function deleteRole(name) {
  const res = await fetch(`/api/roles/${encodeURIComponent(name)}`, { method: 'DELETE' });
  if (!res.ok) { alert('역할 삭제 실패: ' + (await res.text())); throw new Error('deleteRole'); }
}

function makeSliderRow(label, key, value, min, max, step) {
  const row = document.createElement('div');
  row.className = 'group-slider-row';

  const labelRow = document.createElement('div');
  labelRow.className = 'slider-label';
  const labelEl = document.createElement('span');
  labelEl.textContent = label + (key === 'attack_ms' ? ' (켜지는 속도)' : ' (꺼지는 속도)');
  const readout = document.createElement('span');
  readout.className = 'ms-readout';
  readout.textContent = `${value} ms`;
  labelRow.append(labelEl, readout);

  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.addEventListener('input', () => {
    readout.textContent = `${input.value} ms`;
  });

  row.append(labelRow, input);
  return { row, input };
}

async function upsertGroup(name, body) {
  const res = await fetch(`/api/groups/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error('upsertGroup failed', await res.text());
    return;
  }
  state.config = await res.json();
}

function bindGroupAdd() {
  const btn = document.getElementById('add-group-btn');
  const input = document.getElementById('new-group-name');
  const paletteRoot = document.getElementById('new-group-palette');

  // The chosen color for the next-to-be-created group, picked via the native
  // color wheel behind the circle swatch. Defaults rotate through the curated
  // palette so successive adds still start out visually distinct.
  let chosenColor = GROUP_COLOR_PALETTE[0];
  paletteRoot.innerHTML = '';
  paletteRoot.appendChild(renderColorCirclePicker(chosenColor, (c) => { chosenColor = c; }));

  const submit = async () => {
    const name = input.value.trim();
    if (!name) return;
    if (state.config.groups[name]) {
      alert('같은 이름의 그룹이 이미 있습니다.');
      return;
    }
    await upsertGroup(name, {
      attack_ms: 200,
      release_ms: 1000,
      color: chosenColor,
    });
    input.value = '';
    // Suggest the next palette slot so successive group adds get distinct colors
    // (falls back to the first slot if the last add used a custom picked color).
    const idx = GROUP_COLOR_PALETTE.indexOf(chosenColor);
    chosenColor = GROUP_COLOR_PALETTE[(idx + 1) % GROUP_COLOR_PALETTE.length];
    paletteRoot.innerHTML = '';
    paletteRoot.appendChild(renderColorCirclePicker(chosenColor, (c) => { chosenColor = c; }));
    await loadConfig();
    buildGroups();
    buildChannelsTable();
    buildMonitor();
  };
  btn.addEventListener('click', submit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
}

function randomColor() {
  const palette = ['#00ff88', '#4488ff', '#ffd700', '#ff4060', '#aa66ff', '#ff8844', '#44ddee'];
  return palette[Math.floor(Math.random() * palette.length)];
}

// ── WebSocket ─────────────────────────────────────────────────────
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  state.ws = ws;
  const dot = document.getElementById('dot');
  const text = document.getElementById('status-text');

  ws.onopen = () => {
    dot.className = 'status-dot connected';
    text.textContent = '연결됨';
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'tick') {
        renderMonitorTick(msg);
        renderDirector(msg.engine || {});
        renderEngineState(msg.engine || {});
        renderActivityLog(msg.recent_log || []);
        renderCueSheet(msg);
      }
    } catch (err) { /* ignore */ }
  };

  ws.onclose = () => {
    dot.className = 'status-dot error';
    text.textContent = '연결 끊김 — 재시도 중...';
    setTimeout(connectWS, 1500);
  };

  ws.onerror = () => {
    dot.className = 'status-dot error';
    text.textContent = '서버 응답 없음';
  };
}

// ── Runtime toggles (AUTO|MANUAL · DRY|LIVE) ──────────────────────
function bindRuntimeToggles() {
  // AUTO / MANUAL — clicking the segment that's already active is a no-op
  document.getElementById('seg-auto').addEventListener('click', () => {
    if (state.config.runtime?.auto !== true) patchRuntime({ auto: true });
  });
  document.getElementById('seg-manual').addEventListener('click', () => {
    if (state.config.runtime?.auto !== false) patchRuntime({ auto: false });
  });
  // DRY / LIVE — confirm only when entering LIVE
  document.getElementById('seg-dry').addEventListener('click', () => {
    if (state.config.runtime?.dry_run !== true) patchRuntime({ dry_run: true });
  });
  document.getElementById('seg-live').addEventListener('click', () => {
    if (state.config.runtime?.dry_run === false) return;
    if (!confirm('LIVE 모드로 전환하면 실제로 OBS·PTZ에 명령을 보냅니다. 계속할까요?')) return;
    patchRuntime({ dry_run: false });
  });
  // RULES / DYNAMIC — how the director decides what to show
  document.getElementById('seg-rules').addEventListener('click', () => {
    if (state.config.runtime?.director_mode !== 'rules') patchRuntime({ director_mode: 'rules' });
  });
  document.getElementById('seg-dynamic').addEventListener('click', () => {
    if (state.config.runtime?.director_mode !== 'dynamic') patchRuntime({ director_mode: 'dynamic' });
  });
  // Dynamic-planning knobs
  const di = document.getElementById('dyn-interval');
  if (di) di.addEventListener('change', () => {
    const v = parseFloat(di.value);
    if (!isNaN(v)) patchRuntime({ dynamic_interval_s: Math.max(0.5, v) });
  });
  const dg = document.getElementById('dyn-group-alt');
  if (dg) dg.addEventListener('change', () => patchRuntime({ dynamic_group_alternate: dg.checked }));
}

async function patchRuntime(body) {
  const res = await fetch('/api/runtime', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error('patchRuntime failed', await res.text());
    return;
  }
  const newRuntime = await res.json();
  state.config.runtime = newRuntime;
  renderRuntimeToggles();
}

function renderRuntimeToggles() {
  const rt = state.config.runtime || { auto: true, dry_run: true };
  document.getElementById('seg-auto').classList.toggle('active', rt.auto === true);
  document.getElementById('seg-manual').classList.toggle('active', rt.auto === false);
  document.getElementById('seg-dry').classList.toggle('active', rt.dry_run === true);
  document.getElementById('seg-live').classList.toggle('active', rt.dry_run === false);
  // Director mode + dynamic settings visibility
  const dyn = rt.director_mode === 'dynamic';
  document.getElementById('seg-rules')?.classList.toggle('active', !dyn);
  document.getElementById('seg-dynamic')?.classList.toggle('active', dyn);
  const ds = document.getElementById('dynamic-settings');
  if (ds) ds.classList.toggle('hidden', !dyn);
  const dcfg = rt.dynamic || {};
  const di = document.getElementById('dyn-interval');
  if (di && document.activeElement !== di) di.value = (dcfg.interval_s != null ? dcfg.interval_s : 8);
  const dg = document.getElementById('dyn-group-alt');
  if (dg) dg.checked = dcfg.group_alternate !== false;
}

// ── Engine state (active card highlight) ──────────────────────────
// The current rule name now lives in the Rules-tab cuesheet's NOW row,
// not in the header — keeping the header's UI controls from jittering as
// rule names change in length.
function renderEngineState(engine) {
  document.querySelectorAll('.rule-card').forEach(card => {
    card.classList.toggle('active-rule', card.dataset.ruleId === engine.active_rule_id);
  });
}

// ── Activity log ──────────────────────────────────────────────────
function renderActivityLog(entries) {
  const root = document.getElementById('activity-log');
  if (!entries || !entries.length) {
    if (root.dataset.state !== 'empty') {
      root.innerHTML = '<div class="log-empty">아직 매칭된 액션이 없습니다.</div>';
      root.dataset.state = 'empty';
    }
    return;
  }
  root.dataset.state = 'has';
  // Render newest at top
  const ordered = [...entries].reverse();
  // Diff-aware update would be nicer; for ≤20 entries, full re-render is fine.
  root.innerHTML = '';
  ordered.forEach(e => {
    const row = document.createElement('div');
    row.className = 'log-entry';
    const time = new Date(e.wall_ts * 1000);
    const hh = String(time.getHours()).padStart(2, '0');
    const mm = String(time.getMinutes()).padStart(2, '0');
    const ss = String(time.getSeconds()).padStart(2, '0');
    const causeIcon = ({
      manual:     '✋',
      rotation:   '🔄',
      transition: '→',
    })[e.cause] || '·';
    row.innerHTML = `
      <span class="log-time">${hh}:${mm}:${ss}</span>
      <span class="log-type t-${e.type}">${e.type.replace('_', ' ')}</span>
      <span class="log-rule"><span class="log-cause c-${e.cause || ''}" title="${e.cause || ''}">${causeIcon}</span>${escapeHtml(e.rule_name || '')}</span>
      <span class="log-detail" title="${escapeHtml(e.detail)}">${escapeHtml(e.detail)}</span>
      <span class="log-flag ${e.dry_run ? 'dry' : 'live'}">${e.dry_run ? 'DRY' : 'LIVE'}</span>
    `;
    root.appendChild(row);
  });
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Rules ─────────────────────────────────────────────────────────
// ── Camera colors (shared by Director HUD + Transitions preview) ──
const CAM_PALETTE = ['#ffb02e', '#4488ff', '#00d68f', '#ff5da2', '#b06bff', '#33c5ff', '#ff8a5b'];
function cameraColor(cam) {
  if (cam === null || cam === undefined || cam === '') return '#7a8290';
  const n = parseInt(cam, 10);
  if (!isNaN(n)) return CAM_PALETTE[((n - 1) % CAM_PALETTE.length + CAM_PALETTE.length) % CAM_PALETTE.length];
  let h = 0;
  for (const ch of String(cam)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CAM_PALETTE[h % CAM_PALETTE.length];
}
function camLabel(cam) {
  return (cam === null || cam === undefined || cam === '') ? '—' : `CAM ${cam}`;
}

// ── Live Director HUD (Monitor tab) ──────────────────────────────
// The HUD is ALWAYS visible. When a transition rule is active it shows the
// live ON-AIR shot + upcoming filmstrip; when no rule is active it stays in
// place (dimmed) holding the last shots, so the list updates in place on a
// rule change rather than vanishing and reappearing.
let lastDirector = null;
function renderDirector(engine) {
  const root = document.getElementById('director');
  if (!root) return;
  root.classList.remove('hidden');  // always present

  const d = engine.director;
  const pinTrans = engine.override_transition_id || null;   // pinned transition
  const heldShot = engine.override_macro_id || null;        // held single shot
  const dynMode = engine.director_mode === 'dynamic';       // live auto-planning
  const active = !!(d && d.transition_id && d.current);
  if (active) {
    lastDirector = {
      transition_name: d.transition_name, current: d.current,
      upcoming: d.upcoming || [], rule_name: engine.active_rule_name || '—',
      active_sources: d.active_sources || [],
    };
  }
  root.classList.toggle('idle', !active);
  root.classList.toggle('pinned', !!pinTrans);
  root.classList.toggle('shot', !!heldShot);
  root.classList.toggle('dyn', dynMode && !pinTrans && !heldShot);

  const shown = active ? {
    transition_name: d.transition_name, current: d.current,
    upcoming: d.upcoming || [], rule_name: engine.active_rule_name || '—',
    active_sources: d.active_sources || [],
  } : lastDirector;
  const dynSources = (shown && shown.active_sources) || (d && d.active_sources) || [];

  const transitions = state.config.transitions || [];
  const macros = state.config.macros || [];
  const controls = overrideStripHtml(transitions, pinTrans, heldShot)
    + shotPaletteHtml(macros, heldShot);

  const interval = (active && !heldShot) ? (d.interval || 0) : 0;
  const nextIn = (active && !heldShot && d.next_in !== null && d.next_in !== undefined) ? d.next_in : null;
  const pct = (interval > 0 && nextIn !== null)
    ? Math.max(0, Math.min(100, (1 - nextIn / interval) * 100)) : 0;

  let headBody;
  if (!shown || !shown.current) {
    const ruleHtml = pinTrans
      ? '<span class="dh-rule pinned">🔒 수동 고정</span>'
      : (dynMode ? '<span class="dh-rule dyn">🟢 자동 플래닝 · 대기</span>'
                 : '<span class="dh-rule idle">○ 대기 중</span>');
    const emptyText = dynMode
      ? '활성 그룹이 없습니다 — 소리가 들어오면 매크로 <b>소스</b>에 따라 자동으로 화면이 구성됩니다.'
      : '활성 룰이 없습니다 — 아래에서 트랜지션·샷을 수동 선택하거나, 룰이 매칭되면 표시됩니다.';
    headBody =
      `<div class="director-head"><div class="dh-left">`
      + `<span class="dh-label">DIRECTOR</span>${ruleHtml}</div></div>`
      + `<div class="director-strip director-empty">${emptyText}</div>`;
  } else {
    let ruleHtml, transText, transIcon, nextLabel, nowBadge;
    if (heldShot) {
      ruleHtml = '<span class="dh-rule shot">🔴 수동 샷</span>';
      transText = shown.current.name || ''; transIcon = ''; nextLabel = '고정'; nowBadge = 'LIVE';
    } else if (pinTrans) {
      ruleHtml = '<span class="dh-rule pinned">🔒 수동 고정</span>';
      transText = shown.transition_name || '—'; transIcon = '🔄 '; nextLabel = '고정 · 다음'; nowBadge = '고정';
    } else if (active) {
      if (dynMode) {
        const hold = !dynSources.length;
        ruleHtml = '<span class="dh-rule dyn">🟢 자동 플래닝</span>';
        transText = hold ? '대기 (활성 소스 없음)' : dynSources.join(' + ');
        transIcon = hold ? '' : '🎧 '; nextLabel = hold ? '홀드' : '다음 컷';
        nowBadge = hold ? '홀드' : 'ON AIR';
      } else {
        ruleHtml = `<span class="dh-rule">● ${escapeHtml(shown.rule_name)}</span>`;
        transText = shown.transition_name || '—'; transIcon = '🔄 '; nextLabel = '다음 컷'; nowBadge = 'ON AIR';
      }
    } else {
      ruleHtml = dynMode
        ? '<span class="dh-rule dyn">🟢 자동 · 대기</span>'
        : '<span class="dh-rule idle">○ 대기 중</span>';
      transText = dynMode ? (dynSources.length ? dynSources.join(' + ') : '대기') : (shown.transition_name || '—');
      transIcon = dynMode ? '🎧 ' : '🔄 '; nextLabel = '대기'; nowBadge = '마지막';
    }
    headBody = `
      <div class="director-head">
        <div class="dh-left">
          <span class="dh-label">DIRECTOR</span>
          ${ruleHtml}
          <span class="dh-arrow">→</span>
          <span class="dh-trans">${transIcon}${escapeHtml(transText)}</span>
        </div>
        <div class="dh-right">
          <span class="dh-next-label">${nextLabel}</span>
          <span class="dh-countbar"><span class="dh-countfill"></span></span>
          <span class="dh-countnum"></span>
        </div>
      </div>
      <div class="director-strip">
        ${shotChip(shown.current, 'now', nowBadge)}
        ${heldShot ? '' : `<span class="ds-flow">▶</span>`
          + shown.upcoming.map((u, i) => shotChip(u, i === 0 ? 'next' : 'soon', i === 0 ? '다음' : '')).join('')}
      </div>`;
  }

  // Rebuild DOM only when state / shots / pins / macro-set changes; the
  // countdown updates every tick without thrashing the controls.
  const shots = (shown && shown.current)
    ? [shown.current.macro_id, ...(heldShot ? [] : shown.upcoming.map(u => u.macro_id))].join('>')
    : '__empty__';
  const sig = (heldShot ? 'S' : (active ? 'A' : (pinTrans ? 'P' : 'I'))) + ':' + shots
    + '|O:' + (pinTrans || '') + '|M:' + (heldShot || '')
    + '|D:' + (dynMode ? '1' : '0') + '|G:' + (dynMode ? dynSources.join(',') : '')
    + '|T:' + transitions.map(t => t.id).join(',')
    + '|X:' + macros.map(m => m.id).join(',');
  if (root.dataset.sig !== sig) {
    root.dataset.sig = sig;
    root.innerHTML = headBody + controls;
  }
  const fill = root.querySelector('.dh-countfill');
  const num = root.querySelector('.dh-countnum');
  if (fill) fill.style.width = pct + '%';
  if (num) num.textContent = heldShot ? ''
    : (active ? (nextIn !== null ? `${nextIn.toFixed(1)}s` : (interval ? '' : '정지')) : '대기');
}

// "수동 고정" strip: [자동(룰)] + one button per transition.
function overrideStripHtml(transitions, pinTrans, heldShot) {
  const autoOn = !pinTrans && !heldShot;
  let html = '<div class="director-override"><span class="ov-label">수동 고정</span>'
    + `<button class="ov-btn ${autoOn ? 'ov-auto-on' : ''}" data-ov="auto">자동 (룰)</button>`;
  transitions.forEach(t => {
    const pinned = pinTrans === t.id;
    html += `<button class="ov-btn ${pinned ? 'ov-pinned' : ''}" data-ov="${escapeHtml(t.id)}">`
      + `${pinned ? '🔒 ' : ''}${escapeHtml(t.name || '(이름 없음)')}</button>`;
  });
  return html + '</div>';
}

// "수동 샷" palette: a switcher grid of every macro grouped by camera. Click a
// shot to take it live and hold; 해제 releases back to auto/rules.
function shotPaletteHtml(macros, heldShot) {
  let html = '<div class="director-shots"><div class="sh-head"><span class="ov-label">수동 샷</span>'
    + `<button class="sh-btn sh-release" data-shot="release">해제</button></div>`;
  if (!macros.length) {
    return html + '<span class="sh-empty">Macros 탭에서 매크로를 먼저 만드세요.</span></div>';
  }
  const byCam = {};
  macros.forEach(m => {
    const c = (m.camera === null || m.camera === undefined || m.camera === '') ? '' : String(m.camera);
    (byCam[c] = byCam[c] || []).push(m);
  });
  Object.keys(byCam).sort().forEach(c => {
    const color = cameraColor(c);
    html += `<div class="sh-camrow"><span class="sh-camlabel" style="color:${color}">${escapeHtml(camLabel(c))}</span>`;
    byCam[c].forEach(m => {
      const on = heldShot === m.id;
      const grp = m.group ? ` <span class="sh-grp">${escapeHtml(m.group)}</span>` : '';
      html += `<button class="sh-btn ${on ? 'sh-on' : ''}" data-shot="${escapeHtml(m.id)}" style="--cam:${color}">`
        + `${escapeHtml(m.name || m.token || m.id)}${grp}</button>`;
    });
    html += '</div>';
  });
  return html + '</div>';
}

function bindDirectorOverride() {
  const root = document.getElementById('director');
  if (!root) return;
  root.addEventListener('click', (e) => {
    const ov = e.target.closest('.ov-btn');
    if (ov) { setOverride(ov.dataset.ov === 'auto' ? null : ov.dataset.ov); return; }
    const sh = e.target.closest('.sh-btn');
    if (sh) { setShotOverride(sh.dataset.shot === 'release' ? null : sh.dataset.shot); return; }
  });
}

async function setOverride(transitionId) {
  try {
    await fetch('/api/override', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transition_id: transitionId }),
    });
    // The next WS tick refreshes the HUD (header + highlight).
  } catch { /* ignore */ }
}

async function setShotOverride(macroId) {
  try {
    await fetch('/api/override/shot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ macro_id: macroId }),
    });
  } catch { /* ignore */ }
}

function shotChip(shot, kind, badge) {
  const color = cameraColor(shot.camera);
  const grp = shot.group ? `<span class="sc-grp">${escapeHtml(shot.group)}</span>` : '';
  return `
    <span class="shot-chip sc-${kind}" style="--cam:${color}">
      ${badge ? `<span class="sc-badge">${escapeHtml(badge)}</span>` : ''}
      <span class="sc-cam">${escapeHtml(camLabel(shot.camera))}</span>
      <span class="sc-name">${escapeHtml(shot.name || shot.macro_id || '')}</span>
      ${grp}
    </span>`;
}

function bindAddRule() {
  document.getElementById('add-rule-btn').addEventListener('click', async () => {
    const res = await fetch('/api/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '새 룰' }),
    });
    if (!res.ok) { console.error(await res.text()); return; }
    await loadConfig();
    buildRules();
  });
}

async function updateRule(ruleId, body) {
  const res = await fetch(`/api/rules/${ruleId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) { console.error(await res.text()); return; }
  state.config = await res.json();
}

async function deleteRule(ruleId) {
  await fetch(`/api/rules/${ruleId}`, { method: 'DELETE' });
  await loadConfig();
  buildRules();
}

async function reorderRules(orderedIds) {
  const res = await fetch('/api/rules/reorder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order: orderedIds }),
  });
  if (!res.ok) { console.error(await res.text()); return; }
  state.config = await res.json();
}

function buildRules() {
  const root = document.getElementById('rules-list');
  root.innerHTML = '';
  const rules = (state.config.rules || []).slice().sort((a, b) =>
    (b.priority ?? 0) - (a.priority ?? 0)
  );

  if (!rules.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-rules';
    empty.textContent = '아직 룰이 없습니다. "+ 룰 추가" 버튼으로 첫 룰을 만들어보세요.';
    root.appendChild(empty);
    return;
  }

  rules.forEach(rule => root.appendChild(renderRuleCard(rule)));
}

function renderRuleCard(rule) {
  const card = document.createElement('div');
  card.className = 'rule-card' + (rule.enabled === false ? ' disabled-rule' : '');
  card.dataset.ruleId = rule.id;
  card.draggable = true;
  bindCardDrag(card);

  // Top row: handle, name, priority, active badge, enable toggle, up/down, delete
  const top = document.createElement('div');
  top.className = 'rule-card-top';

  const handle = document.createElement('div');
  handle.className = 'rule-card-handle';
  handle.title = '드래그해서 우선순위 변경';
  handle.appendChild(document.createElement('span'));

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'rule-card-name';
  nameInput.value = rule.name || '';
  nameInput.placeholder = '룰 이름';
  nameInput.addEventListener('change', () => updateRule(rule.id, {name: nameInput.value }));

  const actionsBar = document.createElement('div');
  actionsBar.className = 'rule-card-actions-bar';

  // Priority editor — inline number input. Higher = matches first AND can
  // preempt active rule's cooldown.
  const priWrap = document.createElement('span');
  priWrap.style.display = 'inline-flex';
  priWrap.style.alignItems = 'center';
  priWrap.style.gap = '2px';
  const priPrefix = document.createElement('span');
  priPrefix.className = 'rule-priority-prefix';
  priPrefix.textContent = 'P';
  const priInput = document.createElement('input');
  priInput.type = 'number';
  priInput.className = 'rule-priority-input';
  priInput.value = String(rule.priority ?? 0);
  priInput.min = '0'; priInput.max = '9999'; priInput.step = '10';
  priInput.title = '우선순위 — 높을수록 먼저 매칭되고, 현재 룰의 쿨다운도 즉시 무시하고 끼어듭니다';
  priInput.addEventListener('change', async () => {
    const v = parseInt(priInput.value);
    if (Number.isNaN(v)) return;
    await updateRule(rule.id, {priority: v });
    buildRules();  // re-sort by new priority
  });
  priWrap.append(priPrefix, priInput);

  const runBtn = document.createElement('button');
  runBtn.className = 'btn small btn-run';
  runBtn.textContent = '▶ 테스트';
  runBtn.title = '조건 무시하고 이 룰의 액션을 즉시 실행 (DRY/LIVE 모드는 그대로 따름)';
  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true;
    try {
      const res = await fetch(`/api/rules/${rule.id}/run`, { method: 'POST' });
      if (!res.ok) {
        alert('실행 실패: ' + await res.text());
        return;
      }
      // Brief visual ack — actual results show up in Activity Log via WS tick
      runBtn.textContent = '✓ 보냄';
      setTimeout(() => { runBtn.textContent = '▶ 테스트'; }, 900);
    } finally {
      runBtn.disabled = false;
    }
  });

  const enableBtn = document.createElement('button');
  enableBtn.className = 'btn small';
  enableBtn.textContent = rule.enabled === false ? '꺼짐' : 'ON';
  enableBtn.style.color = rule.enabled === false ? 'var(--muted)' : 'var(--green)';
  enableBtn.addEventListener('click', async () => {
    await updateRule(rule.id, {enabled: !(rule.enabled !== false) });
    buildRules();
  });

  const delBtn = document.createElement('button');
  delBtn.className = 'btn small danger';
  delBtn.textContent = '삭제';
  delBtn.addEventListener('click', async () => {
    if (!confirm(`"${rule.name}" 룰을 삭제할까요?`)) return;
    await deleteRule(rule.id);
  });

  actionsBar.append(priWrap, runBtn, enableBtn, delBtn);
  top.append(handle, nameInput, actionsBar);

  // Conditions section — tri-state group pills
  const condSection = document.createElement('div');
  condSection.className = 'rule-section';
  const condLabel = document.createElement('div');
  condLabel.className = 'rule-section-label';
  condLabel.textContent = 'IF — 그룹 클릭으로 토글: 활성 → 비활성 → 상관없음';
  condSection.appendChild(condLabel);
  condSection.appendChild(renderConditionPills(rule));

  // Actions section — transition (primary) + http_request (escape hatch).
  const actSection = document.createElement('div');
  actSection.className = 'rule-section';
  const actLabel = document.createElement('div');
  actLabel.className = 'rule-section-label';
  const assUrl = state.config.connections?.ass_http?.url || '';
  const assMethod = state.config.connections?.ass_http?.method || 'POST';
  actLabel.innerHTML = assUrl
    ? `THEN — 매칭 시 실행  &nbsp;<span class="ass-url-readonly">${assMethod} ${escapeHtml(assUrl)}</span>`
    : `THEN — <span style="color:var(--yellow)">Connections 탭에서 ASS HTTP URL을 먼저 설정하세요</span>`;
  actSection.appendChild(actLabel);

  const actRows = document.createElement('div');
  (rule.actions || []).forEach((a, i) => {
    if (a.type === 'transition') {
      actRows.appendChild(renderTransitionActionCard(rule, a, i));
    } else if (a.type === 'http_request') {
      actRows.appendChild(renderHttpActionCard(rule, a, i));
    }
  });
  actSection.appendChild(actRows);

  const addRow = document.createElement('div');
  addRow.className = 'action-add-row';
  const addTrans = document.createElement('button');
  addTrans.className = 'btn small primary';
  addTrans.textContent = '+ 트랜지션';
  addTrans.addEventListener('click', async () => {
    const next = [...(rule.actions || []), { type: 'transition', transition_id: '' }];
    await updateRule(rule.id, {actions: next });
    buildRules();
  });
  const addHttp = document.createElement('button');
  addHttp.className = 'btn small';
  addHttp.textContent = '+ HTTP (직접)';
  addHttp.addEventListener('click', async () => {
    const next = [...(rule.actions || []), { type: 'http_request', body: '' }];
    await updateRule(rule.id, {actions: next });
    buildRules();
  });
  addRow.append(addTrans, addHttp);
  actSection.appendChild(addRow);

  // Cooldown
  const cdRow = document.createElement('div');
  cdRow.className = 'rule-cooldown-row';
  const cdLabel = document.createElement('span');
  cdLabel.textContent = '쿨다운 (이 룰로 전환된 뒤 다른 룰로 못 넘어가는 시간)';
  const cdSlider = document.createElement('input');
  cdSlider.type = 'range';
  cdSlider.min = '0'; cdSlider.max = '30'; cdSlider.step = '0.5';
  cdSlider.value = String(rule.cooldown_s ?? 3.0);
  const cdReadout = document.createElement('span');
  cdReadout.className = 'ms-readout';
  const renderCd = () => { cdReadout.textContent = `${parseFloat(cdSlider.value).toFixed(1)} s`; };
  renderCd();
  cdSlider.addEventListener('input', renderCd);
  cdSlider.addEventListener('change', () => {
    updateRule(rule.id, {cooldown_s: parseFloat(cdSlider.value) });
  });
  cdRow.append(cdLabel, cdSlider, cdReadout);

  card.append(top, condSection, actSection, cdRow);
  return card;
}

// Tri-state pills. Conditions are derived from rule.conditions; a group not
// present in that array is "any" (don't care). Click cycles: any → active →
// inactive → any.
function renderConditionPills(rule) {
  const wrap = document.createElement('div');
  wrap.className = 'cond-pills';

  const conds = rule.conditions || [];
  const byGroup = {};
  for (const c of conds) byGroup[c.group] = c.state;

  const groupNames = Object.keys(state.config.groups);
  if (groupNames.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'cond-empty';
    empty.textContent = '먼저 Groups 탭에서 그룹을 만들어주세요.';
    wrap.appendChild(empty);
    return wrap;
  }

  // Live group activity (peak_db / active) for visual feedback — wired from
  // the latest WS tick via state.liveGroupState (populated below).
  const liveGroups = state.liveGroupState || {};

  groupNames.forEach(name => {
    const stateNow = byGroup[name];   // 'active' | 'inactive' | undefined
    const pill = document.createElement('button');
    pill.className = 'cond-pill';
    pill.dataset.group = name;
    if (stateNow === 'active')   pill.classList.add('cp-active');
    if (stateNow === 'inactive') pill.classList.add('cp-inactive');
    if (liveGroups[name]?.active) pill.classList.add('cp-live');

    const icon = document.createElement('span');
    icon.className = 'cp-icon';
    icon.textContent = stateNow === 'active'   ? '●'
                     : stateNow === 'inactive' ? '○'
                                                : '·';

    const label = document.createElement('span');
    label.className = 'cp-name';
    label.textContent = name;

    pill.append(icon, label);
    pill.title = ({
      active:   `"${name}" 그룹이 활성일 때 매칭. 클릭 → 비활성으로`,
      inactive: `"${name}" 그룹이 비활성일 때 매칭. 클릭 → 상관없음으로`,
    })[stateNow] || `"${name}" 그룹은 매칭에 영향 없음. 클릭 → 활성으로`;

    pill.addEventListener('click', async () => {
      // Cycle: any → active → inactive → any
      const cur = byGroup[name];
      const nextState = cur === 'active' ? 'inactive'
                       : cur === 'inactive' ? null
                       : 'active';
      const filtered = (rule.conditions || []).filter(c => c.group !== name);
      const next = nextState === null ? filtered
                   : [...filtered, { group: name, state: nextState }];
      await updateRule(rule.id, {conditions: next });
      buildRules();
    });

    wrap.appendChild(pill);
  });

  // Render any orphaned conditions (group deleted but condition still there)
  // so users can clean them up.
  for (const c of conds) {
    if (groupNames.includes(c.group)) continue;
    const pill = document.createElement('button');
    pill.className = 'cond-pill cp-orphan';
    pill.title = `존재하지 않는 그룹 — 클릭해서 제거`;
    pill.innerHTML = `<span class="cp-icon">⚠</span><span class="cp-name">${escapeHtml(c.group)}</span>`;
    pill.addEventListener('click', async () => {
      const next = (rule.conditions || []).filter(x => x.group !== c.group);
      await updateRule(rule.id, {conditions: next });
      buildRules();
    });
    wrap.appendChild(pill);
  }

  return wrap;
}

function renderConditionRow(rule, cond, idx) {
  const row = document.createElement('div');
  row.className = 'cond-row';

  const groupNames = Object.keys(state.config.groups);
  const groupSel = document.createElement('select');
  groupNames.forEach(g => {
    const o = document.createElement('option');
    o.value = g; o.textContent = g;
    groupSel.appendChild(o);
  });
  groupSel.value = cond.group || groupNames[0] || '';

  const stateSel = document.createElement('select');
  [['active', '활성'], ['inactive', '비활성']].forEach(([v, label]) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    stateSel.appendChild(o);
  });
  stateSel.value = cond.state || 'active';

  const glue = document.createElement('span');
  glue.className = 'glue-text';
  glue.textContent = idx === 0 ? 'if' : 'and';

  const isText = document.createElement('span');
  isText.className = 'glue-text';
  isText.textContent = '이/가';

  const delBtn = document.createElement('button');
  delBtn.className = 'btn small danger';
  delBtn.textContent = '×';
  delBtn.title = '조건 삭제';

  const commit = () => {
    const next = (rule.conditions || []).slice();
    next[idx] = { group: groupSel.value, state: stateSel.value };
    updateRule(rule.id, {conditions: next });
  };
  groupSel.addEventListener('change', commit);
  stateSel.addEventListener('change', commit);

  delBtn.addEventListener('click', async () => {
    const next = (rule.conditions || []).slice();
    next.splice(idx, 1);
    await updateRule(rule.id, {conditions: next });
    buildRules();
  });

  row.append(glue, groupSel, isText, stateSel, delBtn);
  return row;
}

// Small text-input helper (re-added; the old generic one was removed with the
// legacy action editor).
function textInput(placeholder, value) {
  const i = document.createElement('input');
  i.type = 'text';
  i.placeholder = placeholder;
  i.value = value || '';
  return i;
}

// ── Macros / Transitions: shared API + view refresh ───────────────
async function apiSend(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    alert('실패: ' + (await res.text()));
    throw new Error('api ' + res.status);
  }
  return res.status === 200 ? res.json().catch(() => null) : null;
}

// Macros/transitions/rules are interdependent (macro→deck→rule), so a change
// to any of them refreshes all three editors plus the monitor pills.
async function refreshShotViews() {
  await loadConfig();
  buildMacros();
  buildTransitions();
  buildRules();
}

function bindShotButtons() {
  const am = document.getElementById('add-macro-btn');
  if (am) am.addEventListener('click', createMacro);
  const at = document.getElementById('add-transition-btn');
  if (at) at.addEventListener('click', createTransition);
}

async function createMacro() {
  await apiSend('POST', '/api/macros', { name: '', token: '', camera: '' });
  await refreshShotViews();
}
async function updateMacro(id, patch) {
  await apiSend('PUT', `/api/macros/${encodeURIComponent(id)}`, patch);
  await refreshShotViews();
}
async function deleteMacro(id) {
  await apiSend('DELETE', `/api/macros/${encodeURIComponent(id)}`);
  await refreshShotViews();
}
async function createTransition() {
  await apiSend('POST', '/api/transitions',
    { name: '', deck: [], interval_s: 8, camera_alternate: true });
  await refreshShotViews();
}
async function updateTransition(id, patch) {
  await apiSend('PUT', `/api/transitions/${encodeURIComponent(id)}`, patch);
  await refreshShotViews();
}
async function deleteTransition(id) {
  await apiSend('DELETE', `/api/transitions/${encodeURIComponent(id)}`);
  await refreshShotViews();
}

// ── Macros tab ────────────────────────────────────────────────────
function buildMacros() {
  const root = document.getElementById('macros-table');
  if (!root) return;
  root.innerHTML = '';
  const macros = state.config.macros || [];
  if (!macros.length) {
    root.innerHTML = '<div class="empty-hint">아직 매크로가 없습니다. 아래 버튼으로 추가하세요.</div>';
    return;
  }
  const head = document.createElement('div');
  head.className = 'macro-row macro-head';
  head.innerHTML =
    '<span>샷 이름</span><span>토큰 (ASS로 보낼 payload)</span><span>카메라</span>'
    + '<span>그룹 (피사체)</span><span>소스 (동적 · 오디오 그룹)</span><span></span>';
  root.appendChild(head);

  // Free-form group suggestions: groups already used on macros + channel
  // group names (as a convenience), but the field accepts any text.
  const sugg = new Set();
  (state.config.macros || []).forEach(m => { if (m.group) sugg.add(m.group); });
  Object.keys(state.config.roles || {}).forEach(r => sugg.add(r));
  Object.keys(state.config.groups || {}).forEach(g => sugg.add(g));
  let dl = document.getElementById('macro-group-suggest');
  if (!dl) { dl = document.createElement('datalist'); dl.id = 'macro-group-suggest'; document.body.appendChild(dl); }
  dl.innerHTML = '';
  [...sugg].sort().forEach(g => { const o = document.createElement('option'); o.value = g; dl.appendChild(o); });

  macros.forEach(m => root.appendChild(renderMacroRow(m)));
}

function renderMacroRow(m) {
  const row = document.createElement('div');
  row.className = 'macro-row';

  const name = textInput('예: Person A', m.name || '');
  name.addEventListener('change', () => updateMacro(m.id, { name: name.value }));

  const token = textInput('예: personA', m.token || '');
  token.addEventListener('change', () => updateMacro(m.id, { token: token.value }));

  const cam = document.createElement('input');
  cam.type = 'text';
  cam.className = 'macro-cam';
  cam.placeholder = '1';
  cam.value = (m.camera === null || m.camera === undefined) ? '' : String(m.camera);
  cam.addEventListener('change', () => updateMacro(m.id, { camera: cam.value }));

  // Group: free-form visual-subject tag for the "그룹 교대" anti-repeat option.
  // Independent of channel groups — tag at whatever granularity you want
  // (e.g. per-singer "Singer1"/"Singer2", or one "PIANO" for piano angles).
  const grp = textInput('예: Singer1, PIANO', m.group || '');
  grp.className = 'macro-group';
  grp.setAttribute('list', 'macro-group-suggest');
  grp.addEventListener('change', () => updateMacro(m.id, { group: grp.value.trim() || null }));

  // Sources: which ROLES (fine subject) or GROUPS (coarse) surface this shot in
  // dynamic mode. A role source → shows only when that role's channel is live;
  // a group source → whenever any member is live. Empty = never auto-planned.
  const sources = document.createElement('div');
  sources.className = 'macro-sources';
  const cur = new Set(m.sources || []);
  const roleEntries = Object.entries(state.config.roles || {}); // [name, {group,color}]
  const groupNames = Object.keys(state.config.groups || {});

  const addChip = (key, color, kind) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'ms-chip ms-' + kind + (cur.has(key) ? ' on' : '');
    chip.textContent = key;
    if (cur.has(key) && color) { chip.style.background = color; chip.style.borderColor = color; }
    chip.addEventListener('click', () => {
      const next = new Set(m.sources || []);
      const on = !next.has(key);
      on ? next.add(key) : next.delete(key);
      m.sources = [...next];               // optimistic local update
      updateMacro(m.id, { sources: m.sources });
      chip.classList.toggle('on', on);
      chip.style.background = on && color ? color : '';
      chip.style.borderColor = on && color ? color : '';
    });
    return chip;
  };

  if (!roleEntries.length && !groupNames.length) {
    const hint = document.createElement('span');
    hint.className = 'ms-empty';
    hint.textContent = 'Groups 탭에서 그룹·역할 먼저';
    sources.appendChild(hint);
  } else {
    roleEntries.forEach(([rn, r]) => sources.appendChild(addChip(rn, r.color, 'role')));
    if (roleEntries.length && groupNames.length) {
      const div = document.createElement('span');
      div.className = 'ms-div';
      sources.appendChild(div);
    }
    groupNames.forEach(g => sources.appendChild(addChip(g, (state.config.groups[g] || {}).color, 'group')));
  }

  const del = document.createElement('button');
  del.className = 'btn small danger';
  del.textContent = '삭제';
  del.addEventListener('click', async () => {
    if (!confirm(`매크로 "${m.name || m.token || m.id}" 삭제? (덱에서도 빠집니다)`)) return;
    await deleteMacro(m.id);
  });

  row.append(name, token, cam, grp, sources, del);
  return row;
}

// ── Transitions tab ───────────────────────────────────────────────
function buildTransitions() {
  const root = document.getElementById('transitions-list');
  if (!root) return;
  root.innerHTML = '';
  const transitions = state.config.transitions || [];
  if (!transitions.length) {
    root.innerHTML = '<div class="empty-hint">아직 트랜지션이 없습니다. 아래 버튼으로 추가하세요.</div>';
    return;
  }
  transitions.forEach(t => root.appendChild(renderTransitionCard(t)));
}

function renderTransitionCard(t) {
  const macros = state.config.macros || [];
  const macroById = Object.fromEntries(macros.map(m => [m.id, m]));
  const card = document.createElement('div');
  card.className = 'transition-card';

  // Header: name + delete
  const head = document.createElement('div');
  head.className = 'transition-head';
  const name = textInput('트랜지션 이름 (예: All Rotate)', t.name || '');
  name.className = 'transition-name';
  name.addEventListener('change', () => updateTransition(t.id, { name: name.value }));
  const del = document.createElement('button');
  del.className = 'btn small danger';
  del.textContent = '삭제';
  del.addEventListener('click', async () => {
    if (!confirm(`트랜지션 "${t.name || t.id}" 삭제? (이 트랜지션을 쓰는 룰 액션에서도 빠집니다)`)) return;
    await deleteTransition(t.id);
  });
  head.append(name, del);

  // Deck: macro chips + add dropdown. deck[0] = the "opening" shot played
  // first whenever this transition activates (rule change).
  const deckLabel = document.createElement('div');
  deckLabel.className = 'deck-label';
  deckLabel.innerHTML = `덱 (${(t.deck || []).length}장) — 룰 전환 시 <b>첫 장(★)</b>으로 진입 후 카메라 교대 회전`;

  const deckWrap = document.createElement('div');
  deckWrap.className = 'deck-wrap';
  (t.deck || []).forEach((mid, i) => {
    const m = macroById[mid];
    const chip = document.createElement('span');
    chip.className = 'deck-chip' + (m ? '' : ' missing') + (i === 0 ? ' opening' : '');
    if (m) chip.style.setProperty('--cam', cameraColor(m.camera));
    if (i === 0) {
      const star = document.createElement('span');
      star.className = 'dc-open';
      star.title = '첫 화면 (룰 전환 시 여기로 진입)';
      star.textContent = '★';
      chip.appendChild(star);
    }
    const label = document.createElement('span');
    label.className = 'dc-name';
    label.textContent = m ? (m.name || m.token || mid) : '(삭제됨)';
    chip.appendChild(label);
    if (m && m.camera !== null && m.camera !== undefined && m.camera !== '') {
      const camTag = document.createElement('span');
      camTag.className = 'dc-cam';
      camTag.textContent = 'cam' + m.camera;
      chip.appendChild(camTag);
    }
    if (i > 0) {
      const up = document.createElement('button');
      up.className = 'dc-first';
      up.textContent = '★';
      up.title = '이 장을 첫 화면으로';
      up.addEventListener('click', () => {
        const next = (t.deck || []).slice();
        const [picked] = next.splice(i, 1);
        next.unshift(picked);
        updateTransition(t.id, { deck: next });
      });
      chip.appendChild(up);
    }
    const x = document.createElement('button');
    x.className = 'dc-x';
    x.textContent = '×';
    x.title = '덱에서 제거';
    x.addEventListener('click', () => {
      const next = (t.deck || []).slice();
      next.splice(i, 1);
      updateTransition(t.id, { deck: next });
    });
    chip.appendChild(x);
    deckWrap.appendChild(chip);
  });

  if (macros.length) {
    const add = document.createElement('select');
    add.className = 'deck-add';
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = '+ 매크로';
    add.appendChild(ph);
    macros.forEach(m => {
      const o = document.createElement('option');
      o.value = m.id;
      const cam = (m.camera !== null && m.camera !== undefined && m.camera !== '') ? ` (cam${m.camera})` : '';
      o.textContent = (m.name || m.token || m.id) + cam;
      add.appendChild(o);
    });
    add.addEventListener('change', () => {
      if (!add.value) return;
      const next = [...(t.deck || []), add.value];
      updateTransition(t.id, { deck: next });
    });
    deckWrap.appendChild(add);
  } else {
    const warn = document.createElement('span');
    warn.className = 'deck-warn';
    warn.textContent = '먼저 Macros 탭에서 매크로를 만드세요.';
    deckWrap.appendChild(warn);
  }

  // Params: interval + camera alternate
  const params = document.createElement('div');
  params.className = 'transition-params';
  params.appendChild(paramNum('로테이션 간격', t.interval_s ?? 8, 0, 120, 0.5, 's',
    v => updateTransition(t.id, { interval_s: v })));
  const altLabel = document.createElement('label');
  altLabel.className = 'alt-toggle';
  const alt = document.createElement('input');
  alt.type = 'checkbox';
  alt.checked = t.camera_alternate !== false;
  alt.addEventListener('change', () => updateTransition(t.id, { camera_alternate: alt.checked }));
  altLabel.append(alt, document.createTextNode(' 카메라 교대'));
  params.appendChild(altLabel);

  const grpLabel = document.createElement('label');
  grpLabel.className = 'alt-toggle';
  grpLabel.title = '같은 그룹(피사체)인 샷이 연속으로 나오지 않게 (예: 피아노 → 피아노 방지)';
  const grpAlt = document.createElement('input');
  grpAlt.type = 'checkbox';
  grpAlt.checked = t.group_alternate === true;
  grpAlt.addEventListener('change', () => updateTransition(t.id, { group_alternate: grpAlt.checked }));
  grpLabel.append(grpAlt, document.createTextNode(' 그룹 교대'));
  params.appendChild(grpLabel);

  const hint = document.createElement('div');
  hint.className = 'transition-hint';
  hint.textContent = (t.interval_s ?? 8) <= 0
    ? '간격 0 = 회전 없음 (덱 첫 장을 정적으로 유지)'
    : '';

  // Camera weights — how many times each camera appears per round. Only
  // meaningful with 카메라 교대 on; lets a camera with more scenes get more
  // airtime so its scenes aren't starved.
  const weightsBox = (t.camera_alternate !== false)
    ? renderCameraWeights(t, macroById)
    : null;

  // Preview strip: a representative upcoming sequence (opening first).
  const previewWrap = document.createElement('div');
  previewWrap.className = 'transition-preview';
  const pvLabel = document.createElement('div');
  pvLabel.className = 'pv-label';
  pvLabel.textContent = '예상 순서';
  const pvStrip = document.createElement('div');
  pvStrip.className = 'pv-strip';
  pvStrip.textContent = '…';
  previewWrap.append(pvLabel, pvStrip);
  loadTransitionPreview(t.id, pvStrip);

  card.append(head, deckLabel, deckWrap, params, hint);
  if (weightsBox) card.append(weightsBox);
  card.append(previewWrap);
  return card;
}

// Per-camera weight controls: each distinct camera in the deck gets a weight
// (times per round) plus its scene count and resulting airtime %.
function renderCameraWeights(t, macroById) {
  const counts = {};
  (t.deck || []).forEach(id => {
    const m = macroById[id];
    if (!m) return;
    const c = (m.camera === null || m.camera === undefined) ? '' : String(m.camera);
    if (c !== '') counts[c] = (counts[c] || 0) + 1;
  });
  const cams = Object.keys(counts);
  if (cams.length < 2) return null;  // weighting only matters with ≥2 cameras

  const weights = t.camera_weights || {};
  const wOf = c => Math.max(1, parseInt(weights[c] ?? 1, 10) || 1);
  const sum = cams.reduce((a, c) => a + wOf(c), 0) || 1;

  const box = document.createElement('div');
  box.className = 'cam-weights';

  const label = document.createElement('div');
  label.className = 'cw-label';
  label.innerHTML = '카메라 가중치 <span class="cw-sub">— 한 바퀴에 각 카메라가 몇 번 (컷 많은 카메라를 높게)</span>';
  box.appendChild(label);

  const row = document.createElement('div');
  row.className = 'cw-row';

  const setWeight = (c, w) => {
    const next = { ...(t.camera_weights || {}) };
    next[c] = Math.max(1, w | 0);
    updateTransition(t.id, { camera_weights: next });
  };

  let maxShare = 0;
  cams.forEach(c => {
    const share = wOf(c) / sum;
    maxShare = Math.max(maxShare, share);
    const cell = document.createElement('div');
    cell.className = 'cw-cell';
    cell.style.setProperty('--cam', cameraColor(c));
    const cap = document.createElement('div');
    cap.className = 'cw-cap';
    cap.innerHTML = `<span class="cw-name">CAM ${escapeHtml(c)}</span>`
                  + `<span class="cw-scenes">${counts[c]}컷</span>`;
    const ctl = document.createElement('div');
    ctl.className = 'cw-ctl';
    const inp = document.createElement('input');
    inp.type = 'number'; inp.min = '1'; inp.max = '20'; inp.value = String(wOf(c));
    inp.addEventListener('change', () => setWeight(c, parseInt(inp.value, 10)));
    const pct = document.createElement('span');
    pct.className = 'cw-pct';
    pct.textContent = `${Math.round(share * 100)}%`;
    ctl.append(inp, pct);
    cell.append(cap, ctl);
    row.appendChild(cell);
  });
  box.appendChild(row);

  // Convenience: set weights = scene counts (per-scene fair airtime).
  const actions = document.createElement('div');
  actions.className = 'cw-actions';
  const autoBtn = document.createElement('button');
  autoBtn.className = 'btn small';
  autoBtn.textContent = '컷 수에 맞춰 자동';
  autoBtn.title = '각 카메라 가중치를 컷(씬) 개수로 설정 → 모든 컷이 비슷한 빈도로 노출';
  autoBtn.addEventListener('click', () => updateTransition(t.id, { camera_weights: { ...counts } }));
  const resetBtn = document.createElement('button');
  resetBtn.className = 'btn small';
  resetBtn.textContent = '균등';
  resetBtn.title = '모든 카메라 가중치 1 (카메라마다 동일 빈도)';
  resetBtn.addEventListener('click', () => {
    const eq = {}; cams.forEach(c => eq[c] = 1);
    updateTransition(t.id, { camera_weights: eq });
  });
  actions.append(autoBtn, resetBtn);
  box.appendChild(actions);

  if (maxShare > 0.5 + 1e-9) {
    const warn = document.createElement('div');
    warn.className = 'cw-warn';
    warn.textContent = '⚠ 한 카메라가 50%를 넘어 같은 카메라가 연속으로 나올 수 있습니다.';
    box.appendChild(warn);
  }
  return box;
}

async function loadTransitionPreview(transitionId, stripEl) {
  try {
    const res = await fetch(`/api/transitions/${encodeURIComponent(transitionId)}/preview?n=12`);
    if (!res.ok) { stripEl.textContent = '(미리보기 불가)'; return; }
    const data = await res.json();
    const seq = data.sequence || [];
    if (!seq.length) { stripEl.textContent = '(덱이 비어 있음)'; return; }
    stripEl.innerHTML = seq.map((s, i) => {
      const color = cameraColor(s.camera);
      const open = s.opening ? '<span class="pv-open">★</span>' : '';
      const grp = s.group ? `<span class="pv-grp">${escapeHtml(s.group)}</span>` : '';
      return `<span class="pv-chip" style="--cam:${color}">${open}`
           + `<span class="pv-cam">${escapeHtml(camLabel(s.camera))}</span>`
           + `<span class="pv-name">${escapeHtml(s.name || s.macro_id || '')}</span>${grp}</span>`
           + (i < seq.length - 1 ? '<span class="pv-arrow">›</span>' : '');
    }).join('');
  } catch {
    stripEl.textContent = '(미리보기 불가)';
  }
}

function paramNum(label, value, min, max, step, unit, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'param-num';
  const l = document.createElement('span');
  l.className = 'param-label';
  l.textContent = label;
  const inp = document.createElement('input');
  inp.type = 'number';
  inp.min = String(min); inp.max = String(max); inp.step = String(step);
  inp.value = String(value);
  inp.addEventListener('change', () => onChange(parseFloat(inp.value)));
  const u = document.createElement('span');
  u.className = 'param-unit';
  u.textContent = unit;
  wrap.append(l, inp, u);
  return wrap;
}

// Rule action card: pick a transition from the library.
function renderTransitionActionCard(rule, action, idx) {
  const card = document.createElement('div');
  card.className = 'transition-action-card';
  const transitions = state.config.transitions || [];

  const sel = document.createElement('select');
  sel.className = 'transition-action-sel';
  const ph = document.createElement('option');
  ph.value = '';
  ph.textContent = transitions.length ? '트랜지션 선택…' : '(트랜지션 없음 — Transitions 탭에서 먼저 생성)';
  sel.appendChild(ph);
  transitions.forEach(t => {
    const o = document.createElement('option');
    o.value = t.id;
    o.textContent = `${t.name || '(이름 없음)'} · ${(t.deck || []).length}장 · ${t.interval_s}s`;
    sel.appendChild(o);
  });
  sel.value = action.transition_id || '';
  sel.addEventListener('change', () => {
    const next = (rule.actions || []).slice();
    next[idx] = { type: 'transition', transition_id: sel.value };
    updateRule(rule.id, { actions: next });
  });

  const del = document.createElement('button');
  del.className = 'btn small danger';
  del.textContent = '×';
  del.title = '이 액션 삭제';
  del.addEventListener('click', async () => {
    const next = (rule.actions || []).slice();
    next.splice(idx, 1);
    await updateRule(rule.id, { actions: next });
    buildRules();
  });

  card.append(sel, del);
  return card;
}

// Simplified action card: body-only. The URL/method come from the global
// connections.ass_http config and are shown read-only in the section header.
function renderHttpActionCard(rule, action, idx) {
  const card = document.createElement('div');
  card.className = 'http-action-card';

  const bodyIn = document.createElement('textarea');
  bodyIn.className = 'http-action-body';
  bodyIn.rows = 2;
  bodyIn.placeholder = '{"name":"pastor_active"}';
  bodyIn.value = action.body || '';
  bodyIn.addEventListener('change', () => {
    const next = (rule.actions || []).slice();
    next[idx] = { ...next[idx], type: 'http_request', body: bodyIn.value };
    updateRule(rule.id, {actions: next });
  });

  const del = document.createElement('button');
  del.className = 'btn small danger';
  del.textContent = '×';
  del.title = '이 액션 삭제';
  del.addEventListener('click', async () => {
    const next = (rule.actions || []).slice();
    next.splice(idx, 1);
    await updateRule(rule.id, {actions: next });
    buildRules();
  });

  card.append(bodyIn, del);
  return card;
}

// Drag-and-drop reordering
let dragSrcId = null;
function bindCardDrag(card) {
  card.addEventListener('dragstart', (e) => {
    dragSrcId = card.dataset.ruleId;
    card.style.opacity = '0.4';
    e.dataTransfer.effectAllowed = 'move';
  });
  card.addEventListener('dragend', () => {
    dragSrcId = null;
    card.style.opacity = '';
  });
  card.addEventListener('dragover', (e) => {
    if (!dragSrcId || dragSrcId === card.dataset.ruleId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  });
  card.addEventListener('drop', async (e) => {
    e.preventDefault();
    if (!dragSrcId || dragSrcId === card.dataset.ruleId) return;
    const root = document.getElementById('rules-list');
    const ids = [...root.querySelectorAll('.rule-card')].map(c => c.dataset.ruleId);
    const fromIdx = ids.indexOf(dragSrcId);
    const toIdx = ids.indexOf(card.dataset.ruleId);
    ids.splice(fromIdx, 1);
    ids.splice(toIdx, 0, dragSrcId);
    await reorderRules(ids);
    buildRules();
  });
}

// ── Connections form ─────────────────────────────────────────────
function buildConnections() {
  const ass = state.config.connections?.ass_http || { url: '', method: 'POST' };
  document.getElementById('ass-http-url').value = ass.url || '';
  document.getElementById('ass-http-method').value = ass.method === 'GET' ? 'GET' : 'POST';
}

function bindConnectionsForm() {
  document.getElementById('ass-http-save-btn').addEventListener('click', async () => {
    const url = document.getElementById('ass-http-url').value.trim();
    const method = document.getElementById('ass-http-method').value;
    const res = await fetch('/api/connections/ass_http', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, method }),
    });
    if (!res.ok) {
      alert('저장 실패: ' + await res.text());
      return;
    }
    await loadConfig();
    buildRules();  // action card shows the URL — refresh
  });
}

// ── Project switcher ─────────────────────────────────────────────
function renderProjectPill() {
  const el = document.getElementById('project-current');
  if (el) el.textContent = state.config?.current_project || '—';
}

function bindProjectPill() {
  const pill = document.getElementById('project-pill');
  const menu = document.getElementById('project-menu');
  pill.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!menu.classList.contains('hidden')) {
      menu.classList.add('hidden');
      return;
    }
    await openProjectMenu();
  });
  // Click-away closes the menu
  document.addEventListener('click', (e) => {
    if (menu.classList.contains('hidden')) return;
    if (!menu.contains(e.target) && e.target !== pill) {
      menu.classList.add('hidden');
    }
  });
}

async function openProjectMenu() {
  const menu = document.getElementById('project-menu');
  menu.innerHTML = '<div class="pm-section">불러오는 중…</div>';
  menu.classList.remove('hidden');
  let info;
  try {
    info = await (await fetch('/api/projects')).json();
  } catch {
    menu.innerHTML = '<div class="pm-section">로드 실패</div>';
    return;
  }
  renderProjectMenu(info);
}

function renderProjectMenu(info) {
  const menu = document.getElementById('project-menu');
  const current = info.current;
  const projects = info.projects || [];
  menu.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'pm-section';
  header.textContent = '프로젝트';
  menu.appendChild(header);

  projects.forEach(p => {
    const row = document.createElement('div');
    row.className = 'pm-item' + (p.name === current ? ' current' : '');

    const name = document.createElement('span');
    name.className = 'pm-name';
    name.textContent = p.name;
    const meta = document.createElement('span');
    meta.className = 'pm-meta';
    meta.textContent = `${p.channel_count}ch · ${p.group_count}g · ${p.rule_count}r`;

    // Activate: clicking the row (not the action buttons) switches.
    row.addEventListener('click', async (e) => {
      if (e.target.closest('.pm-item-btn')) return;
      if (p.name === current) return;
      await activateProject(p.name);
    });

    const renameBtn = document.createElement('button');
    renameBtn.className = 'pm-item-btn';
    renameBtn.title = '이름 변경';
    renameBtn.textContent = '✏️';
    renameBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const next = prompt(`"${p.name}" 의 새 이름:`, p.name);
      if (!next || next === p.name) return;
      await renameProject(p.name, next);
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'pm-item-btn danger';
    delBtn.title = p.name === current ? '활성 프로젝트는 삭제 불가' : '삭제';
    delBtn.textContent = '🗑';
    delBtn.disabled = (p.name === current || projects.length <= 1);
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`프로젝트 "${p.name}" 을(를) 삭제할까요?`)) return;
      await deleteProject(p.name);
    });

    row.append(name, meta, renameBtn, delBtn);
    menu.appendChild(row);
  });

  menu.appendChild(Object.assign(document.createElement('div'), { className: 'pm-divider' }));

  const newEmpty = document.createElement('div');
  newEmpty.className = 'pm-action';
  newEmpty.textContent = '＋ 빈 프로젝트 새로 만들기';
  newEmpty.addEventListener('click', () => createProjectPrompt(false));
  menu.appendChild(newEmpty);

  const newCopy = document.createElement('div');
  newCopy.className = 'pm-action';
  newCopy.textContent = `＋ "${current}" 복제해서 새 프로젝트`;
  newCopy.addEventListener('click', () => createProjectPrompt(true));
  menu.appendChild(newCopy);
}

async function createProjectPrompt(copyFromCurrent) {
  const name = prompt(copyFromCurrent
    ? '현재 프로젝트를 복제할 새 이름:'
    : '새 프로젝트 이름:');
  if (!name) return;
  const body = copyFromCurrent
    ? { name, copy_from: state.config?.current_project }
    : { name };
  const res = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    alert('생성 실패: ' + (await res.text()));
    return;
  }
  await openProjectMenu();
}

async function activateProject(name) {
  const res = await fetch(`/api/projects/${encodeURIComponent(name)}/activate`, {
    method: 'POST',
  });
  if (!res.ok) {
    alert('전환 실패: ' + (await res.text()));
    return;
  }
  document.getElementById('project-menu').classList.add('hidden');
  await rebuildAll();
}

async function renameProject(oldName, newName) {
  const res = await fetch(`/api/projects/${encodeURIComponent(oldName)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ new_name: newName }),
  });
  if (!res.ok) {
    alert('이름 변경 실패: ' + (await res.text()));
    return;
  }
  // If we renamed the active project the global pointer also changed.
  await loadConfig();
  renderProjectPill();
  await openProjectMenu();
}

async function deleteProject(name) {
  const res = await fetch(`/api/projects/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    alert('삭제 실패: ' + (await res.text()));
    return;
  }
  await openProjectMenu();
}

boot();

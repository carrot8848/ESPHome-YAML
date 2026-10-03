/**
 * 电量计量模块仪表盘（BL0906/BL0910，6/10/16/3x6 通道通用）
 *
 * 由 web_server 的 js_include 编译进固件（/0.js，ES module），离线可用。
 * 完全替换官方 v3 前端（<esp-app> 不加载即渲染为空）。
 *
 * 数据：GET /events (SSE) —— ping / state / log 事件
 * 控制：POST /switch/{名}/turn_on|turn_off、/button/{名}/press、/number/{名}/set?value=
 * 解析：分组名按 sorting_group 模式匹配；通道识别用「序数配对」（各类别分组内
 *       位次相同 = 同一通道，不依赖实体名，通道名可任意自定义）。
 */
'use strict';

/* ---------- 小工具 ---------- */
const $ = (s, r) => (r || document).querySelector(s);
const enc = encodeURIComponent;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const DANGER_RE = /重启|恢复出厂|清空|清零|删除|格式化/;
const collator = new Intl.Collator('zh-Hans-CN', { numeric: true });

function fmtUptime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400);
  const h = String(Math.floor((sec % 86400) / 3600)).padStart(2, '0');
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return (d ? d + '天 ' : '') + h + ':' + m + ':' + s;
}

/* 去掉实体名前缀的节点名（如 "6-ch-mon-v3_2-prebuilt XXX" → "XXX"） */
function displayName(name) {
  const m = name.match(/^([\w-]+)\s+(.+)$/);
  return m && /[-_]/.test(m[1]) ? m[2] : name;
}

/* 把 state 字符串按 uom 拆成 数值 + 单位（"227.9 V" → v:"227.9", u:"V"） */
function splitState(e) {
  const s = e && e.state != null ? String(e.state) : '--';
  if (e && e.uom && s.endsWith(e.uom)) {
    return { v: s.slice(0, -e.uom.length).trim() || '--', u: e.uom };
  }
  return { v: s, u: '' };
}

/* 校准状态判断：仅精确的 Calibrated 视为已校准，其余状态一律红色警示 */
const isCalibrated = (e) =>
  /^calibrated$/i.test(String((e && (e.value ?? e.state)) ?? '').trim());
/* 全部校准状态实体（多芯片固件每颗芯片一个，按名称排序保证顺序稳定） */
const calibrationEnts = () =>
  [...ents.values()].filter((e) => /校准状态|Calibration Status/i.test(e.name)).sort(byName);

/* ---------- 运行状态 ---------- */
const ents = new Map();   // id -> 实体（SSE state 首包为完整定义，后续只有 value/state）
const history = [];       // 总功率历史（趋势线）
const chHist = new Map(); // 各通道功率历史：key -> 数组（趋势图）
const MAX_HISTORY = 240;
let meta = { title: '电量计量模块', uptime: null };
let online = false;
let lastPing = 0;
let rafPending = false;

/* ---------- 页面骨架 ---------- */
document.body.innerHTML = `
<div class="wrap">
  <header>
    <div>
      <h1 id="h-title">电量计量模块</h1>
      <div class="sub">
        <span class="dot" id="h-dot"></span>
        <span id="h-conn">连接中…</span>
        <span class="sep">·</span>
        <span id="h-uptime">运行 --</span>
      </div>
    </div>
    <div class="head-actions">
      <div class="head-badge" id="h-badge">ENERGY METER</div>
      <button class="theme-btn" id="h-theme" type="button" title="切换明暗主题"></button>
    </div>
  </header>
  <div class="card pad muted" id="loading">正在连接设备…</div>
  <main id="main" hidden>
    <div class="chips" id="chips"></div>
    <section class="card hero">
      <div class="hero-top">
        <div class="hero-num">
          <div class="label" id="tp-label">总功率</div>
          <div class="big"><span id="tp-v">--</span><span class="uom" id="tp-u"></span></div>
        </div>
        <div class="spark-box"><canvas id="spark"></canvas></div>
      </div>
      <div class="energy" id="energy"></div>
    </section>
    <section class="grid" id="channels"></section>
    <div class="sec-title">通道功率趋势</div>
    <section class="charts" id="charts"></section>
    <details class="card fold">
      <summary>维护与诊断</summary>
      <div class="fold-body" id="maint"></div>
    </details>
    <details class="card fold">
      <summary>运行日志</summary>
      <div class="fold-body"><div class="logs" id="logs"></div></div>
    </details>
  </main>
</div>
<div id="modal" hidden>
  <div class="modal-card">
    <div id="modal-msg"></div>
    <div class="modal-btns">
      <button class="btn" id="modal-no">取消</button>
      <button class="btn danger" id="modal-yes">确认执行</button>
    </div>
  </div>
</div>`;

const refs = {};
['h-title', 'h-dot', 'h-conn', 'h-uptime', 'h-theme', 'h-badge', 'loading', 'main', 'chips',
  'tp-v', 'tp-u', 'tp-label', 'spark', 'energy', 'channels', 'charts', 'maint', 'logs',
  'modal', 'modal-msg', 'modal-yes', 'modal-no',
].forEach((id) => { refs[id] = document.getElementById(id); });

/* ---------- 明暗主题切换 ---------- */
const THEME_KEY = 'dch-scheme';
const SUN_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

function applyScheme(s, save) {
  document.documentElement.dataset.scheme = s;
  if (save) { try { localStorage.setItem(THEME_KEY, s); } catch { /* 忽略 */ } }
  refs['h-theme'].innerHTML = s === 'dark' ? SUN_SVG : MOON_SVG;
  refs['h-theme'].title = s === 'dark' ? '当前深色，点击切换浅色' : '当前浅色，点击切换深色';
  schedule(); // canvas 颜色取自 CSS 变量，切主题后需重绘
}

refs['h-theme'].addEventListener('click', () => {
  applyScheme(document.documentElement.dataset.scheme === 'dark' ? 'light' : 'dark', true);
});

/* 初始化：优先用上次记住的选择，否则跟随系统 */
(function initScheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch { /* 忽略 */ }
  const sys = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  applyScheme(saved === 'light' || saved === 'dark' ? saved : sys, false);
})();

/* ---------- 实体查询 ---------- */
const byName = (a, b) => collator.compare(a.name, b.name);
/* 分组类别按组名模式匹配，兼容各固件的分组命名：
 * 6/10ch:「电流」「功率」「电量」「今日电量」…「6通道总和/10通道总和」
 * 16ch:  同上，总和为「通道总和」
 * 3x6ch: 按相分组「A相电流」「A相功率」「A相今日电量」…「各路总和」          */
const GRP = {
  sum: (g) => /总和$/.test(g),
  current: (g) => /电流$/.test(g),
  power: (g) => /功率$/.test(g),
  energy: (g) => /电量$/.test(g) && !/今日|昨日|本周|本月|今年/.test(g),
  today: (g) => /今日/.test(g),
  yesterday: (g) => /昨日/.test(g),
  week: (g) => /本周/.test(g),
  month: (g) => /本月/.test(g),
  year: (g) => /今年/.test(g),
};
const entsOf = (pred) =>
  [...ents.values()].filter((e) => pred(e.sorting_group || '')).sort(byName);
const inGroup = (g) => entsOf((x) => x === g);
/* ---------- 通道识别：序数配对（不依赖实体名，通道名可任意自定义） ----------
 * 首包到达顺序 = yaml 声明顺序；每通道的电流/功率/电量实体按通道次序声明，
 * 因此各类别分组内「位次相同」的实体属于同一通道。
 * （协议里没有 yaml 的实体 id，SSE 的 id = "domain/显示名"，显示名改了就变，不能用作锚点） */
const entsSeq = (pred) =>
  [...ents.values()].filter((e) => pred(e.sorting_group || '')).sort((a, b) => (a._seq || 0) - (b._seq || 0));
const chAt = (pred, i) => entsSeq(pred)[i] || null;
/* 通道卡片标题 = 电流实体名去掉 "1." 序号前缀和「电流A/电流」尾缀，剩下的就是用户定义的通道名 */
const channelLabel = (e) => {
  const base = String(e.name).replace(/^\d+\./, '').replace(/\s*电流[ABab]?$/, '').trim();
  return base || String(e.name);
};
/* 通道卡片展示顺序：按标题自然排序（只影响显示顺序，不影响位次配对） */
function channelList() {
  return entsSeq(GRP.current)
    .map((e, i) => ({ e, i, label: channelLabel(e) }))
    .sort((a, b) => collator.compare(a.label, b.label));
}
/* 去掉实体名前缀的节点名和 "1." 式序号（"10-ch ... 1.10通道总功率" → "10通道总功率"） */
const cleanName = (name) => displayName(name).replace(/^\d+\./, '');

/* ---------- 确认弹窗 ---------- */
let modalResolve = null;
function confirmAction(msg) {
  return new Promise((res) => {
    modalResolve = res;
    refs['modal-msg'].textContent = msg;
    refs.modal.hidden = false;
  });
}
function closeModal(v) {
  refs.modal.hidden = true;
  if (modalResolve) { modalResolve(v); modalResolve = null; }
}
refs['modal-yes'].addEventListener('click', () => closeModal(true));
refs['modal-no'].addEventListener('click', () => closeModal(false));
refs.modal.addEventListener('click', (ev) => { if (ev.target === refs.modal) closeModal(false); });

/* ---------- 控制请求 ---------- */
function post(url) { return fetch(url, { method: 'POST' }).catch(() => {}); }

function onSwitchChange(ent, input) {
  const want = input.checked;
  const apply = () => post('/switch/' + enc(ent.name) + '/' + (want ? 'turn_on' : 'turn_off'));
  if (want && DANGER_RE.test(ent.name)) {
    input.checked = false; // 先回弹，确认后再置位
    confirmAction('确认执行「' + displayName(ent.name) + '」？该操作会影响设备运行。').then((ok) => {
      if (ok) { input.checked = true; apply(); }
    });
  } else {
    apply();
  }
}

function pressButton(ent, btn) {
  const run = () => {
    post('/button/' + enc(ent.name) + '/press');
    btn.disabled = true;
    btn.textContent = '已发送';
    setTimeout(() => { btn.disabled = false; btn.textContent = '执行'; }, 1200);
  };
  if (DANGER_RE.test(ent.name)) {
    confirmAction('确认执行「' + displayName(ent.name) + '」？该操作不可撤销。').then((ok) => { if (ok) run(); });
  } else {
    run();
  }
}

/* ---------- 渲染 ---------- */
function schedule() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(render);
}

function render() {
  rafPending = false;
  const has = ents.size > 0;
  refs.loading.hidden = has;
  refs.main.hidden = !has;
  if (!has) return;
  renderChips();
  renderHero();
  renderChannels();
  renderCharts();
  renderMaint();
  drawSpark();
}

function renderConn() {
  refs['h-dot'].classList.toggle('on', online);
  refs['h-conn'].textContent = online ? '已连接' : '离线（重连中…）';
  refs['h-uptime'].textContent = '运行 ' + (meta.uptime != null ? fmtUptime(meta.uptime) : '--');
}

function renderChips() {
  const box = refs.chips;
  box.textContent = '';
  for (const e of inGroup('基础传感器')) {
    const chip = el('div', 'chip');
    chip.append(el('span', 'clabel', displayName(e.name)));
    chip.append(el('b', null, String(e.state != null ? e.state : '--')));
    box.append(chip);
  }
  // 校准状态芯片（放在基础传感器之后）：未校准整块红色
  // 多芯片固件（16ch/3x6）有多个校准状态实体：显示「已校准数/总数」，全部通过才绿色
  const calibs = calibrationEnts();
  if (calibs.length === 1) {
    const ok = isCalibrated(calibs[0]);
    const chip = el('div', 'chip' + (ok ? '' : ' bad'));
    chip.append(el('span', 'clabel', '校准状态'));
    chip.append(el('b', null, String(calibs[0].state != null ? calibs[0].state : '--')));
    box.append(chip);
  } else if (calibs.length > 1) {
    const okN = calibs.filter(isCalibrated).length;
    const chip = el('div', 'chip' + (okN === calibs.length ? '' : ' bad'));
    chip.append(el('span', 'clabel', '校准状态'));
    chip.append(el('b', null, okN + '/' + calibs.length + ' 已校准'));
    box.append(chip);
  }
}

function renderHero() {
  const sum = entsOf(GRP.sum);
  // 总功率：优先全局值（排除「1-10通道」这类分芯片区间命名的实体，16ch 固件会有多个）
  const allTP = sum.filter((e) => /总功率/.test(e.name));
  const tp = allTP.find((e) => !/\d+-\d+通道/.test(e.name)) || allTP[0] || null;
  const sp = tp ? splitState(tp) : { v: '--', u: '' };
  if (tp) refs['tp-label'].textContent = cleanName(tp.name);
  refs['tp-v'].textContent = sp.v;
  refs['tp-u'].textContent = sp.u;

  const defs = [
    ['累计电量', (n) => /总电量/.test(n) && !/今日|昨日|本周|本月|今年/.test(n)],
    ['今日电量', (n) => /今日/.test(n)],
    ['昨日电量', (n) => /昨日/.test(n)],
    ['本周电量', (n) => /本周/.test(n)],
    ['本月电量', (n) => /本月/.test(n)],
    ['今年电量', (n) => /今年/.test(n)],
  ];
  const box = refs.energy;
  box.textContent = '';
  for (const [label, pred] of defs) {
    const e = sum.find((x) => pred(x.name));
    const item = el('div', 'eitem');
    item.append(el('span', 'elabel', label));
    item.append(el('b', null, e && e.state != null ? String(e.state) : '--'));
    box.append(item);
  }
}

function renderChannels() {
  const box = refs.channels;
  box.textContent = '';
  const chans = channelList();
  // 顶栏徽标：通道数确定后更新（6/10/16/3x6 通道固件共用同一份前端）
  if (chans.length) refs['h-badge'].textContent = chans.length + 'CH METER';
  for (const { e: cur, i, label } of chans) {
    const pow = chAt(GRP.power, i);
    const stats = [
      ['今日', chAt(GRP.today, i)],
      ['昨日', chAt(GRP.yesterday, i)],
      ['本周', chAt(GRP.week, i)],
      ['本月', chAt(GRP.month, i)],
      ['今年', chAt(GRP.year, i)],
      ['累计', chAt(GRP.energy, i)],
    ];
    const active = !!(pow && Number(pow.value) > 0);

    const card = el('div', 'card ch' + (active ? ' active' : ''));
    const head = el('div', 'ch-head');
    head.append(el('span', null, label));
    head.append(el('span', 'badge' + (active ? ' on' : ''), active ? '运行中' : '空闲'));

    const cell = (label, e) => {
      const c = el('div', 'ch-cell');
      c.append(el('span', 'ch-clabel', label));
      c.append(el('b', null, e && e.state != null ? String(e.state) : '--'));
      return c;
    };

    // 电流 / 功率 两格
    const top = el('div', 'ch-top');
    top.append(cell('电流', cur), cell('功率', pow));

    // 电量统计：今日/昨日/本周/本月/今年/累计 双列
    const grid = el('div', 'ch-stats');
    for (const [label, e] of stats) grid.append(cell(label, e));

    card.append(head, top, grid);
    box.append(card);
  }
}

function renderMaint() {
  // 正在拖动滑条时跳过重建，避免打断操作（松手后下一次渲染会刷新）
  const active = document.activeElement;
  if (refs.maint.contains(active) && active.type === 'range') return;

  const all = [...inGroup('诊断'), ...inGroup('其它')];
  const calibs = calibrationEnts();
  const switches = all.filter((e) => e.domain === 'switch');
  const buttons = all.filter((e) => e.domain === 'button');
  const numbers = all.filter((e) => e.domain === 'number');
  // 校准状态已在顶部芯片展示，信息区不再重复
  const infos = all.filter((e) => !['switch', 'button', 'number'].includes(e.domain) && !calibs.includes(e));

  const box = refs.maint;
  box.textContent = '';
  const panel = (label) => {
    const p = el('div', 'mpanel');
    p.append(el('div', 'mpanel-label', label));
    return p;
  };

  if (switches.length || buttons.length) {
    const p = panel('操作');
    const grid = el('div', 'op-grid');
    for (const e of switches) {
      const tile = el('div', 'mtile');
      tile.append(el('span', 'mtile-name', displayName(e.name)));
      const lab = el('label', 'sw');
      const input = el('input');
      input.type = 'checkbox';
      input.checked = !!e.value;
      input.addEventListener('change', () => onSwitchChange(e, input));
      lab.append(input, el('span', 'sw-t'));
      tile.append(lab);
      grid.append(tile);
    }
    for (const e of buttons) {
      const tile = el('div', 'mtile');
      tile.append(el('span', 'mtile-name', displayName(e.name)));
      const btn = el('button', 'btn' + (DANGER_RE.test(e.name) ? ' warn' : ''), '执行');
      btn.addEventListener('click', () => pressButton(e, btn));
      tile.append(btn);
      grid.append(tile);
    }
    p.append(grid);
    box.append(p);
  }

  if (numbers.length) {
    const p = panel('设置');
    for (const e of numbers) {
      const row = el('div', 'mrow');
      row.append(el('span', 'mname', displayName(e.name)));
      const val = el('span', 'nval', String(e.state != null ? e.state : '--'));
      const min = Number(e.min_value ?? 0);
      const max = Number(e.max_value ?? 100);
      const input = el('input');
      input.type = 'range';
      input.min = min;
      input.max = max;
      input.step = Number(e.step ?? 1);
      input.value = Number(e.value ?? min);
      const show = () => { val.textContent = input.value + (e.uom ? ' ' + e.uom : ''); };
      input.addEventListener('input', show);
      input.addEventListener('change', () => {
        post('/number/' + enc(e.name) + '/set?value=' + input.value);
      });
      row.append(val, input);
      p.append(row);
    }
    box.append(p);
  }

  if (infos.length) {
    const p = panel('信息');
    const grid = el('div', 'info-grid');
    for (const e of infos) {
      const tile = el('div', 'itile');
      tile.title = e.name;
      tile.append(el('span', 'itile-label', displayName(e.name)));
      tile.append(el('b', 'itile-val', String(e.state != null ? e.state : '--')));
      grid.append(tile);
    }
    p.append(grid);
    box.append(p);
  }
}

/* ---------- 趋势线（总功率 + 各通道共用） ---------- */
const fmtW = (v) => {
  const a = Math.abs(v);
  return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
};

function drawLine(c, hist, opts = {}) {
  const w = c.clientWidth, h = c.clientHeight;
  if (!w || !h) return;
  const dpr = window.devicePixelRatio || 1;
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const cs = getComputedStyle(document.documentElement);
  const accent = cs.getPropertyValue('--accent').trim() || '#3ecf8e';
  const muted = cs.getPropertyValue('--muted').trim() || '#8fa0b3';

  if (hist.length < 2) {
    ctx.fillStyle = muted;
    ctx.font = '12px ' + cs.getPropertyValue('--font');
    ctx.textAlign = 'center';
    ctx.fillText(opts.placeholder || '采集趋势数据中…', w / 2, h / 2 + 4);
    return;
  }

  const n = hist.length;
  const max = Math.max(...hist);
  const top = max > 0 ? max * 1.18 : 1;
  const padX = 2, padT = 14, padB = 3;
  const X = (i) => (i / (n - 1)) * (w - padX * 2) + padX;
  const Y = (v) => h - padB - (Math.min(v, top) / top) * (h - padT - padB);

  // 虚线网格（半程 + 峰值两条）
  if (opts.grid) {
    ctx.strokeStyle = cs.getPropertyValue('--border').trim() || 'rgba(255,255,255,.08)';
    ctx.setLineDash([3, 4]);
    ctx.lineWidth = 1;
    for (const f of [0.5, 1]) {
      const y = Y(top * f);
      ctx.beginPath();
      ctx.moveTo(padX, y);
      ctx.lineTo(w - padX, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  ctx.beginPath();
  hist.forEach((v, i) => {
    const x = X(i), y = Y(v);
    if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  });
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  ctx.stroke();

  ctx.lineTo(X(n - 1), h - padB);
  ctx.lineTo(X(0), h - padB);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, accent + '55');
  g.addColorStop(1, accent + '00');
  ctx.fillStyle = g;
  ctx.fill();

  // 峰值标注
  if (opts.peak) {
    ctx.fillStyle = muted;
    ctx.font = '11px ' + cs.getPropertyValue('--mono');
    ctx.textAlign = 'right';
    ctx.fillText('峰值 ' + fmtW(max) + ' W', w - 4, 11);
  }
}

function drawSpark() {
  drawLine(refs.spark, history, { peak: true, grid: true });
}

function renderCharts() {
  const box = refs.charts;
  box.textContent = '';
  for (const { i, label } of channelList()) {
    const pow = chAt(GRP.power, i);
    const hist = (pow && chHist.get(pow.id)) || [];
    const card = el('div', 'card cchart');
    const head = el('div', 'cc-head');
    head.append(el('span', 'cc-name', label + ' 功率'));
    head.append(el('span', 'cc-val', pow && pow.state != null ? String(pow.state) : '--'));
    const cvbox = el('div', 'cc-box');
    const cv = el('canvas');
    cvbox.append(cv);
    card.append(head, cvbox);
    box.append(card);
    drawLine(cv, hist, { placeholder: '采集中…', peak: true, grid: true });
  }
}

new ResizeObserver(() => drawSpark()).observe($('.spark-box'));
window.addEventListener('resize', schedule);

/* ---------- 日志 ---------- */
function onLog(ev) {
  const line = stripAnsi(ev.data);
  if (!line) return;
  const d = el('div', 'logline', line);
  if (/\[E\]/.test(line)) d.classList.add('e');
  else if (/\[W\]/.test(line)) d.classList.add('w');
  else if (/\[I\]/.test(line)) d.classList.add('i');
  else if (/\[D\]/.test(line)) d.classList.add('d');
  const nearBottom = refs.logs.scrollHeight - refs.logs.scrollTop - refs.logs.clientHeight < 48;
  refs.logs.append(d);
  while (refs.logs.childElementCount > 300) refs.logs.firstElementChild.remove();
  if (nearBottom) refs.logs.scrollTop = refs.logs.scrollHeight;
}

/* ---------- SSE ---------- */
let es = null;
function connect() {
  es = new EventSource('/events');

  es.addEventListener('open', () => {
    // 重连后设备会重发全量数据，先清空避免残留
    if (ents.size) { ents.clear(); history.length = 0; chHist.clear(); schedule(); }
    setOnline(true);
  });

  es.addEventListener('ping', (ev) => {
    let d;
    try { d = JSON.parse(ev.data); } catch { return; }
    if (d.title) {
      meta.title = d.title;
      refs['h-title'].textContent = d.title;
      document.title = d.title;
    }
    if (d.uptime != null) meta.uptime = d.uptime;
    lastPing = Date.now();
    setOnline(true);
  });

  es.addEventListener('state', (ev) => {
    let d;
    try { d = JSON.parse(ev.data); } catch { return; }
    const prev = ents.get(d.id);
    if (prev) {
      prev.value = d.value;
      prev.state = d.state;
    } else {
      d._seq = ents.size; // 首包到达顺序 = yaml 声明顺序，通道序数配对依据
      ents.set(d.id, d);
    }
    // 总功率进趋势缓冲（首包与更新包都算一个采样点；排除 16ch 分芯片的「1-10通道」区间实体）
    const grp = (d.sorting_group || (prev && prev.sorting_group)) || '';
    if (/总和$/.test(grp) && /总功率/.test(d.id) && !/\d+-\d+通道/.test(d.id)) {
      const v = Number(d.value);
      if (Number.isFinite(v)) {
        history.push(v);
        if (history.length > MAX_HISTORY) history.shift();
      }
    }
    // 各通道功率进各自的趋势缓冲（键 = 实体 id，不依赖通道名）
    if (GRP.power(grp)) {
      const v = Number(d.value);
      if (Number.isFinite(v)) {
        let arr = chHist.get(d.id);
        if (!arr) { arr = []; chHist.set(d.id, arr); }
        arr.push(v);
        if (arr.length > MAX_HISTORY) arr.shift();
      }
    }
    schedule();
  });

  es.addEventListener('log', onLog);
  es.addEventListener('error', () => setOnline(false));
}

function setOnline(v) {
  online = v;
  renderConn();
}

/* 心跳看门狗：ping 间隔约 5s，超过 15s 没有心跳视为离线 */
setInterval(() => {
  if (lastPing && Date.now() - lastPing > 15000) setOnline(false);
}, 3000);

/* 运行时间每秒自增，ping 会校正 */
setInterval(() => {
  if (online && meta.uptime != null) { meta.uptime++; renderConn(); }
}, 1000);

connect();
renderConn();
schedule();

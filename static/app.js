/* 문서 처리 기한 관리 도구 - 화면 (바닐라 JS, 외부 라이브러리 없음) */
'use strict';

// ============================================================ 공통
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const app = $('#app');
const WD = ['일', '월', '화', '수', '목', '금', '토'];
const TYPES = ['회신', '전파'];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function store(key, val) {
  try {
    if (val === undefined) return localStorage.getItem(key);
    if (val === null) localStorage.removeItem(key); else localStorage.setItem(key, val);
  } catch (e) { return null; }
}
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const today = () => ymd(new Date());
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
const diffDays = (a, b) => Math.round((parseYmd(a) - parseYmd(b)) / 86400000);
const fmtDate = s => { if (!s) return ''; const d = parseYmd(s); return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`; };
const fmtFull = s => { if (!s) return ''; const d = parseYmd(s); return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.(${WD[d.getDay()]})`; };
const mondayOf = s => { const d = parseYmd(s); const w = (d.getDay() + 6) % 7; d.setDate(d.getDate() - w); return ymd(d); };

let toastTimer;
function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (err ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), err ? 5000 : 2500);
}

async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (state.me) opt.headers['X-Staff-Id'] = String(state.me);
  if (body instanceof FormData) opt.body = body;
  else if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(url, opt);
  let data = null;
  try { data = await r.json(); } catch (e) { /* 본문 없음 */ }
  if (!r.ok) throw new Error((data && data.error) || `요청 실패 (${r.status})`);
  return data;
}
async function run(fn) {
  try { return await fn(); } catch (e) { toast(e.message, true); return undefined; }
}

function openModal(html, onMount) {
  $('#modalBox').innerHTML = html;
  $('#modal').classList.remove('hidden');
  if (onMount) onMount($('#modalBox'));
}
function closeModal() { $('#modal').classList.add('hidden'); $('#modalBox').innerHTML = ''; }
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal' && state.me) closeModal(); });

// ============================================================ 상태
const savedView = (() => { try { return JSON.parse(store('deadline.view') || '{}'); } catch (e) { return {}; } })();
const state = {
  me: Number(store('deadline.me')) || null,
  staff: [],
  templates: [],
  tasks: [],
  view: {
    period: savedView.period || 'today',
    scope: savedView.scope || 'mine',
    filter: savedView.filter || '',
    anchor: today(),
  },
};
function saveView() {
  const { period, scope, filter } = state.view;
  store('deadline.view', JSON.stringify({ period, scope, filter }));
}
const meName = () => (state.staff.find(s => s.id === state.me) || {}).name || '';
const activeStaff = () => state.staff.filter(s => s.active);
const staffName = id => (state.staff.find(s => s.id === id) || {}).name || '?';

async function loadStaff() {
  state.staff = await api('GET', '/api/staff');
  renderMeSelect();
  if (state.me && !state.staff.some(s => s.id === state.me)) { setMe(null); pickStaffModal(); }
}
async function loadTasks() { state.tasks = await api('GET', '/api/tasks'); }
async function loadTemplates() { state.templates = await api('GET', '/api/templates'); }

function setMe(id) {
  state.me = id;
  store('deadline.me', id ? String(id) : null);
  renderMeSelect();
}

function renderMeSelect() {
  const sel = $('#meSelect');
  const list = activeStaff();
  const cur = state.staff.find(s => s.id === state.me);
  if (cur && !cur.active) list.push(cur);
  sel.innerHTML = (state.me ? '' : '<option value="">선택</option>') +
    list.map(s => `<option value="${s.id}" ${s.id === state.me ? 'selected' : ''}>${esc(s.name)}</option>`).join('') +
    '<option value="__pick">다른 사람 / 이름 추가…</option>';
}
$('#meSelect').addEventListener('change', e => {
  const v = e.target.value;
  if (v === '__pick') { renderMeSelect(); pickStaffModal(); return; }
  if (v) { setMe(Number(v)); render(); }
});

function pickStaffModal() {
  const list = activeStaff();
  openModal(`
    <h2>담당자 선택</h2>
    <p class="muted">본인 이름을 고르세요. 이 브라우저에 기억되며, 화면 오른쪽 위에서 언제든 바꿀 수 있습니다.</p>
    ${list.length ? `<div class="staff-pick">${list.map(s => `<button data-id="${s.id}">${esc(s.name)}</button>`).join('')}</div>`
      : '<p class="empty">아직 등록된 담당자가 없습니다. 이름을 추가해 주세요.</p>'}
    <div class="row" style="margin-top:12px">
      <input type="text" id="newStaffName" placeholder="명단에 없으면 이름 입력" style="flex:1">
      <button class="btn primary" id="addStaffBtn">추가하고 선택</button>
    </div>
    ${state.me ? '<div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn" id="pickCancel">닫기</button></div>' : ''}
  `, box => {
    $$('.staff-pick button', box).forEach(b => b.onclick = () => { setMe(Number(b.dataset.id)); closeModal(); render(); });
    const add = () => run(async () => {
      const name = $('#newStaffName', box).value.trim();
      if (!name) return;
      const r = await api('POST', '/api/staff', { name });
      await loadStaff();
      setMe(r.id); closeModal(); render();
    });
    $('#addStaffBtn', box).onclick = add;
    $('#newStaffName', box).onkeydown = e => { if (e.key === 'Enter') add(); };
    const c = $('#pickCancel', box); if (c) c.onclick = closeModal;
  });
}

// ============================================================ 라우터
window.addEventListener('hashchange', render);
async function render() {
  const hash = location.hash || '#/';
  $$('.nav a').forEach(a => a.classList.toggle('active',
    (a.dataset.nav === 'list' && (hash === '#/' || hash.startsWith('#/task'))) || hash.startsWith('#/' + a.dataset.nav)));
  if (!state.me) { app.innerHTML = ''; pickStaffModal(); return; }
  let m;
  if ((m = hash.match(/^#\/task\/(\d+)/))) return renderDetail(Number(m[1]));
  if (hash.startsWith('#/import')) return renderImport();
  if (hash.startsWith('#/settings')) return renderSettings();
  return renderList();
}

// ============================================================ ① 업무 목록
function buildItems(tasks) {
  const items = [];
  for (const t of tasks) {
    const tdone = t.status === '완료';
    items.push({ kind: 'task', task: t, title: t.title, date: t.deadline, done: tdone });
    for (const s of t.steps) items.push({ kind: 'step', task: t, step: s, title: s.name, date: s.deadline, done: tdone || s.done });
  }
  return items;
}
function statusOf(it) {
  if (it.done) return 'done';
  if (!it.date) return 'nodate';
  const d = diffDays(it.date, today());
  if (d < 0) return 'overdue';
  if (d <= 3) return 'soon';
  return 'normal';
}
function dLabel(it) {
  if (it.done) return '완료';
  if (!it.date) return '기한 미정';
  const d = diffDays(it.date, today());
  return d < 0 ? `D+${-d}` : d === 0 ? 'D-day' : `D-${d}`;
}
const byDate = (a, b) => (a.date || '9999').localeCompare(b.date || '9999') || (a.kind === 'step' ? -1 : 1) - (b.kind === 'step' ? -1 : 1);

function itemHtml(it, showOwner) {
  const t = it.task;
  const title = it.kind === 'step'
    ? `<span class="steptag">단계</span>${esc(it.title)} <span class="parent">— ${esc(t.title)}</span>`
    : esc(it.title);
  return `<a class="item ${statusOf(it)}" href="#/task/${t.id}">
    <span class="dbadge">${dLabel(it)}</span>
    <span class="ttype ${esc(t.type)}">${esc(t.type)}</span>
    <span class="ititle" title="${esc(it.kind === 'step' ? it.title + ' — ' + t.title : it.title)}">${title}</span>
    ${showOwner ? `<span class="owner">${esc(t.assignee_name)}</span>` : ''}
    ${it.kind === 'task' && (t.produced_date || t.received_date) ? `<span class="meta">${t.produced_date ? `생산 ${fmtDate(t.produced_date)}` : ''}${t.produced_date && t.received_date ? ' · ' : ''}${t.received_date ? `접수 ${fmtDate(t.received_date)}` : ''}</span>` : ''}
    <span class="idate">${it.date ? fmtDate(it.date) : ''}</span>
  </a>`;
}
function chipHtml(it, showOwner) {
  const t = it.task;
  const label = it.kind === 'step' ? `[단계] ${it.title} — ${t.title}` : it.title;
  return `<a class="chip ${statusOf(it)}" href="#/task/${t.id}" title="${esc((showOwner ? t.assignee_name + ' · ' : '') + label)}">${showOwner ? `<span class="who">${esc(t.assignee_name)}</span>` : ''}${esc(label)}</a>`;
}

function visibleTasks() {
  const v = state.view;
  if (v.scope === 'mine') return state.tasks.filter(t => t.assignee_id === state.me);
  if (v.filter) return state.tasks.filter(t => t.assignee_id === Number(v.filter));
  return state.tasks;
}

async function renderList() {
  app.innerHTML = '<p class="muted">불러오는 중…</p>';
  if (!(await run(async () => { await Promise.all([loadTasks(), loadStaff()]); return true; }))) return;
  const v = state.view;
  const dept = v.scope === 'dept';
  const owners = [...new Map(state.tasks.map(t => [t.assignee_id, t.assignee_name])).entries()];
  const filterStaff = [...new Map([...activeStaff().map(s => [s.id, s.name]), ...owners]).entries()]
    .sort((a, b) => a[1].localeCompare(b[1], 'ko'));

  let rangeLabel = '';
  if (v.period === 'week') { const mo = mondayOf(v.anchor); rangeLabel = `${fmtFull(mo)} ~ ${fmtDate(addDays(mo, 6))}`; }
  if (v.period === 'month') { const d = parseYmd(v.anchor); rangeLabel = `${d.getFullYear()}년 ${d.getMonth() + 1}월`; }

  app.innerHTML = `
    <div class="toolbar">
      <div class="seg" id="periodSeg">
        <button data-v="today" class="${v.period === 'today' ? 'on' : ''}">오늘</button>
        <button data-v="week" class="${v.period === 'week' ? 'on' : ''}">주간</button>
        <button data-v="month" class="${v.period === 'month' ? 'on' : ''}">월간</button>
      </div>
      <div class="seg" id="scopeSeg">
        <button data-v="mine" class="${!dept ? 'on' : ''}">내 업무</button>
        <button data-v="dept" class="${dept ? 'on' : ''}">부서 전체</button>
      </div>
      ${dept ? `<select id="staffFilter"><option value="">담당자 전체</option>${filterStaff.map(([id, n]) =>
        `<option value="${id}" ${String(id) === String(v.filter) ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>` : ''}
      ${v.period !== 'today' ? `<div class="row">
        <button class="btn sm" id="prevBtn">◀</button><button class="btn sm" id="todayBtn">오늘</button><button class="btn sm" id="nextBtn">▶</button>
        <b>${rangeLabel}</b></div>` : `<b>${fmtFull(today())}</b>`}
      <span class="spacer"></span>
      <div class="legend"><span><i style="background:var(--red)"></i>기한 지남</span><span><i style="background:var(--orange)"></i>3일 이내</span><span><i style="background:var(--gray)"></i>완료</span></div>
      <button class="btn primary" id="newTaskBtn">+ 업무 직접 등록</button>
    </div>
    <div id="listBody"></div>`;

  $$('#periodSeg button').forEach(b => b.onclick = () => { v.period = b.dataset.v; v.anchor = today(); saveView(); renderList(); });
  $$('#scopeSeg button').forEach(b => b.onclick = () => { v.scope = b.dataset.v; saveView(); renderList(); });
  const sf = $('#staffFilter'); if (sf) sf.onchange = () => { v.filter = sf.value; saveView(); renderList(); };
  const shift = n => { v.anchor = v.period === 'week' ? addDays(v.anchor, 7 * n) : (() => { const d = parseYmd(v.anchor); d.setDate(1); d.setMonth(d.getMonth() + n); return ymd(d); })(); renderList(); };
  if ($('#prevBtn')) { $('#prevBtn').onclick = () => shift(-1); $('#nextBtn').onclick = () => shift(1); $('#todayBtn').onclick = () => { v.anchor = today(); renderList(); }; }
  $('#newTaskBtn').onclick = newTaskModal;

  const tasks = visibleTasks();
  const items = buildItems(tasks);
  const body = $('#listBody');
  if (v.period === 'today') body.innerHTML = dept ? todayDept(tasks) : todaySections(tasks);
  else if (v.period === 'week') body.innerHTML = dept && !v.filter ? weekDept(items) : weekGrid(items, dept);
  else body.innerHTML = monthGrid(items, dept);
}

// "오늘" 보기는 업무 단위로 보여 준다. 업무 자체 기한과 단계 기한 중 가장 급한 것으로 칸을 정하고,
// 단계는 업무 아래에 댓글처럼 기한·단계명만 붙인다.
const BUCKETS = ['overdue', 'today', 'soon', 'nodate'];
function bucketOf(it) {
  if (!it.date) return it.kind === 'task' && !it.done ? 'nodate' : null;
  const d = diffDays(it.date, today());
  if (d < 0) return it.done ? null : 'overdue';
  if (d === 0) return 'today';
  return d <= 3 ? 'soon' : null;
}
function todayBuckets(tasks) {
  const b = { overdue: [], today: [], soon: [], nodate: [] };
  for (const t of tasks) {
    const its = buildItems([t]);
    // 완료한 단계는 칸을 정하는 데 쓰지 않는다(업무 아래 회색으로만 보임).
    const hits = its.filter(it => bucketOf(it) && !(it.kind === 'step' && it.done));
    if (!hits.length) continue;
    const key = BUCKETS.find(k => hits.some(it => bucketOf(it) === k));
    const keyDates = hits.filter(it => bucketOf(it) === key && it.date).map(it => it.date).sort();
    b[key].push({ task: t, item: its[0], key, open: hits.some(it => !it.done), sortDate: keyDates[0] || '9999' });
  }
  Object.values(b).forEach(a => a.sort((x, y) => x.sortDate.localeCompare(y.sortDate) || x.task.title.localeCompare(y.task.title, 'ko')));
  return b;
}
function stepNotesHtml(t) {
  if (!t.steps.length) return '';
  const tdone = t.status === '완료';
  const title = t.steps.map(s => `${s.deadline ? fmtDate(s.deadline) : '기한 미정'} ${s.name}${s.done ? ' (완료)' : ''}`).join(' · ');
  return `<a class="step-notes" href="#/task/${t.id}" title="${esc(title)}">${t.steps.map(s => {
    const it = { kind: 'step', date: s.deadline, done: tdone || s.done };
    return `<span class="step-note ${statusOf(it)}"><span class="sn-date">${s.deadline ? fmtDate(s.deadline) : '기한 미정'}</span> ${esc(s.name)}</span>`;
  }).join('<span class="sn-sep">·</span>')}</a>`;
}
function taskBlockHtml(entry, showOwner) {
  return `<div class="task-block">${itemHtml(entry.item, showOwner)}${stepNotesHtml(entry.task)}</div>`;
}
function todaySections(tasks) {
  const b = todayBuckets(tasks);
  const sec = (title, arr, emptyMsg) => `
    <div class="section-title">${title} <span class="count">${arr.length}건</span></div>
    ${arr.length ? arr.map(e => taskBlockHtml(e, false)).join('') : (emptyMsg ? `<div class="empty">${emptyMsg}</div>` : '')}`;
  return sec('기한 지남 (미완료)', b.overdue, '') + sec('오늘 마감', b.today, '오늘 마감인 항목이 없습니다.') +
    sec('3일 이내 마감', b.soon, '') + (b.nodate.length ? sec('기한 미정', b.nodate, '') : '') +
    (!b.overdue.length && !b.today.length && !b.soon.length && !b.nodate.length ? '<p class="muted small">주간·월간 보기에서 이후 일정을 확인할 수 있습니다.</p>' : '');
}
function groupByStaff(items) {
  const m = new Map();
  for (const it of items) {
    const k = it.task.assignee_id;
    if (!m.has(k)) m.set(k, { name: it.task.assignee_name, items: [] });
    m.get(k).items.push(it);
  }
  return [...m.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
}
function todayDept(tasks) {
  const byStaff = new Map();
  for (const t of tasks) {
    if (!byStaff.has(t.assignee_id)) byStaff.set(t.assignee_id, { name: t.assignee_name, tasks: [] });
    byStaff.get(t.assignee_id).tasks.push(t);
  }
  const groups = [...byStaff.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko'))
    .map(g => ({ ...g, b: todayBuckets(g.tasks) }))
    .filter(g => BUCKETS.some(k => g.b[k].length));
  if (!groups.length) return '<div class="empty">오늘 볼 항목이 없습니다.</div>';
  const open = arr => arr.filter(e => e.open).length;
  return groups.map(g => {
    const all = BUCKETS.flatMap(k => g.b[k]);
    return `<div class="staff-group"><div class="gh"><b>${esc(g.name)}</b>
      ${g.b.overdue.length ? `<span class="pill red">지남 ${g.b.overdue.length}</span>` : ''}
      ${open(g.b.today) ? `<span class="pill orange">오늘 ${open(g.b.today)}</span>` : ''}
      ${open(g.b.soon) ? `<span class="pill orange">3일 이내 ${open(g.b.soon)}</span>` : ''}
      ${g.b.nodate.length ? `<span class="pill gray">기한 미정 ${g.b.nodate.length}</span>` : ''}</div>
      ${all.map(e => taskBlockHtml(e, false)).join('')}</div>`;
  }).join('');
}
function weekDays() { const mo = mondayOf(state.view.anchor); return [...Array(7)].map((_, i) => addDays(mo, i)); }
function weekGrid(items, showOwner) {
  const days = weekDays(); const t = today();
  return `<div class="week">${days.map(d => {
    const list = items.filter(it => it.date === d).sort(byDate);
    const wd = parseYmd(d).getDay();
    return `<div class="day ${d === t ? 'today' : ''}"><div class="dh"><span style="${wd === 0 ? 'color:var(--red)' : wd === 6 ? 'color:var(--accent)' : ''}">${fmtDate(d)}</span><span>${list.length || ''}</span></div>
      ${list.map(it => chipHtml(it, showOwner)).join('')}</div>`;
  }).join('')}</div>`;
}
function weekDept(items) {
  const days = weekDays(); const t = today();
  const inWeek = items.filter(it => it.date && it.date >= days[0] && it.date <= days[6]);
  const groups = groupByStaff(inWeek);
  if (!groups.length) return '<div class="empty">이번 주에 마감인 항목이 없습니다.</div>';
  return `<div class="week-table"><table class="grid"><thead><tr><th>담당자</th>${days.map(d => `<th class="${d === t ? 'today' : ''}">${fmtDate(d)}</th>`).join('')}</tr></thead>
    <tbody>${groups.map(g => {
      const od = g.items.filter(it => statusOf(it) === 'overdue').length;
      const soon = g.items.filter(it => statusOf(it) === 'soon').length;
      return `<tr><th>${esc(g.name)}<div class="small" style="font-weight:400;margin-top:4px">${od ? `<span class="pill red">지남 ${od}</span> ` : ''}${soon ? `<span class="pill orange">임박 ${soon}</span>` : ''}</div></th>
      ${days.map(d => `<td class="cell ${d === t ? 'today' : ''}">${g.items.filter(it => it.date === d).sort(byDate).map(it => chipHtml(it, false)).join('')}</td>`).join('')}</tr>`;
    }).join('')}</tbody></table></div>`;
}
function monthGrid(items, showOwner) {
  const a = parseYmd(state.view.anchor);
  const first = ymd(new Date(a.getFullYear(), a.getMonth(), 1));
  const start = mondayOf(first);
  const month = a.getMonth(); const t = today();
  const byDay = new Map();
  for (const it of items) if (it.date) { if (!byDay.has(it.date)) byDay.set(it.date, []); byDay.get(it.date).push(it); }
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    const dd = parseYmd(d);
    if (i >= 35 && dd.getMonth() !== month) break;
    const list = (byDay.get(d) || []).sort(byDate);
    cells += `<div class="day ${dd.getMonth() !== month ? 'other' : ''} ${d === t ? 'today' : ''}"><div class="dh"><span>${dd.getDate()}</span><span>${list.length || ''}</span></div>${list.map(it => chipHtml(it, showOwner)).join('')}</div>`;
  }
  const heads = ['월', '화', '수', '목', '금', '토', '일'].map((w, i) => `<div class="wdh ${i === 6 ? 'sun' : i === 5 ? 'sat' : ''}">${w}</div>`).join('');
  return `<div class="month">${heads}${cells}</div>`;
}

function staffOptions(selected, includeInactiveId) {
  const list = activeStaff().slice();
  if (includeInactiveId && !list.some(s => s.id === includeInactiveId)) {
    const s = state.staff.find(x => x.id === includeInactiveId); if (s) list.push(s);
  }
  return list.map(s => `<option value="${s.id}" ${s.id === selected ? 'selected' : ''}>${esc(s.name)}${s.active ? '' : ' (비활성)'}</option>`).join('');
}

function newTaskModal() {
  openModal(`
    <h2>업무 직접 등록</h2>
    <div class="form-grid">
      <label>제목 *</label><input type="text" id="nt_title">
      <label>유형 *</label><select id="nt_type"><option value="회신">회신</option><option value="전파">전파</option></select>
      <label>최종 기한</label><input type="date" id="nt_deadline">
      <label>담당자</label><select id="nt_assignee">${staffOptions(state.me)}</select>
      <label>문서번호</label><input type="text" id="nt_docno" placeholder="선택 입력 (예: 정보통신과-1234)">
      <label>메모</label><textarea id="nt_memo"></textarea>
    </div>
    <div class="row" style="justify-content:flex-end;margin-top:16px">
      <button class="btn" id="nt_cancel">취소</button><button class="btn primary" id="nt_save">등록</button>
    </div>`, box => {
    $('#nt_title', box).focus();
    $('#nt_cancel', box).onclick = closeModal;
    $('#nt_save', box).onclick = () => run(async () => {
      const r = await api('POST', '/api/tasks', {
        title: $('#nt_title', box).value, type: $('#nt_type', box).value, deadline: $('#nt_deadline', box).value,
        assignee_id: Number($('#nt_assignee', box).value), doc_no: $('#nt_docno', box).value, memo: $('#nt_memo', box).value,
      });
      closeModal(); toast('등록했습니다.');
      location.hash = `#/task/${r.id}`;
    });
  });
}

// ============================================================ ② 업무 상세
function highlight(text, phrases) {
  let h = esc(text);
  for (const p of phrases.filter(Boolean)) {
    const ep = esc(p);
    if (ep.length > 2) h = h.split(ep).join(`<mark>${ep}</mark>`);
  }
  return h;
}

async function renderDetail(id) {
  app.innerHTML = '<p class="muted">불러오는 중…</p>';
  let t;
  if (!(await run(async () => { [t] = await Promise.all([api('GET', `/api/tasks/${id}`), loadStaff(), loadTemplates()]); return true; }))) {
    app.innerHTML = '<p><a href="#/">← 업무 목록</a></p>'; return;
  }
  drawDetail(t);
}

function drawDetail(t) {
  const mine = t.assignee_id === state.me;
  const dis = mine ? '' : 'disabled';
  const done = t.status === '완료';
  const st = statusOf({ date: t.deadline, done });
  const ev = t.evidence || {};
  const evType = ev.type || [];
  const srcBadge = (s, basis) => s !== 'auto' ? '<span class="badge-manual">직접 입력</span>'
    : basis === 'title' ? '<span class="badge-guess">제목으로 추정</span>' : '<span class="badge-auto">자동 식별</span>';
  const stepsDone = t.steps.filter(s => s.done).length;

  app.innerHTML = `
    <p><a href="#/">← 업무 목록</a></p>
    <div class="panel">
      <div class="detail-head">
        <span class="ttype ${esc(t.type)}">${esc(t.type)}</span>
        <h2>${esc(t.title)}</h2>
        <span class="pill ${done ? 'green' : st === 'overdue' ? 'red' : st === 'soon' ? 'orange' : 'blue'}">${done ? '완료' : `진행중 · ${dLabel({ date: t.deadline, done })}`}</span>
        <span class="spacer"></span>
        ${mine ? (done ? '<button class="btn" id="reopenBtn">다시 열기</button>' : '<button class="btn primary" id="completeBtn">완료 처리</button>') : ''}
      </div>
      ${mine ? '' : `<div class="readonly-note">읽기 전용입니다. 이 업무는 <b>${esc(t.assignee_name)}</b> 님만 수정할 수 있습니다.</div>`}
      <div class="info-grid" style="margin-top:12px">
        <div><span>담당자</span>${esc(t.assignee_name)}</div>
        <div><span>접수번호</span>${esc(t.receipt_no || '-')}</div>
        <div><span>문서번호</span>${esc(t.doc_no || '-')}</div>
        <div><span>발신기관</span>${esc(t.sender || '-')}</div>
        <div><span>생산일자</span>${t.produced_date ? fmtFull(t.produced_date) : '-'}</div>
        <div><span>접수일</span>${t.received_date ? fmtFull(t.received_date) : '-'}</div>
        <div><span>등록</span>${esc(t.source)} · ${esc(t.created_at.slice(0, 16))}</div>
        <div><span>최종 수정</span>${esc(t.updated_by || '-')} · ${esc(t.updated_at.slice(0, 16))}</div>
        ${done ? `<div><span>완료일시</span>${esc((t.completed_at || '').slice(0, 16))}</div>` : ''}
      </div>
    </div>
    <div class="cols">
      <div>
        <div class="panel">
          <h3>업무 정보</h3>
          <div class="form-grid">
            <label>제목</label><input type="text" id="f_title" value="${esc(t.title)}" ${dis}>
            <label>유형</label><div class="row"><select id="f_type" ${dis}>${TYPES.map(x => `<option ${x === t.type ? 'selected' : ''}>${x}</option>`).join('')}</select>${srcBadge(t.type_source, ev.type_basis)}</div>
            <label>최종 기한</label><div class="row"><input type="date" id="f_deadline" value="${esc(t.deadline || '')}" ${dis}>${srcBadge(t.deadline_source)}${t.deadline ? `<span class="muted small">${fmtFull(t.deadline)}</span>` : '<span class="badge-check">기한 미정</span>'}</div>
            <label>담당자</label><div class="row"><select id="f_assignee" ${dis}>${staffOptions(t.assignee_id, t.assignee_id)}</select>${mine ? '<span class="muted small">다른 담당자로 넘길 수 있습니다</span>' : ''}</div>
            <label>문서번호</label><input type="text" id="f_docno" value="${esc(t.doc_no || '')}" ${dis}>
            <label>생산일자</label><div class="row"><input type="date" id="f_produced" value="${esc(t.produced_date || '')}" ${dis}><span class="muted small">발신부서가 문서를 생산한 날</span></div>
            <label>메모</label><textarea id="f_memo" ${dis}>${esc(t.memo || '')}</textarea>
          </div>
          ${mine ? `<div class="row" style="margin-top:12px"><button class="btn primary" id="saveBtn">저장</button><span class="spacer"></span><button class="btn danger sm" id="deleteBtn">업무 삭제</button></div>` : ''}
        </div>
        <div class="panel">
          <div class="row" style="margin-bottom:10px"><h3 style="margin:0">단계별 기한</h3><span class="muted small">${t.steps.length ? `${stepsDone}/${t.steps.length} 완료` : ''}</span>
            <span class="spacer"></span>
            ${mine ? `<select id="tplSel"><option value="">템플릿 선택</option>${state.templates.map(x => `<option value="${x.id}">${esc(x.name)} (${x.steps.map(s => `${s.name} D-${s.days_before}`).join(' → ')})</option>`).join('')}</select>
            <button class="btn sm" id="tplApply">템플릿 적용</button>` : ''}
          </div>
          ${t.steps.length ? `<table class="grid steps-table"><thead><tr><th style="width:44px">완료</th><th>단계명</th><th style="width:150px">기한</th>${mine ? '<th style="width:150px"></th>' : ''}</tr></thead><tbody>
            ${t.steps.map((s, i) => {
              const sst = statusOf({ date: s.deadline, done: s.done || done });
              return `<tr data-sid="${s.id}" class="${sst}">
              <td style="text-align:center"><input type="checkbox" class="s_done" ${s.done ? 'checked' : ''} ${dis}></td>
              <td><input type="text" class="s_name" value="${esc(s.name)}" ${dis}></td>
              <td><input type="date" class="s_deadline" value="${esc(s.deadline || '')}" ${dis}><div class="small" style="color:${sst === 'overdue' ? 'var(--red)' : sst === 'soon' ? 'var(--orange)' : 'var(--muted)'}">${dLabel({ date: s.deadline, done: s.done || done })}</div></td>
              ${mine ? `<td style="white-space:nowrap"><button class="btn sm s_up" ${i === 0 ? 'disabled' : ''}>↑</button> <button class="btn sm s_down" ${i === t.steps.length - 1 ? 'disabled' : ''}>↓</button> <button class="btn sm danger s_del">삭제</button></td>` : ''}
            </tr>`;
            }).join('')}</tbody></table>` : '<div class="empty">단계가 없습니다. 템플릿을 적용하거나 직접 추가하세요.</div>'}
          ${mine ? `<div class="row" style="margin-top:10px"><input type="text" id="ns_name" placeholder="새 단계명" style="flex:1"><input type="date" id="ns_deadline"><button class="btn" id="ns_add">단계 추가</button></div>
            <p class="muted small">단계를 모두 체크해도 업무는 자동으로 완료되지 않습니다. 위의 [완료 처리]를 직접 눌러 주세요.</p>` : ''}
        </div>
      </div>
      <div>
        <div class="panel">
          <h3>식별 근거</h3>
          ${ev && (evType.length || ev.deadline || ev.docno) ? `<ul class="evidence">
            ${ev.file ? `<li><b>본문 파일</b>: ${esc(ev.file)}</li>` : ''}
            ${ev.docno ? `<li><b>문서번호</b>: ${esc(ev.docno)}</li>` : ''}
            ${evType.map(s => `<li><b>유형</b>: ${esc(s)}</li>`).join('')}
            ${ev.deadline ? `<li><b>기한</b>: ${esc(ev.deadline)}</li>` : ''}
          </ul>` : '<p class="muted">자동 식별 근거가 없습니다(직접 등록했거나 본문이 없음).</p>'}
        </div>
        <div class="panel">
          <h3>본문 원문</h3>
          ${t.body_text ? `<div class="bodytext">${highlight(t.body_text, [...evType, ev.deadline])}</div>` : '<p class="muted">저장된 본문이 없습니다.</p>'}
        </div>
      </div>
    </div>`;

  if (!mine) return;
  const refresh = nt => { if (nt) drawDetail(nt); };
  $('#saveBtn').onclick = () => run(async () => {
    const newAssignee = Number($('#f_assignee').value);
    if (newAssignee !== t.assignee_id && !confirm(`담당자를 ${staffName(newAssignee)} 님으로 넘깁니다. 넘긴 뒤에는 이 업무를 수정할 수 없습니다. 계속할까요?`)) return;
    const nt = await api('PUT', `/api/tasks/${t.id}`, {
      title: $('#f_title').value, type: $('#f_type').value, deadline: $('#f_deadline').value,
      assignee_id: newAssignee, doc_no: $('#f_docno').value, produced_date: $('#f_produced').value, memo: $('#f_memo').value,
    });
    toast('저장했습니다.'); refresh(nt);
  });
  $('#deleteBtn').onclick = () => run(async () => {
    if (!confirm('이 업무를 삭제할까요? 되돌릴 수 없습니다.')) return;
    await api('DELETE', `/api/tasks/${t.id}`); toast('삭제했습니다.'); location.hash = '#/';
  });
  const cb = $('#completeBtn'); if (cb) cb.onclick = () => run(async () => { refresh(await api('POST', `/api/tasks/${t.id}/complete`)); toast('완료 처리했습니다.'); });
  const rb = $('#reopenBtn'); if (rb) rb.onclick = () => run(async () => { refresh(await api('POST', `/api/tasks/${t.id}/reopen`)); toast('다시 열었습니다.'); });
  $('#tplApply').onclick = () => run(async () => {
    const tid = $('#tplSel').value;
    if (!tid) { toast('템플릿을 고르세요.', true); return; }
    if (!t.deadline && !confirm('최종 기한이 없어 단계 기한을 계산할 수 없습니다. 기한 없이 단계만 넣을까요?')) return;
    let mode = 'append';
    if (t.steps.length) mode = confirm('기존 단계를 지우고 템플릿으로 바꿀까요?\n[확인] 바꾸기  [취소] 기존 단계 뒤에 추가') ? 'replace' : 'append';
    refresh(await api('POST', `/api/tasks/${t.id}/apply_template`, { template_id: Number(tid), mode }));
    toast('템플릿을 적용했습니다.');
  });
  $('#ns_add').onclick = () => run(async () => {
    const name = $('#ns_name').value.trim();
    if (!name) { toast('단계명을 입력하세요.', true); return; }
    refresh(await api('POST', `/api/tasks/${t.id}/steps`, { name, deadline: $('#ns_deadline').value }));
  });
  $('#ns_name').onkeydown = e => { if (e.key === 'Enter') $('#ns_add').click(); };
  $$('tr[data-sid]').forEach(tr => {
    const sid = Number(tr.dataset.sid);
    const idx = t.steps.findIndex(s => s.id === sid);
    $('.s_done', tr).onchange = e => run(async () => refresh(await api('PUT', `/api/steps/${sid}`, { done: e.target.checked })));
    $('.s_name', tr).onchange = e => run(async () => { refresh(await api('PUT', `/api/steps/${sid}`, { name: e.target.value })); toast('단계명을 고쳤습니다.'); });
    $('.s_deadline', tr).onchange = e => run(async () => { refresh(await api('PUT', `/api/steps/${sid}`, { deadline: e.target.value })); toast('단계 기한을 고쳤습니다.'); });
    $('.s_del', tr).onclick = () => run(async () => { if (confirm('이 단계를 삭제할까요?')) refresh(await api('DELETE', `/api/steps/${sid}`)); });
    const move = d => run(async () => {
      const ids = t.steps.map(s => s.id);
      [ids[idx], ids[idx + d]] = [ids[idx + d], ids[idx]];
      refresh(await api('POST', `/api/tasks/${t.id}/steps/reorder`, { order: ids }));
    });
    $('.s_up', tr).onclick = () => move(-1);
    $('.s_down', tr).onclick = () => move(1);
  });
}

// ============================================================ ③ 접수문서 가져오기
const MAP_LABELS = {
  receipt_no: '접수번호 †', doc_no: '문서번호 †', title: '제목 *', sender: '발신기관', sender_dept: '발신부서', produced: '생산일자',
  received: '접수일시', assignee: '처리자', status: '결재상태',
};
const EXCEL_RE = /\.(xlsx|xlsm|xls|csv)$/i;
const BODY_RE = /\.(hwp|hwpx|txt)$/i;
const imp = { files: [], parsed: null, preview: null, edits: {}, filter: 'all' };
const PREVIEW_FILTERS = [
  ['all', '전체'], ['selected', '등록 선택'], ['body', '본문 있음'], ['check', '확인 필요'], ['off', '제외'],
];

async function renderImport() {
  await run(loadStaff);
  imp.files = []; imp.parsed = null; imp.preview = null; imp.edits = {}; imp.filter = 'all';
  app.innerHTML = `
    <div class="panel">
      <h2>접수문서 가져오기</h2>
      <p class="muted">온나라에서 내려받은 <b>접수 목록 엑셀 1개</b>와 <b>본문 HWP 파일 여러 개</b>를 함께 올리세요. (지원: .xlsx .xls .csv / .hwp .hwpx .txt)</p>
      <div class="drop" id="drop">여기로 파일을 끌어다 놓거나 <a href="javascript:void 0">클릭해서 선택</a>하세요
        <input type="file" id="fileInput" multiple accept=".xlsx,.xlsm,.xls,.csv,.hwp,.hwpx,.txt" class="hidden"></div>
      <ul class="filelist" id="fileList"></ul>
      <div class="row" style="margin-top:12px"><button class="btn primary" id="parseBtn" disabled>불러오기</button><button class="btn" id="clearBtn">비우기</button><span class="muted small" id="parseMsg"></span></div>
    </div>
    <div id="mapArea"></div>
    <div id="previewArea"></div>`;
  const drop = $('#drop'), input = $('#fileInput');
  drop.onclick = () => input.click();
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); };
  input.onchange = () => { addFiles(input.files); input.value = ''; };
  $('#clearBtn').onclick = () => { imp.files = []; drawFiles(); $('#mapArea').innerHTML = ''; $('#previewArea').innerHTML = ''; };
  $('#parseBtn').onclick = parseFiles;
}
function addFiles(list) {
  for (const f of list) {
    if (!EXCEL_RE.test(f.name) && !BODY_RE.test(f.name)) { toast(`${f.name}: 지원하지 않는 형식`, true); continue; }
    if (EXCEL_RE.test(f.name)) imp.files = imp.files.filter(x => !EXCEL_RE.test(x.name));
    imp.files = imp.files.filter(x => x.name !== f.name);
    imp.files.push(f);
  }
  drawFiles();
}
function drawFiles() {
  const xls = imp.files.filter(f => EXCEL_RE.test(f.name));
  const bodies = imp.files.filter(f => BODY_RE.test(f.name));
  $('#fileList').innerHTML = [...xls, ...bodies].map(f => `<li class="${EXCEL_RE.test(f.name) ? 'xls' : ''}">${esc(f.name)}</li>`).join('');
  $('#parseBtn').disabled = xls.length !== 1;
  $('#parseMsg').textContent = imp.files.length ? `엑셀 ${xls.length}개, 본문 ${bodies.length}개` + (xls.length !== 1 ? ' — 엑셀 파일 1개가 필요합니다' : '') : '';
}
async function parseFiles() {
  const fd = new FormData();
  imp.files.forEach(f => fd.append('files', f, f.name));
  $('#parseBtn').disabled = true; $('#parseMsg').textContent = '읽는 중…';
  const r = await run(() => api('POST', '/api/import/parse', fd));
  $('#parseBtn').disabled = false; drawFiles();
  if (!r) return;
  imp.parsed = r;
  $('#parseMsg').textContent = `엑셀${r.sheet ? ` [${r.sheet}] 시트` : ''} ${r.row_count}행, 본문 ${r.file_count}개를 읽었습니다.`;
  if (r.need_mapping) drawMapping(); else { drawMappingSummary(); await makePreview(r.mapping); }
}
function drawMappingSummary() {
  const r = imp.parsed;
  $('#mapArea').innerHTML = `<div class="panel row"><span class="muted">저장된 열 매핑 사용:</span>
    ${Object.keys(MAP_LABELS).filter(k => r.mapping[k]).map(k => `<span class="pill gray">${MAP_LABELS[k].replace(/ [*†]/, '')} ← ${esc(r.mapping[k])}</span>`).join('')}
    <button class="btn sm" id="changeMap">열 매핑 변경</button></div>`;
  $('#changeMap').onclick = drawMapping;
}
function drawMapping() {
  const r = imp.parsed;
  const opts = sel => `<option value="">(없음)</option>` + r.headers.map(h => `<option ${h === sel ? 'selected' : ''}>${esc(h)}</option>`).join('');
  $('#previewArea').innerHTML = '';
  $('#mapArea').innerHTML = `<div class="panel">
    <h3>엑셀 열 매핑</h3>
    <p class="muted small">엑셀의 어느 열이 각 항목인지 지정하세요. 한 번 지정하면 저장되어 다음부터 자동으로 사용합니다.<br>
      * 필수 · † 접수번호와 문서번호 중 하나 이상 필수. 중복 등록 판단과 본문 짝짓기는 <b>접수번호</b>(우리 부서 번호)를 우선 쓰고, 없으면 문서번호(발신 기관 번호)를 씁니다.</p>
    <div class="mapping-grid">${Object.entries(MAP_LABELS).map(([k, l]) => `<label>${l}</label><select data-k="${k}">${opts(r.mapping[k])}</select>`).join('')}</div>
    <div class="sample"><table class="grid"><thead><tr>${r.headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${r.sample.map(row => `<tr>${row.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    <div class="row" style="margin-top:12px"><button class="btn primary" id="mapOk">이 설정으로 미리보기</button></div></div>`;
  $('#mapOk').onclick = () => {
    const m = {}; $$('#mapArea select').forEach(s => { if (s.value) m[s.dataset.k] = s.value; });
    imp.parsed.mapping = m;
    makePreview(m).then(ok => { if (ok) drawMappingSummary(); });
  };
}
async function makePreview(mapping) {
  const p = await run(() => api('POST', `/api/import/${imp.parsed.import_id}/preview`, { mapping }));
  if (!p) return false;
  imp.preview = p; imp.edits = {};
  for (const row of p.rows) initEdit(row);
  drawPreview();
  return true;
}
function initEdit(row) {
  imp.edits[row.idx] = {
    include: row.include, type: row.ident.type, deadline: row.ident.deadline || '', assignee: row.assignee || meName(),
  };
}
function previewNeedsCheck(r, e) {
  return !TYPES.includes(e.type) || !e.deadline || (r.ident.type_basis === 'title' && e.type === r.ident.type);
}
function drawPreview() {
  const p = imp.preview;
  const all = p.rows;
  const freeRows = all.filter(r => r.file_index === null);
  const checkCount = all.filter(r => imp.edits[r.idx].include && previewNeedsCheck(r, imp.edits[r.idx])).length;
  const selCount = all.filter(r => imp.edits[r.idx].include).length;
  const bodyCount = all.filter(r => r.has_body).length;
  const filters = {
    all: () => true,
    selected: r => imp.edits[r.idx].include,
    body: r => r.has_body,
    check: r => previewNeedsCheck(r, imp.edits[r.idx]),
    off: r => !imp.edits[r.idx].include,
  };
  const rows = all.filter(filters[imp.filter] || filters.all);
  const staffNames = activeStaff().map(s => s.name);
  const typeCell = (r, e) => {
    const auto = r.ident.type_auto && e.type === r.ident.type;
    const opts = ['회신', '전파', '해당없음'].map(x => `<option value="${x}" ${x === e.type ? 'selected' : ''}>${x === '해당없음' ? '해당 없음' : x}</option>`).join('');
    const badge = !e.type ? '<span class="badge-check">확인 필요</span>'
      : auto && r.ident.type_basis === 'title' ? '<span class="badge-guess" title="본문이 없거나 본문에 문구가 없어 제목으로 추정했습니다">제목으로 추정</span>'
      : auto ? '<span class="badge-auto">자동 식별</span>'
      : r.ident.type_auto || e.type !== r.ident.type ? '<span class="badge-manual">직접 수정</span>' : '<span class="badge-manual">문구 없음</span>';
    return `<select class="p_type">${e.type ? '' : '<option value="" selected>선택</option>'}${opts}</select><br>${badge}`;
  };
  const dlCell = (r, e) => {
    const auto = r.ident.deadline_auto && e.deadline === r.ident.deadline;
    return `<input type="date" class="p_deadline" value="${esc(e.deadline)}"><br>
      ${!e.deadline ? (TYPES.includes(e.type) ? '<span class="badge-check">확인 필요</span>' : '') : auto ? '<span class="badge-auto">자동 식별</span>' : '<span class="badge-manual">직접 수정</span>'}`;
  };
  const evCell = r => {
    const ev = r.ident.evidence || {};
    const parts = [];
    if (!r.file) parts.push('<span class="badge-check">본문 없음</span> 짝지을 본문 파일이 없습니다.');
    else if (!r.has_body) parts.push('<span class="badge-check">본문 읽기 불가</span>');
    if (ev.docno) parts.push(`<b>번호</b> ${esc(ev.docno)}`);
    (ev.type || []).forEach(s => parts.push(`<b>유형</b> ${esc(s)}`));
    if (ev.deadline) parts.push(`<b>기한</b> ${esc(ev.deadline)}`);
    else if (r.has_body) parts.push('<b>기한</b> 날짜를 찾지 못함');
    return parts.join('<br>');
  };

  $('#previewArea').innerHTML = `
    <div class="panel">
      <div class="row"><h3 style="margin:0">미리보기</h3>
        <span class="pill blue">새 문서 ${all.length}건</span>
        <span class="pill ${bodyCount ? 'green' : 'gray'}">본문 짝지음 ${bodyCount}건</span>
        ${p.skipped_dup ? `<span class="pill gray" title="${esc(p.skipped_list.join(', '))}">이미 등록된 문서 ${p.skipped_dup}건 건너뜀</span>` : ''}
        ${p.unmatched.length ? `<span class="pill red">미매칭 파일 ${p.unmatched.length}개</span>` : ''}
        ${checkCount ? `<span class="pill orange">선택 중 확인 필요 ${checkCount}건</span>` : ''}
        <span class="spacer"></span>
        <button class="btn primary" id="commitBtn" ${selCount ? '' : 'disabled'}>선택한 ${selCount}건 등록</button>
      </div>
      <p class="muted small">자동 식별 값은 근거 문장을 보고 확인하세요. 본문이 없는 문서는 제목으로 유형만 추정하며 기한은 비어 있습니다.
        결재상태(접수 처리 상태)와 관계없이 회신·전파로 식별된 문서는 모두 등록 대상이며, "해당 없음"만 기본적으로 등록하지 않습니다. 담당자는 엑셀의 처리자 이름이며, 명단에 없으면 자동으로 추가됩니다.</p>
      <div class="row" style="margin-bottom:8px"><div class="seg" id="pvFilter">${PREVIEW_FILTERS.map(([k, l]) =>
        `<button data-v="${k}" class="${imp.filter === k ? 'on' : ''}">${l} ${all.filter(filters[k]).length}</button>`).join('')}</div></div>
      ${rows.length ? `<div style="overflow-x:auto"><table class="grid preview-table"><thead><tr>
        <th><input type="checkbox" id="checkAll" title="보이는 행 모두 선택/해제"></th><th>접수번호 / 문서번호 / 제목</th><th>발신 / 생산일자<br>접수일시</th><th>담당자</th><th>본문 파일</th><th>유형</th><th>기한</th><th>근거</th></tr></thead>
        <tbody>${rows.map(r => {
          const e = imp.edits[r.idx];
          const need = e.include && previewNeedsCheck(r, e);
          return `<tr data-idx="${r.idx}" class="${e.include ? '' : 'off'} ${need ? 'needcheck' : ''}">
            <td><input type="checkbox" class="p_inc" ${e.include ? 'checked' : ''}></td>
            <td><div class="small muted">${r.receipt_no ? `접수 ${esc(r.receipt_no)} · ` : ''}${esc(r.doc_no || '(문서번호 없음)')}</div>${esc(r.title)}
              ${r.status ? `<div><span class="pill gray small" title="온나라 결재상태(접수 처리 상태) — 등록 여부와 무관">결재상태 ${esc(r.status)}</span></div>` : ''}</td>
            <td class="small">${esc(r.sender || '')}<br>
              <span class="muted">생산</span> ${r.produced ? `${fmtFull(r.produced)}${r.produced_src === '본문 시행일' ? ' <span class="muted">(본문)</span>' : ''}` : '<span class="muted">-</span>'}<br>
              <span class="muted">접수</span> ${r.received ? fmtFull(r.received) : '<span class="muted">-</span>'}</td>
            <td><input type="text" class="p_assignee" list="staffNames" value="${esc(e.assignee)}" style="width:90px">${e.assignee && !staffNames.includes(e.assignee) ? '<br><span class="small muted">명단에 추가됨</span>' : ''}</td>
            <td class="small">${r.file ? esc(r.file) : '<span class="muted">없음</span>'}</td>
            <td>${typeCell(r, e)}</td>
            <td>${dlCell(r, e)}</td>
            <td class="ev">${evCell(r)}</td></tr>`;
        }).join('')}</tbody></table></div>
        <datalist id="staffNames">${staffNames.map(n => `<option value="${esc(n)}">`).join('')}</datalist>`
      : `<div class="empty">${all.length ? '이 조건에 맞는 행이 없습니다.' : '새로 등록할 문서가 없습니다.'}</div>`}
    </div>
    ${p.unmatched.length ? `<div class="panel">
      <h3>미매칭 파일</h3>
      <p class="muted small">문서번호를 찾지 못했거나 엑셀과 맞지 않는 파일입니다. 엑셀 행을 골라 직접 짝지을 수 있습니다. 배포용(암호화) HWP는 본문을 읽을 수 없으니 짝지은 뒤 유형·기한을 직접 입력하세요.</p>
      <table class="grid"><thead><tr><th>파일</th><th>사유</th><th>짝지을 엑셀 행</th></tr></thead><tbody>
      ${p.unmatched.map(u => `<tr data-fi="${u.file_index}"><td>${esc(u.name)}</td><td><span class="${u.readable ? 'pill orange' : 'pill red'}">${esc(u.reason)}</span></td>
        <td class="row"><select class="u_row"><option value="">행 선택</option>${freeRows.map(r => `<option value="${r.idx}">${esc(r.receipt_no || r.doc_no)} ${esc(r.doc_no && r.receipt_no ? r.doc_no : '')} ${esc(r.title.slice(0, 40))}</option>`).join('')}</select>
        <button class="btn sm u_pair">짝짓기</button></td></tr>`).join('')}
      </tbody></table></div>` : ''}`;

  $$('#pvFilter button').forEach(b => b.onclick = () => { imp.filter = b.dataset.v; drawPreview(); });
  const ca = $('#checkAll');
  if (ca) {
    ca.checked = rows.length > 0 && rows.every(r => imp.edits[r.idx].include);
    ca.onchange = () => { rows.forEach(r => imp.edits[r.idx].include = ca.checked); drawPreview(); };
  }
  $$('#previewArea tr[data-idx]').forEach(tr => {
    const e = imp.edits[Number(tr.dataset.idx)];
    $('.p_inc', tr).onchange = ev => { e.include = ev.target.checked; drawPreview(); };
    $('.p_type', tr).onchange = ev => {
      e.type = ev.target.value;
      if (TYPES.includes(e.type)) e.include = true; else if (e.type === '해당없음') e.include = false;
      drawPreview();
    };
    $('.p_deadline', tr).onchange = ev => { e.deadline = ev.target.value; drawPreview(); };
    $('.p_assignee', tr).onchange = ev => { e.assignee = ev.target.value.trim(); drawPreview(); };
  });
  $$('#previewArea tr[data-fi]').forEach(tr => {
    $('.u_pair', tr).onclick = () => run(async () => {
      const idx = $('.u_row', tr).value;
      if (!idx) { toast('짝지을 엑셀 행을 고르세요.', true); return; }
      const fi = Number(tr.dataset.fi);
      const row = await api('POST', `/api/import/${imp.parsed.import_id}/pair`, { row_idx: Number(idx), file_index: fi });
      const i = p.rows.findIndex(r => r.idx === row.idx);
      p.rows[i] = row; initEdit(row);
      p.unmatched = p.unmatched.filter(u => u.file_index !== fi);
      drawPreview(); toast('짝지었습니다. 식별 결과를 확인하세요.');
    });
  });
  const cb = $('#commitBtn');
  if (cb) cb.onclick = commitImport;
}
async function commitImport() {
  const p = imp.preview;
  const sel = p.rows.filter(r => imp.edits[r.idx].include);
  const bad = sel.filter(r => !TYPES.includes(imp.edits[r.idx].type));
  if (bad.length) { toast(`유형이 "회신/전파"가 아닌 ${bad.length}건이 선택되어 있습니다. 유형을 고르거나 선택을 해제하세요.`, true); return; }
  const noDl = sel.filter(r => !imp.edits[r.idx].deadline).length;
  if (noDl && !confirm(`기한이 비어 있는 ${noDl}건이 있습니다. 기한 없이 등록할까요? (나중에 상세 화면에서 넣을 수 있습니다)`)) return;
  const items = sel.map(r => {
    const e = imp.edits[r.idx];
    return {
      idx: r.idx, type: e.type, deadline: e.deadline, assignee: e.assignee,
      type_source: r.ident.type_auto && e.type === r.ident.type ? 'auto' : 'manual',
      deadline_source: r.ident.deadline_auto && e.deadline === r.ident.deadline ? 'auto' : 'manual',
    };
  });
  const res = await run(() => api('POST', `/api/import/${imp.parsed.import_id}/commit`, { items }));
  if (!res) return;
  await run(loadStaff);
  $('#mapArea').innerHTML = '';
  $('#previewArea').innerHTML = `<div class="panel">
    <h3>등록 결과</h3>
    <p><span class="pill green">${res.created}건 등록</span> ${res.skipped ? `<span class="pill gray">중복 ${res.skipped}건 건너뜀</span>` : ''}
    ${p.skipped_dup ? `<span class="pill gray">업로드 시 이미 등록된 문서 ${p.skipped_dup}건 건너뜀</span>` : ''}</p>
    ${res.errors.length ? `<ul>${res.errors.map(e => `<li style="color:var(--red)">${esc(e)}</li>`).join('')}</ul>` : ''}
    <p class="muted">등록된 업무는 처리자별로 각자의 목록에 들어갔습니다.</p>
    <div class="row"><a class="btn primary" href="#/">업무 목록 보기</a><button class="btn" id="againBtn">다른 파일 가져오기</button></div></div>`;
  $('#againBtn').onclick = renderImport;
  imp.files = []; drawFiles();
}

// ============================================================ ④ 설정
async function renderSettings() {
  app.innerHTML = '<p class="muted">불러오는 중…</p>';
  let rulesInfo = null;
  let stats = null;
  if (!(await run(async () => { [rulesInfo, stats] = await Promise.all([api('GET', '/api/settings/rules'), api('GET', '/api/admin/stats'), loadStaff(), loadTemplates()]); return true; }))) return;
  const cfg = rulesInfo.config;
  app.innerHTML = `
    <div class="cols">
      <div class="panel">
        <div class="row" style="margin-bottom:10px"><h2 style="margin:0">템플릿 관리</h2><span class="spacer"></span><button class="btn primary" id="tplNew">+ 새 템플릿</button></div>
        <p class="muted small">단계 기한은 업무의 최종 기한에서 "며칠 전"만큼 뺀 날로 계산됩니다. 템플릿을 고치거나 지워도 이미 적용된 업무의 단계는 바뀌지 않습니다.</p>
        <div id="tplList"></div>
      </div>
      <div>
        <div class="panel">
          <h2>담당자 명단</h2>
          <p class="muted small">비활성화한 담당자는 선택 목록에서 빠지지만, 기존 업무는 그대로 남습니다.</p>
          <table class="grid"><thead><tr><th>이름</th><th style="width:70px">활성</th><th style="width:70px"></th></tr></thead><tbody>
          ${state.staff.map(s => `<tr data-id="${s.id}"><td><input type="text" class="st_name" value="${esc(s.name)}" style="width:100%"></td>
            <td style="text-align:center"><input type="checkbox" class="st_active" ${s.active ? 'checked' : ''}></td>
            <td><button class="btn sm st_save">저장</button></td></tr>`).join('')}
          </tbody></table>
          <div class="row" style="margin-top:10px"><input type="text" id="stNew" placeholder="새 담당자 이름" style="flex:1"><button class="btn" id="stAdd">추가</button></div>
        </div>
        <div class="panel">
          <h2>자동 식별 키워드</h2>
          <p class="muted small">키워드는 서버의 설정 파일에서 고칩니다. 저장하면 다음 가져오기부터 바로 적용됩니다.<br><code>${esc(rulesInfo.path)}</code></p>
          <p><b>회신</b> <span class="muted">${esc(cfg.reply_keywords.join(', '))}</span></p>
          <p><b>전파</b> <span class="muted">${esc(cfg.spread_keywords.join(', '))}</span></p>
          <p><b>기한 문장</b> <span class="muted">${esc(cfg.deadline_context_keywords.join(', '))}</span></p>
        </div>
        <div class="panel danger-zone">
          <h2>데이터 초기화</h2>
          <p class="muted small">등록된 업무를 한꺼번에 삭제합니다. 부서 <b>전원</b>의 업무가 지워지며 되돌릴 수 없습니다.
            실행 직전 DB를 <code>backup\\before_reset_날짜.db</code>로 자동 백업하므로, 잘못 지웠다면 관리자가 그 파일로 복원할 수 있습니다.</p>
          <p>현재 업무 <b>${stats.tasks}</b>건 (가져오기 ${stats.imported} · 직접 등록 ${stats.direct}) · 단계 ${stats.steps}개 · 담당자 ${stats.staff}명</p>
          <div class="reset-opts">
            <label><input type="radio" name="rs_scope" value="imported" checked> 접수문서 가져오기로 등록한 업무만 삭제 (${stats.imported}건)</label>
            <label><input type="radio" name="rs_scope" value="all"> 직접 등록한 업무까지 전체 삭제 (${stats.tasks}건)</label>
            <label><input type="checkbox" id="rs_staff"> 담당자 명단도 비우기 <span class="muted small">(남아 있는 업무의 담당자는 유지)</span></label>
            <label><input type="checkbox" id="rs_mapping"> 저장된 엑셀 열 매핑도 지우기 ${stats.has_mapping ? '' : '<span class="muted small">(저장된 매핑 없음)</span>'}</label>
          </div>
          <p class="muted small" style="margin-bottom:6px">템플릿과 식별 키워드는 지워지지 않습니다. 계속하려면 아래 칸에 <b>초기화</b>라고 입력하세요.</p>
          <div class="row"><input type="text" id="rs_confirm" placeholder="초기화" style="width:140px"><button class="btn danger-solid" id="rs_run" disabled>삭제하고 초기화</button></div>
        </div>
      </div>
    </div>`;
  drawTemplates();
  const rsConfirm = $('#rs_confirm'), rsRun = $('#rs_run');
  rsConfirm.oninput = () => { rsRun.disabled = rsConfirm.value.trim() !== '초기화'; };
  rsRun.onclick = () => run(async () => {
    const scope = $('input[name=rs_scope]:checked').value;
    const n = scope === 'all' ? stats.tasks : stats.imported;
    if (!confirm(`업무 ${n}건을 삭제합니다. 부서 전원에게 적용되며 되돌릴 수 없습니다. 계속할까요?`)) return;
    const r = await api('POST', '/api/admin/reset', {
      confirm: rsConfirm.value, scope, staff: $('#rs_staff').checked, mapping: $('#rs_mapping').checked,
    });
    toast(`업무 ${r.deleted}건 삭제${r.staff_deleted ? `, 담당자 ${r.staff_deleted}명 삭제` : ''}. 백업: ${r.backup}`);
    await loadStaff();  // 선택한 담당자가 지워졌으면 다시 고르는 창이 뜬다
    if (state.me) renderSettings();
  });
  $('#tplNew').onclick = () => { state.templates.unshift({ id: null, name: '', steps: [{ name: '', days_before: 0 }] }); drawTemplates(); };
  $$('tr[data-id]').forEach(tr => {
    $('.st_save', tr).onclick = () => run(async () => {
      await api('PUT', `/api/staff/${tr.dataset.id}`, { name: $('.st_name', tr).value, active: $('.st_active', tr).checked });
      toast('저장했습니다.'); renderSettings();
    });
  });
  const addStaff = () => run(async () => {
    const name = $('#stNew').value.trim(); if (!name) return;
    await api('POST', '/api/staff', { name }); toast('추가했습니다.'); renderSettings();
  });
  $('#stAdd').onclick = addStaff;
  $('#stNew').onkeydown = e => { if (e.key === 'Enter') addStaff(); };
}
function drawTemplates() {
  const box = $('#tplList');
  if (!state.templates.length) { box.innerHTML = '<div class="empty">템플릿이 없습니다.</div>'; return; }
  box.innerHTML = state.templates.map((t, ti) => `<div class="tpl" data-ti="${ti}">
    <div class="row"><input type="text" class="tp_name" value="${esc(t.name)}" placeholder="템플릿 이름" style="flex:1;font-weight:700">
      <button class="btn sm primary tp_save">저장</button><button class="btn sm danger tp_del">삭제</button></div>
    <table style="margin-top:8px;width:100%"><tbody>
    ${t.steps.map((s, si) => `<tr data-si="${si}"><td style="width:24px" class="muted">${si + 1}</td>
      <td><input type="text" class="ts_name" value="${esc(s.name)}" placeholder="단계명" style="width:100%"></td>
      <td style="width:190px;white-space:nowrap">최종 기한 <input type="number" class="ts_days" value="${s.days_before}" min="0" style="width:56px"> 일 전</td>
      <td style="width:110px"><button class="btn sm ts_up" ${si === 0 ? 'disabled' : ''}>↑</button> <button class="btn sm ts_down" ${si === t.steps.length - 1 ? 'disabled' : ''}>↓</button> <button class="btn sm danger ts_del">×</button></td></tr>`).join('')}
    </tbody></table>
    <button class="btn sm ts_add" style="margin-top:6px">+ 단계 추가</button>
  </div>`).join('');
  $$('.tpl', box).forEach(el => {
    const t = state.templates[Number(el.dataset.ti)];
    const sync = () => {
      t.name = $('.tp_name', el).value;
      $$('tr[data-si]', el).forEach(tr => {
        const s = t.steps[Number(tr.dataset.si)];
        s.name = $('.ts_name', tr).value; s.days_before = Number($('.ts_days', tr).value) || 0;
      });
    };
    $('.ts_add', el).onclick = () => { sync(); t.steps.push({ name: '', days_before: 0 }); drawTemplates(); };
    $$('tr[data-si]', el).forEach(tr => {
      const si = Number(tr.dataset.si);
      $('.ts_del', tr).onclick = () => { sync(); t.steps.splice(si, 1); drawTemplates(); };
      const mv = d => { sync(); [t.steps[si], t.steps[si + d]] = [t.steps[si + d], t.steps[si]]; drawTemplates(); };
      $('.ts_up', tr).onclick = () => mv(-1);
      $('.ts_down', tr).onclick = () => mv(1);
    });
    $('.tp_save', el).onclick = () => run(async () => {
      sync();
      const payload = { name: t.name, steps: t.steps.filter(s => s.name.trim()) };
      if (t.id) await api('PUT', `/api/templates/${t.id}`, payload);
      else await api('POST', '/api/templates', payload);
      await loadTemplates(); drawTemplates(); toast('템플릿을 저장했습니다.');
    });
    $('.tp_del', el).onclick = () => run(async () => {
      if (!confirm(`템플릿 "${t.name || '(이름 없음)'}"을 삭제할까요?`)) return;
      if (t.id) await api('DELETE', `/api/templates/${t.id}`);
      await loadTemplates(); drawTemplates(); toast('삭제했습니다.');
    });
  });
}

// ============================================================ 시작
(async function start() {
  await run(loadStaff);
  render();
})();

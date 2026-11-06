const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const LANG_COLORS = {
  JavaScript: '#f1e05a', TypeScript: '#3178c6', Python: '#3572A5', Java: '#b07219', Go: '#00ADD8',
  Rust: '#dea584', 'C++': '#f34b7d', C: '#555555', 'C#': '#178600', PHP: '#4F5D95', Ruby: '#701516',
  HTML: '#e34c26', CSS: '#563d7c', Shell: '#89e051', Kotlin: '#A97BFF', Swift: '#F05138', Dart: '#00B4AB',
  Vue: '#41b883', Lua: '#000080', Svelte: '#ff3e00',
};

const state = {
  user: null,
  repos: [],
  deck: [],
  index: 0,
  history: [], // { repo, verdict }
  actions: new Map(), // full_name -> 'archive' | 'delete' | 'keep'
};

/* ---------- helpers ---------- */

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: { 'X-Requested-With': 'smash-or-pass', ...(options.headers || {}) },
  });
  if (res.status === 401) {
    show('login');
    throw new Error('Not signed in');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function show(name) {
  for (const s of $$('.screen')) s.hidden = s.id !== `screen-${name}`;
}

function relTime(iso) {
  if (!iso) return 'never';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  const units = [
    ['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60],
  ];
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, sec] of units) {
    if (diff >= sec) return rtf.format(-Math.floor(diff / sec), unit);
  }
  return 'just now';
}

function monthsSince(iso) {
  return iso ? (Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24 * 30.44) : Infinity;
}

function formatSize(kb) {
  if (kb < 1024) return `${kb} KB`;
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(1)} MB`;
  return `${(kb / 1024 / 1024).toFixed(1)} GB`;
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const c of [].concat(children)) node.append(c);
  return node;
}

/* ---------- boot ---------- */

async function boot() {
  const params = new URLSearchParams(location.search);
  if (params.has('error')) {
    const err = $('#login-error');
    err.textContent = 'Sign in failed. Please try again.';
    err.hidden = false;
    history.replaceState(null, '', '/');
  }

  try {
    const res = await fetch('/api/me', { credentials: 'same-origin' });
    if (!res.ok) return show('login');
    state.user = await res.json();
  } catch {
    return show('login');
  }

  $('#avatar').src = state.user.avatar_url;
  $('#login').textContent = state.user.login;
  $('#userbox').hidden = false;
  show('setup');
  await loadRepos();
}

async function loadRepos() {
  state.repos = [];
  updateFilterCount();
  $('#repo-count').textContent = 'Loading repos…';
  try {
    state.repos = await api('/api/repos');
    $('#repo-count').textContent = `${state.repos.length} repos found on your account.`;
    updateFilterCount();
  } catch (err) {
    $('#repo-count').textContent = `Could not load repos: ${err.message}`;
  }
}

/* ---------- filters ---------- */

function filteredRepos() {
  const f = new FormData($('#filters'));
  const age = Number(f.get('age'));
  return state.repos.filter((r) =>
    (f.get('forks') || !r.fork) &&
    (f.get('archived') || !r.archived) &&
    (f.get('private') || !r.private) &&
    monthsSince(r.pushed_at) >= age,
  );
}

function updateFilterCount() {
  const n = filteredRepos().length;
  $('#filter-count').textContent = `${n} repo${n === 1 ? '' : 's'} on the stack`;
  $('#filters button[type=submit]').disabled = n === 0;
}

$('#filters').addEventListener('change', updateFilterCount);
$('#filters').addEventListener('submit', (e) => {
  e.preventDefault();
  state.deck = filteredRepos();
  state.index = 0;
  state.history = [];
  state.actions.clear();
  show('swipe');
  renderStack();
});

/* ---------- cards ---------- */

function buildCard(repo) {
  const node = $('#card-tpl').content.firstElementChild.cloneNode(true);
  const color = LANG_COLORS[repo.language];
  if (color) node.querySelector('.lang-dot').style.background = color;
  node.querySelector('.lang').textContent = repo.language || 'No language';

  const badges = node.querySelector('.badges');
  if (repo.private) badges.append(el('span', { className: 'badge private', textContent: 'private' }));
  if (repo.fork) badges.append(el('span', { className: 'badge', textContent: 'fork' }));
  if (repo.archived) badges.append(el('span', { className: 'badge archived', textContent: 'archived' }));

  const link = node.querySelector('.card-title a');
  link.textContent = repo.name;
  link.href = repo.html_url;
  link.addEventListener('pointerdown', (e) => e.stopPropagation());

  const desc = node.querySelector('.card-desc');
  desc.textContent = repo.description || 'No description. Suspicious.';
  desc.classList.toggle('empty', !repo.description);

  node.querySelector('.pushed').textContent = relTime(repo.pushed_at);
  node.querySelector('.created').textContent = new Date(repo.created_at).getFullYear();
  node.querySelector('.stars').textContent = repo.stars;
  node.querySelector('.forks').textContent = repo.forks;
  node.querySelector('.issues').textContent = repo.open_issues;
  node.querySelector('.size').textContent = formatSize(repo.size_kb);

  const topics = node.querySelector('.topics');
  for (const t of repo.topics.slice(0, 6)) topics.append(el('span', { textContent: t }));

  // 0 months = 0%, 5 years or more = 100%
  const pct = Math.min(100, (monthsSince(repo.pushed_at) / 60) * 100);
  node.querySelector('.age-meter span').style.width = `${pct}%`;
  node.title = `Last push ${new Date(repo.pushed_at).toLocaleDateString('en')}`;
  return node;
}

function renderStack() {
  const stack = $('#stack');
  stack.replaceChildren();
  const visible = state.deck.slice(state.index, state.index + 3);
  visible.reverse().forEach((repo, i, arr) => {
    const card = buildCard(repo);
    const depth = arr.length - 1 - i;
    if (depth === 1) card.classList.add('behind');
    if (depth === 2) card.classList.add('behind-2');
    if (depth === 0) attachDrag(card);
    stack.append(card);
  });
  updateProgress();
  if (state.index >= state.deck.length) openReview();
}

function updateProgress() {
  const total = state.deck.length;
  const done = Math.min(state.index, total);
  $('#progress-bar').style.width = total ? `${(done / total) * 100}%` : '0';
  const passed = state.history.filter((h) => h.verdict === 'pass').length;
  $('#progress-text').textContent = `${done} / ${total} · ${passed} passed`;
  $('#btn-undo').disabled = state.history.length === 0;
}

function topCard() {
  return $('#stack .card:last-child');
}

function decide(verdict) {
  const repo = state.deck[state.index];
  const card = topCard();
  if (!repo || !card || card.dataset.leaving) return;
  card.dataset.leaving = '1';
  state.history.push({ repo, verdict });
  if (verdict === 'pass') state.actions.set(repo.full_name, repo.archived ? 'keep' : 'archive');
  else state.actions.delete(repo.full_name);

  const dir = verdict === 'smash' ? 1 : -1;
  card.classList.remove('dragging');
  card.style.transform = `translate(${dir * 140}%, -10%) rotate(${dir * 30}deg)`;
  card.style.opacity = '0';
  card.querySelector(verdict === 'smash' ? '.stamp-smash' : '.stamp-pass').style.opacity = '1';
  state.index++;
  setTimeout(renderStack, 260);
}

function undo() {
  const last = state.history.pop();
  if (!last) return;
  state.actions.delete(last.repo.full_name);
  state.index--;
  renderStack();
}

function attachDrag(card) {
  let startX = 0, startY = 0, dx = 0, dy = 0, dragging = false;
  const smash = card.querySelector('.stamp-smash');
  const pass = card.querySelector('.stamp-pass');

  card.addEventListener('pointerdown', (e) => {
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    card.setPointerCapture(e.pointerId);
    card.classList.add('dragging');
  });
  card.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dx = e.clientX - startX;
    dy = e.clientY - startY;
    card.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 18}deg)`;
    smash.style.opacity = Math.max(0, Math.min(1, dx / 100));
    pass.style.opacity = Math.max(0, Math.min(1, -dx / 100));
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    if (e.type === 'pointerup' && Math.abs(dx) > 110) return decide(dx > 0 ? 'smash' : 'pass');
    card.classList.remove('dragging');
    card.style.transform = '';
    smash.style.opacity = pass.style.opacity = '0';
    dx = dy = 0;
  };
  card.addEventListener('pointerup', end);
  card.addEventListener('pointercancel', end);
}

$('#btn-smash').addEventListener('click', () => decide('smash'));
$('#btn-pass').addEventListener('click', () => decide('pass'));
$('#btn-undo').addEventListener('click', undo);
$('#btn-finish-early').addEventListener('click', openReview);

document.addEventListener('keydown', (e) => {
  if ($('#screen-swipe').hidden || $('#confirm-dialog').open) return;
  if (e.key === 'ArrowRight') decide('smash');
  else if (e.key === 'ArrowLeft') decide('pass');
  else if (e.key === 'Backspace') { e.preventDefault(); undo(); }
});

/* ---------- review ---------- */

function passedRepos() {
  return state.history.filter((h) => h.verdict === 'pass').map((h) => h.repo);
}

function openReview() {
  show('review');
  renderReview();
}

function renderReview() {
  const list = $('#review-list');
  const repos = passedRepos();
  list.replaceChildren();
  $('#review-empty').hidden = repos.length > 0;
  $('.bulk').hidden = repos.length === 0;
  $('#btn-back-swipe').hidden = state.index >= state.deck.length;

  for (const repo of repos) {
    const current = state.actions.get(repo.full_name) || 'archive';
    const seg = el('div', { className: 'seg', role: 'group' });
    const options = repo.archived ? ['keep', 'delete'] : ['keep', 'archive', 'delete'];
    for (const act of options) {
      const b = el('button', { type: 'button', textContent: act[0].toUpperCase() + act.slice(1) });
      b.dataset.act = act;
      b.setAttribute('aria-pressed', String(current === act));
      b.addEventListener('click', () => {
        state.actions.set(repo.full_name, act);
        for (const other of seg.children) other.setAttribute('aria-pressed', String(other === b));
        updateSummary();
      });
      seg.append(b);
    }

    const link = el('a', { className: 'name', href: repo.html_url, target: '_blank', rel: 'noopener noreferrer', textContent: repo.full_name });
    const meta = el('div', { className: 'meta', textContent: `last push ${relTime(repo.pushed_at)} · ★ ${repo.stars}${repo.private ? ' · private' : ''}` });
    list.append(el('li', {}, [el('div', { className: 'info' }, [link, meta]), seg]));
  }
  updateSummary();
}

function counts() {
  const c = { keep: 0, archive: 0, delete: 0 };
  for (const repo of passedRepos()) c[state.actions.get(repo.full_name) || 'keep']++;
  return c;
}

function updateSummary() {
  const c = counts();
  $('#review-summary').textContent = `${c.archive} archive · ${c.delete} delete · ${c.keep} keep`;
  $('#btn-execute').disabled = c.archive + c.delete === 0;
}

$$('[data-bulk]').forEach((b) => b.addEventListener('click', () => {
  for (const repo of passedRepos()) {
    const act = b.dataset.bulk === 'archive' && repo.archived ? 'keep' : b.dataset.bulk;
    state.actions.set(repo.full_name, act);
  }
  renderReview();
}));

$('#btn-back-swipe').addEventListener('click', () => {
  show('swipe');
  renderStack();
});

/* ---------- execute ---------- */

function confirmRun(c) {
  const dialog = $('#confirm-dialog');
  const input = $('#confirm-input');
  const ok = $('#confirm-ok');
  const parts = [];
  if (c.archive) parts.push(`${c.archive} repo${c.archive === 1 ? '' : 's'} will be archived`);
  if (c.delete) parts.push(`${c.delete} repo${c.delete === 1 ? '' : 's'} will be deleted permanently`);
  $('#confirm-text').textContent = `${parts.join(' and ')}.`;

  const needsWord = c.delete > 0;
  const word = 'delete';
  $('#confirm-type-wrap').hidden = !needsWord;
  $('#confirm-word').textContent = word;
  input.value = '';
  ok.disabled = needsWord;
  input.oninput = () => { ok.disabled = input.value.trim().toLowerCase() !== word; };

  return new Promise((resolve) => {
    dialog.onclose = () => resolve(dialog.returnValue === 'ok');
    dialog.returnValue = '';
    dialog.showModal();
    if (needsWord) input.focus();
  });
}

$('#btn-execute').addEventListener('click', async () => {
  const c = counts();
  if (!(await confirmRun(c))) return;

  const todo = passedRepos()
    .map((repo) => ({ repo, act: state.actions.get(repo.full_name) }))
    .filter((t) => t.act === 'archive' || t.act === 'delete');

  show('done');
  const list = $('#result-list');
  list.replaceChildren();
  const restart = $('#btn-restart');
  restart.disabled = true;

  for (const { repo, act } of todo) {
    const status = el('span', { className: 'status', textContent: act === 'delete' ? 'deleting…' : 'archiving…' });
    list.append(el('li', {}, [el('div', { className: 'info' }, [el('div', { className: 'name', textContent: repo.full_name })]), status]));
    const path = `/api/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
    try {
      if (act === 'delete') await api(path, { method: 'DELETE' });
      else await api(`${path}/archive`, { method: 'POST' });
      status.textContent = act === 'delete' ? 'deleted' : 'archived';
      status.classList.add('ok');
    } catch (err) {
      status.textContent = `failed: ${err.message}`;
      status.classList.add('fail');
    }
  }
  restart.disabled = false;
});

$('#btn-restart').addEventListener('click', async () => {
  show('setup');
  await loadRepos();
});

$('#logout').addEventListener('click', async () => {
  const btn = $('#logout');
  btn.disabled = true;
  try {
    await api('/auth/logout', { method: 'POST' });
    location.href = '/';
  } catch (err) {
    if (err.message === 'Not signed in') return void (location.href = '/');
    btn.disabled = false;
    alert(`Sign out failed: ${err.message}. Please try again.`);
  }
});

boot();

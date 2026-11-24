// The arena dashboard: the four games, their runs, starting and stopping AI runs, through the
// server's API (docs/ARENA_CONTRACT.md §7). Routes: #  every game,  #<game>  one game's page.
//
// This is the operator's page, so it shows model ids (the viewers never do). Every value from the
// API reaches the page as text (textContent), never as HTML.

const REFRESH_MS = 4000;
const MOCK = 'mock';
// The game's own table options in the New run panel, with the engines' defaults.
const OPTIONS = {
  senate: [{ key: 'discussion_rounds', label: 'Discussion rounds', type: 'number', min: 1, max: 5, def: 1 }],
  poker: [{ key: 'hands', label: 'Hands per game', type: 'number', min: 1, max: 500, def: 50 },
          { key: 'duplicate', label: 'Duplicate pairs', type: 'checkbox', def: true },
          { key: 'table_talk', label: 'Table talk', type: 'checkbox', def: true }],
};

const $ = (id) => document.getElementById(id);
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids.flat().filter((k) => k != null && k !== false));
  return el;
}

let games = null;      // GET /api/games
let launchers = [];    // GET /api/launches
let models = [];       // GET /api/models
let budget = null;     // GET /api/budget
let route = null;      // the game whose page is open, null on the home page
let draft = null;      // the New run panel's table, edited in place
let tableList = [];    // GET /api/tables for the open game

async function get(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res.json();
}

// The server refuses a POST without this Content-Type, X-Arena and its own Origin (the browser adds it).
async function post(url, body) {
  const res = await fetch(url, { method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'X-Arena': '1' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

const when = (s) => (s ? new Date(s * 1000).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '—');
const money = (x) => (x == null ? '?' : `$${x.toFixed(2)}`);
const statusOf = (run) => (run.winner == null ? 'live' : run.winner === 'aborted' ? 'aborted' : 'finished');
const stat = (label, value, cls) => h('div', {}, h('dt', { text: label }), h('dd', { class: cls, text: String(value) }));
const winsText = (g) => Object.entries(g.wins).map(([k, n]) => `${k} ${n}`).join(' · ') || 'none yet';
const intOf = (id) => Number.parseInt($(id).value, 10);

function stats(g) {
  return [stat('Runs', g.runs), stat('Live', g.live, g.live ? 'hot' : null),
    stat(g.sides.length ? 'Wins by side' : 'Wins by model', winsText(g)),
    stat('Avg cost / game', g.avg_cost == null ? '—' : money(g.avg_cost))];
}

// ---------- home ----------

function renderCards() {
  $('cards').replaceChildren(...Object.entries(games).map(([key, g]) => h('a', { class: 'card glass', href: '#' + key },
    h('h2', { text: g.title }), h('p', { class: 'muted', text: g.description }), h('dl', { class: 'stats' }, stats(g)))));
}

// ---------- one game ----------

function renderGame() {
  const g = games[route];
  $('g-title').textContent = g.title;
  $('g-desc').textContent = g.description;
  $('g-stats').replaceChildren(...stats(g));
  $('g-viewer').href = `/${route}/`;
  const filter = $('filter').value;
  const runs = g.list.filter((run) => filter === 'all' || statusOf(run) === filter);
  $('runs').replaceChildren(...runs.map((run) => h('tr', {},
    h('td', { class: 'mono', text: run.id }),
    h('td', { text: when(run.started) }),
    h('td', { class: 'models', text: (run.models ?? []).join(', ') }),
    h('td', {}, h('span', { class: 'badge ' + statusOf(run), text: statusOf(run) })),
    h('td', { text: run.winner && run.winner !== 'aborted'
      ? run.winner + (run.seats?.[run.winner] ? ` (${run.seats[run.winner]})` : '') : '—' }),
    h('td', {}, h('a', { href: `/${route}/?game=${encodeURIComponent(run.id)}`, text: 'Watch' })))));
  $('runs-empty').hidden = runs.length > 0;
  $('runs-empty').textContent = g.list.length ? 'No runs with this status.' : 'No runs yet.';
  renderEstimate();
}

// ---------- New run ----------

async function openNewRun(game) {
  $('nr-status').textContent = '';
  tableList = await get(`/api/tables?game=${game}`).catch(() => []);
  if (route !== game) return;   // the user moved on meanwhile
  $('nr-table').replaceChildren(...tableList.map((t, i) => h('option', { value: i, text: t.path })),
    h('option', { value: '', text: '(empty table)' }));
  // a mock table first: the panel never opens on a paid table by default
  const first = tableList.findIndex((t) => t.table.players?.every?.((seat) => seat.model === MOCK));
  $('nr-table').value = String(first >= 0 ? first : tableList.length ? 0 : '');
  pickTable();
  budget = null;
  renderBudget();
  get('/api/budget').then((b) => { budget = b; renderBudget(); }, () => {});
}

function pickTable() {
  const picked = tableList[$('nr-table').value];
  draft = structuredClone(picked?.table ?? {});
  if (!Array.isArray(draft.players)) draft.players = [];
  for (const o of OPTIONS[route] ?? []) draft[o.key] ??= o.def;
  renderSeats();
  renderOptions();
  renderEstimate();
}

function select(values, current, onchange, label) {
  // a value the list doesn't know (a saved table's model, say) stays as it is
  const all = current && !values.some(([v]) => v === current) ? [[current, current], ...values] : values;
  const el = h('select', { 'aria-label': label, onchange: (e) => onchange(e.target.value) },
    all.map(([v, text]) => h('option', { value: v, text })));
  el.value = current ?? '';
  return el;
}

function renderSeats() {
  const roles = games[route].roles;
  const modelValues = models.map((m) => [m.id, m.id === m.label ? m.id : `${m.label} · ${m.id}`]);
  $('nr-seats').replaceChildren(...draft.players.map((seat, i) => h('div', { class: 'seat' + (roles.length ? '' : ' no-role') },
    h('span', { class: 'seat-n', text: String(i + 1) }),
    roles.length > 0 && select(roles.map((r) => [r, r]), seat.role, (v) => { seat.role = v; }, `Seat ${i + 1} role`),
    select(modelValues, seat.model, (v) => { seat.model = v; renderEstimate(); }, `Seat ${i + 1} model`),
    h('button', { type: 'button', class: 'btn', 'aria-label': `Remove seat ${i + 1}`, text: '×',
      onclick: () => { draft.players.splice(i, 1); renderSeats(); renderEstimate(); } }))));
}

function addSeat() {
  const roles = games[route].roles;
  const last = draft.players.at(-1);
  draft.players.push({ ...(roles.length ? { role: roles.at(-1) } : {}), model: last?.model ?? MOCK });
  renderSeats();
  renderEstimate();
}

function renderOptions() {
  $('nr-options').replaceChildren(...(OPTIONS[route] ?? []).map((o) => {
    const input = h('input', { type: o.type, min: o.min, max: o.max });
    if (o.type === 'checkbox') {
      input.checked = !!draft[o.key];
      input.addEventListener('change', () => { draft[o.key] = input.checked; renderEstimate(); });
      return h('label', { class: 'check' }, input, o.label);
    }
    input.value = draft[o.key];
    input.addEventListener('input', () => { draft[o.key] = Number.parseInt(input.value, 10); });
    return h('label', { class: 'field' }, o.label, input);
  }));
}

// The table the launcher gets: the draft, with the variant that makes it this game's.
function launchTable() {
  const table = structuredClone(draft);
  if (route === 'misinformation') table.variant = 'misinformation';
  if (route === 'mafia') delete table.variant;
  return table;
}

// Every model the run will call. Mafia also calls its narrator: the table's "moderator" (null: none),
// else the default one unless every seat is mock (run_autonomous.get_moderator_model).
function paidModels(table) {
  const seats = table.players.map((seat) => seat.model);
  const fallback = games[route].default_moderator;
  const moderator = !fallback ? null : 'moderator' in table ? table.moderator
    : seats.every((m) => m === MOCK) ? MOCK : fallback;
  return [...new Set([...seats, moderator])].filter((m) => typeof m === 'string' && m !== '' && m !== MOCK);
}
const usesRealModel = (table) => paidModels(table).length > 0;

function estimate(table, n) {
  if (!usesRealModel(table)) return 'Estimated cost: $0 (mock seats only, no model is called)';
  const avg = games[route].avg_cost;
  const count = n * (route === 'poker' && table.duplicate !== false ? 2 : 1);   // duplicate: n pairs
  if (avg == null) return `Estimated cost: unknown (no finished paid ${games[route].title} run to average) for ${count} games`;
  return `Estimated cost: about ${money(avg * count)} (${money(avg)} per game × ${count} games)`;
}

function renderEstimate() {
  if (route && draft) $('nr-estimate').textContent = estimate(launchTable(), intOf('nr-games') || 0);
}

function renderBudget() {
  const b = budget;
  $('nr-budget').textContent = !b ? 'Key budget: loading…'
    : b.error ? `Key budget: ${b.error}. ${b.note}`
    : b.limit == null ? `Key budget: no limit set on this key (${money(b.usage)} used). ${b.note}`
    : `Key budget: ${money(b.remaining)} left of ${money(b.limit)}. ${b.note}`;
}

function confirmPaid(table, n) {
  const dialog = $('confirm');
  $('confirm-text').textContent = `${n} × ${games[route].title} with ${$('nr-parallel').value} in parallel. `
    + `${estimate(table, n)}. ${$('nr-budget').textContent}`;
  $('confirm-models').replaceChildren(...paidModels(table).map((m) => h('li', { text: m })));
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'start'), { once: true }));
}

async function start() {
  const game = route, table = launchTable(), n = intOf('nr-games'), parallel = intOf('nr-parallel');
  const status = $('nr-status');
  if (usesRealModel(table) && !(await confirmPaid(table, n))) return;
  $('nr-start').disabled = true;
  status.className = 'status';
  status.textContent = 'Checking the table and starting…';
  try {
    const r = await post('/api/launch', { game, table, games: n, parallel });
    status.textContent = `Started launcher ${r.pid}. The table is saved as ${r.table}.`;
    await refresh();
  } catch (err) {
    status.className = 'status bad';
    status.textContent = err.message;
  } finally {
    $('nr-start').disabled = false;
  }
}

// ---------- launchers ----------

function renderLaunchers() {
  const list = launchers.filter((l) => !route || l.game === route);
  $('launchers').replaceChildren(...(list.length ? list.map((l) => h('article', { class: 'launcher' },
    h('div', { class: 'launcher-head' },
      h('strong', { text: games?.[l.game]?.title ?? l.game }),
      h('span', { class: 'badge ' + (l.running ? 'live' : l.exit_code === 0 ? 'finished' : 'aborted'),
        // "unknown": it ended while no server watched it (it outlives a server restart)
        text: l.running ? 'running' : l.exit_code === 'unknown' ? 'ended' : `exited ${l.exit_code}` }),
      h('span', { class: 'muted small', text: `pid ${l.pid} · ${l.games} × ${l.parallel} parallel · ${when(l.started)} · ${l.table}` }),
      l.running && h('button', { type: 'button', class: 'btn danger', text: 'Stop', onclick: () => stopLauncher(l) })),
    h('pre', { class: 'log', text: l.log.join('\n') || '(no output yet)' })))
    : [h('p', { class: 'muted', text: `No launcher started by this server${route ? ' for this game' : ''}.` })]));
}

async function stopLauncher(l) {
  if (!confirm(`Stop launcher ${l.pid}? Its running games are aborted.`)) return;
  try { await post('/api/stop', { pid: l.pid }); } catch (err) { alert(err.message); }
  await refresh();
}

// ---------- routing and refresh ----------

async function refresh() {
  try {
    [games, launchers] = await Promise.all([get('/api/games'), get('/api/launches')]);
    $('conn').textContent = '';
  } catch {
    $('conn').textContent = 'The server does not answer';
    return;
  }
  renderCards();
  if (route) renderGame();
  renderLaunchers();
}

function go() {
  const key = location.hash.slice(1);
  route = games && Object.hasOwn(games, key) ? key : null;
  $('home').hidden = !!route;
  $('game').hidden = !route;
  document.title = route ? `${games[route].title} · Arena` : 'Arena';
  if (route) {
    $('filter').value = 'all';
    renderGame();
    openNewRun(route);
  }
  renderLaunchers();
  scrollTo(0, 0);
}

$('filter').addEventListener('change', () => renderGame());
$('nr-table').addEventListener('change', pickTable);
$('nr-add').addEventListener('click', addSeat);
$('nr-games').addEventListener('input', renderEstimate);
$('nr-start').addEventListener('click', start);
addEventListener('hashchange', go);

models = await get('/api/models').catch(() => []);
await refresh();
go();
setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);

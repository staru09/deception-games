// The arena dashboard: the four games, starting and stopping AI runs, through the
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

// Each game is a court card: its rank and suit in the corners, its emblem in the middle.
const COURT = {
  mafia: { rank: 'J', suit: '♠', emblem: 'dagger' },
  misinformation: { rank: 'Q', suit: '♦', emblem: 'masks' },
  senate: { rank: 'K', suit: '♣', emblem: 'columns' },
  poker: { rank: 'A', suit: '♥', emblem: 'cards' },
};
// Line-art emblems (our own static markup, never data from the API), drawn in currentColor.
const LAUREL = [[46, 90, -10], [34, 86, -25], [24, 78, -40], [17, 68, -55], [13, 57, -70], [12, 46, -85]]
  .map(([x, y, a]) => `<ellipse cx="${x}" cy="${y}" rx="6.5" ry="2.6" transform="rotate(${a} ${x} ${y})"/>`).join('');
const CROWN = '<path d="M10 46 6 20l14 12 12-20 12 20 14-12-4 26Z"/><path d="M12 53h40"/><circle cx="6" cy="17" r="2.6"/><circle cx="32" cy="9" r="2.6"/><circle cx="58" cy="17" r="2.6"/><circle cx="32" cy="37" r="3.2"/>';
const EMBLEMS = {
  crown: ['0 0 64 64', CROWN],
  crest: ['0 0 120 100', `<g transform="translate(36 14) scale(.75)">${CROWN}</g><path d="M56 93C30 88 14 70 12 42"/>${LAUREL}<g transform="translate(120 0) scale(-1 1)"><path d="M56 93C30 88 14 70 12 42"/>${LAUREL}</g>`],
  dagger: ['0 0 64 64', '<path d="M32 5l5 8v27H27V13Z"/><path d="M32 11v26"/><path d="M19 40h26"/><path d="M29 41v11h6V41"/><circle cx="32" cy="56" r="3.5"/>'],
  masks: ['0 0 64 64', '<path d="M7 13c8-4 16-4 24 0 0 17-4 27-12 29C11 40 7 30 7 13Z"/><path d="M12 22q3-3 6 0M21 22q3-3 6 0M13 30q6 6 12 0"/><path d="M33 21c8-4 16-4 24 0 0 17-4 27-12 29-8-2-12-12-12-29Z"/><path d="M38 31q3 2 6 0M47 31q3 2 6 0M40 42q5-5 10 0"/>'],
  columns: ['0 0 64 64', '<path d="M8 22 32 8l24 14Z"/><path d="M10 26h44"/><path d="M15 29v19M25 29v19M39 29v19M49 29v19"/><path d="M10 51h44M6 57h52"/>'],
  cards: ['0 0 64 64', '<rect x="11" y="12" width="26" height="38" rx="4" transform="rotate(-12 24 31)"/><rect x="27" y="14" width="26" height="38" rx="4" transform="rotate(10 40 33)"/><path d="M40 39l-6-6c-3-4 2-8 6-4 4-4 9 0 6 4Z"/>'],
};
const svg = (name) => `<svg viewBox="${EMBLEMS[name][0]}" aria-hidden="true" focusable="false">${EMBLEMS[name][1]}</svg>`;

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
  const all = Object.values(games);
  const sum = (f) => all.reduce((n, g) => n + f(g), 0);
  const num = (n) => h('b', { text: String(n) });
  $('tally').replaceChildren(num(all.length), ' courts · ', num(sum((g) => g.runs)), ' games played · ',
    num(sum((g) => g.live)), ' live now');
  $('cards').replaceChildren(...Object.entries(games).map(([key, g]) => {
    const court = COURT[key] ?? { rank: '?', suit: '◆', emblem: 'crown' };
    const pip = (where) => h('span', { class: 'pip ' + where, 'aria-hidden': 'true' },
      h('b', { text: court.rank }), h('i', { text: court.suit }));
    const medal = h('span', { class: 'medal' });
    medal.innerHTML = svg(court.emblem);   // static markup from EMBLEMS
    return h('a', { class: 'card', href: '#' + key, 'data-game': key },
      pip('tl'), pip('br'),
      g.live ? h('span', { class: 'live-tag', text: `${g.live} live` }) : null,
      medal,
      h('h2', { text: g.title }),
      h('p', { class: 'desc', text: g.description }),
      h('dl', { class: 'stats' }, stats(g)),
      h('span', { class: 'enter', text: 'Enter the court' }));
  }));
}

// ---------- one game ----------

function renderGame() {
  const g = games[route];
  $('game').dataset.game = route;
  $('g-emblem').innerHTML = svg(COURT[route]?.emblem ?? 'crown');   // static markup from EMBLEMS
  $('g-title').textContent = g.title;
  $('g-desc').textContent = g.description;
  $('g-stats').replaceChildren(...stats(g));
  $('g-viewer').href = `/${route}/`;
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
  // as in the experiment tables the average cost comes from; an empty table would run models at their own defaults
  draft.llm_defaults ??= { reasoning: { effort: 'low' } };
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
    input.addEventListener('input', () => { draft[o.key] = Number.parseInt(input.value, 10); renderEstimate(); });
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
  const settings = ` Model settings (llm_defaults): ${JSON.stringify(table.llm_defaults ?? {})}.`;
  if (avg == null) return `Estimated cost: unknown (no finished paid ${games[route].title} run to average) for ${count} games.${settings}`;
  // assumption: the average comes from 50-hand Poker games and 1-round Senate discussions; cost grows linearly with both
  const scale = route === 'poker' ? (table.hands ?? 50) / 50 : route === 'senate' ? (table.discussion_rounds ?? 1) : 1;
  const per = avg * scale;
  return `Estimated cost: about ${money(per * count)} (${money(per)} per game × ${count} games${scale !== 1 ? `, average scaled ×${scale}` : ''}).${settings}`;
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
    + `${estimate(table, n)} ${$('nr-budget').textContent}`;
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
  document.body.dataset.route = route ?? 'home';
  document.title = route ? `${games[route].title} · Arena` : 'Arena';
  if (route) {
    renderGame();
    openNewRun(route);
  }
  renderLaunchers();
  scrollTo(0, 0);
}

$('nr-table').addEventListener('change', pickTable);
$('nr-add').addEventListener('click', addSeat);
$('nr-games').addEventListener('input', renderEstimate);
$('nr-start').addEventListener('click', start);
addEventListener('hashchange', go);

for (const el of document.querySelectorAll('[data-emblem]')) el.innerHTML = svg(el.dataset.emblem);
document.body.dataset.route = 'home';
models = await get('/api/models').catch(() => []);
await refresh();
go();
setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);

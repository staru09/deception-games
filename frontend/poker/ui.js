// Draws the poker table, hand list, chip graph and action log from the reducer's state.
// Names only (never model names). Everything is rebuilt on each render: the state is tiny.

const $ = (id) => document.getElementById(id);
const SUITS = { s: '♠', h: '♥', d: '♦', c: '♣' };
const RANK = (r) => (r === 'T' ? '10' : r);
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sign = (n) => (n > 0 ? `+${n}` : String(n));
const WORD = { fold: 'folds', check: 'checks', call: 'calls', bet: 'bets', raise: 'raises to' };
const SEAT_COLOR = ['var(--gold)', 'var(--night)'];

const card = (c, cls = '') => c
  ? `<span class="card ${'hd'.includes(c[1]) ? 'red' : ''} ${cls}" aria-label="${RANK(c[0])} of ${{ s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' }[c[1]]}"><b>${RANK(c[0])}</b><i>${SUITS[c[1]]}</i></span>`
  : '<span class="card back" aria-label="face-down card"></span>';

function seat(s, name, i) {
  const won = s.result?.winners.includes(name);
  const delta = s.result?.deltas[name];
  const hit = won ? new Set(s.best[name] ?? []) : new Set();
  const cards = s.hole[name] ?? [null, null];
  const last = s.lastAct[name];
  const tag = last && (last.all_in ? 'all-in' : last.action === 'blind' ? `blind ${last.to}` : last.action === 'bet' || last.action === 'raise' ? `${last.action} ${last.to}` : last.action);
  return `<div class="seat ${s.turn === name ? 'turn' : ''} ${won ? 'won' : ''} ${i ? 'top' : 'bottom'}">
    <div class="who"><span class="dot" style="background:${SEAT_COLOR[i]}"></span><b>${esc(name)}</b>
      ${s.button === name ? '<span class="btn-chip" title="Dealer button">D</span>' : ''}
      <span class="stack">${s.stacks[name]}</span>${delta !== undefined ? `<span class="delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : ''}">${sign(delta)}</span>` : ''}</div>
    <div class="hole">${cards.map((c) => card(c, hit.has(c) ? 'hit' : '')).join('')}</div>
    <div class="meta">${tag ? `<span class="tag">${esc(tag)}</span>` : ''}${s.bets[name] > 0 ? `<span class="bet">${s.bets[name]}</span>` : ''}
      ${s.handName[name] ? `<span class="hname">${esc(s.handName[name])}</span>` : ''}</div>
    ${s.say?.player === name ? `<div class="say">${esc(s.say.text)}</div>` : ''}
  </div>`;
}

function felt(s) {
  const [a, b] = s.names;
  const over = s.over;
  const verdict = over && (over.winner === 'draw' ? 'The match is a draw' : `${esc(over.winner)} wins the match`);
  const board = Array.from({ length: 5 }, (_, i) => {
    const hit = s.result && s.result.winners.some((w) => (s.best[w] ?? []).includes(s.board[i]));
    return s.board[i] ? card(s.board[i], hit ? 'hit' : '') : '<span class="card empty"></span>';
  }).join('');
  return `${seat(s, b, 1)}
    <div class="center">
      <div class="board">${board}</div>
      <div class="pot">Pot <b>${s.pot}</b>${s.street ? ` <span class="street">${s.street}</span>` : ''}</div>
      ${s.result ? `<div class="result">${s.result.winners.length > 1 ? 'Split pot' : `${esc(s.result.winners[0])} wins ${s.result.pot}`}</div>` : ''}
      ${over ? `<div class="over">${verdict}<small>${esc(a)} ${sign(over.totals[a])} &middot; ${esc(b)} ${sign(over.totals[b])}</small></div>` : ''}
    </div>
    ${seat(s, a, 0)}`;
}

function chart(s) {
  const W = 300, H = 120, P = 8, n = Math.max(s.hands ?? 0, s.series.length, 1);
  const pts = (name) => [0, ...s.series.map((t) => t[name])];
  const all = [0, ...s.names.flatMap((nm) => pts(nm))];
  const hi = Math.max(...all, 1), lo = Math.min(...all, -1);
  const x = (i) => P + (i / n) * (W - 2 * P), y = (v) => P + ((hi - v) / (hi - lo)) * (H - 2 * P);
  const lines = s.names.map((nm, i) => `<polyline fill="none" stroke="${SEAT_COLOR[i]}" stroke-width="2" stroke-linejoin="round" points="${pts(nm).map((v, j) => `${x(j).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}"/>`);
  const legend = s.names.map((nm, i) => `<span><i style="background:${SEAT_COLOR[i]}"></i>${esc(nm)} <b>${sign(s.totals[nm])}</b></span>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Running chip totals by hand">
    <line x1="${P}" x2="${W - P}" y1="${y(0)}" y2="${y(0)}" class="zero"/>${lines.join('')}</svg>
    <div class="legend">${legend}</div>`;
}

function entry(e) {
  switch (e.kind) {
    case 'hand': return `<div class="row hand">Hand ${e.hand} <small>${esc(e.button)} has the button</small></div>`;
    case 'street': return `<div class="row street">${e.name} ${e.board.slice(e.name === 'flop' ? 0 : -1).map((c) => card(c, 'mini')).join('')}</div>`;
    case 'refund': return `<div class="row note">${esc(e.player)} gets ${e.amount} back (uncalled)</div>`;
    case 'showdown': return `<div class="row note">${esc(e.player)} shows ${e.cards.map((c) => card(c, 'mini')).join('')} ${esc(e.name)}</div>`;
    case 'result': return `<div class="row result">${e.winners.length > 1 ? 'Split pot' : `${esc(e.winners[0])} wins ${e.pot}`}</div>`;
    default: return `<div class="row"><b>${esc(e.player)}</b> ${WORD[e.action]}${e.action === 'bet' || e.action === 'raise' ? ` ${e.to}` : e.action === 'call' ? ` ${e.amount}` : ''}${e.all_in ? ' <em>all-in</em>' : ''}
      ${e.say ? `<div class="bubble">${esc(e.say)}</div>` : ''}</div>`;
  }
}

let logShown = { list: null, n: 0 };   // the log array drawn and how many entries of it
let handIndex = { n: -1, starts: [] };   // hand number -> index of its hand_start, rebuilt when events arrive
function starts(events) {
  if (handIndex.n !== events.length) {
    handIndex = { n: events.length, starts: [] };
    events.forEach((e, i) => { if (e.type === 'hand_start') handIndex.starts.push({ hand: e.hand, i }); });
  }
  return handIndex.starts;
}

function hands(s, ctx) {
  const el = $('hands'), list = starts(ctx.events);
  if (el.dataset.n !== String(list.length)) {   // rebuilt only when hands are added: keeps keyboard focus
    el.dataset.n = list.length;
    el.innerHTML = list.map(({ hand }) => `<button type="button" data-hand="${hand}">${hand}<small></small></button>`).join('')
      || '<span class="muted">No hands yet</span>';
    el.onclick = (e) => {
      const h = e.target.closest('button[data-hand]');
      const x = h && list.find((y) => y.hand === +h.dataset.hand);
      if (x) ctx.seek(x.i + 1);   // with the hand_start applied
    };
  }
  const done = new Map(s.results.map((r) => [r.hand, r]));
  el.title = `Change shown is ${s.names[0]}'s`;
  for (const b of el.querySelectorAll('button')) {
    const r = done.get(+b.dataset.hand), d = r?.deltas[s.names[0]];
    if (+b.dataset.hand === s.hand) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
    const small = b.firstElementChild;
    small.textContent = r ? sign(d) : '';
    small.className = d > 0 ? 'up' : d < 0 ? 'down' : '';
  }
}

export function render(s, ctx) {
  $('felt').setAttribute('role', 'group');
  $('felt').innerHTML = felt(s);
  $('chart').innerHTML = chart(s);
  const log = $('log');
  if (s.log !== logShown.list || s.log.length < logShown.n) {   // a new hand or a seek: start over
    log.innerHTML = '';
    logShown = { list: s.log, n: 0 };
  }
  if (s.log.length > logShown.n) {
    const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
    log.insertAdjacentHTML('beforeend', s.log.slice(logShown.n).map(entry).join(''));
    logShown.n = s.log.length;
    if (stick) log.scrollTop = log.scrollHeight;
  }
  hands(s, ctx);
  $('sub').textContent = `Game ${ctx.id}${s.hand ? ` · hand ${s.hand}${s.hands ? ` of ${s.hands}` : ''}` : ''}`;
}

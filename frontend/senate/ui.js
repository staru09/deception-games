// Senate UI: render(state, ctx, has3d) redraws the transcript and either the caption over the 3D chamber
// (has3d) or the 2D board, the fallback when WebGL or the CDN fails and with ?scene=off. Names only,
// never models. Roles show in god view and after game_over; secret events only ever reach us in god view.
import { powerSlots, REFORMS_TO_WIN, DECREES_TO_WIN, CHAOS_AT } from './state.js';

const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const $ = (id) => document.getElementById(id);

const POWER = {   // label and a 24px icon path (stroke only)
  peek: ['Peek', '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>'],
  investigate: ['Investigate', '<circle cx="10" cy="10" r="6"/><path d="M15 15l7 7"/>'],
  special_election: ['Special election', '<path d="M3 18l2-11 5 5 2-8 2 8 5-5 2 11z"/>'],
  execution: ['Execution', '<path d="M5 5l14 14M19 5L5 19"/><circle cx="12" cy="12" r="9"/>'],
};
const icon = (k) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${POWER[k][1]}</svg>`;
const cap = (x) => x[0].toUpperCase() + x.slice(1);
const ROLE = { loyalist: 'Loyalist', conspirator: 'Conspirator', usurper: 'Usurper' };
const SIDE = { loyalist: 'good', conspirator: 'bad', usurper: 'bad' };
const REASON = { reforms: 'five Reforms enacted', decrees: 'six Decrees enacted', usurper_executed: 'the Usurper was executed', usurper_elected: 'the Usurper was elected Prefect' };

const card = (law, back) => back
  ? '<span class="law back" title="Face-down law"><b>?</b></span>'
  : `<span class="law ${law}"><b>${law === 'reform' ? 'Reform' : 'Decree'}</b></span>`;

function tracks(s) {
  const slots = powerSlots(s.players.length);
  const reform = Array.from({ length: REFORMS_TO_WIN }, (_, i) =>
    `<li class="slot reform${i < s.reforms ? ' full' : ''}">${i < s.reforms ? '<b>Reform</b>' : ''}</li>`).join('');
  const decree = slots.map((p, i) => `<li class="slot decree${i < s.decrees ? ' full' : ''}" title="${i === DECREES_TO_WIN - 1 ? 'Conspiracy wins' : p ? POWER[p][0] : ''}">${
    i < s.decrees ? '<b>Decree</b>' : ''}${i === DECREES_TO_WIN - 1 ? '<small>Conspiracy wins</small>'
    : p ? `${icon(p)}<small>${POWER[p][0]}</small>` : ''}</li>`).join('');
  const dots = Array.from({ length: CHAOS_AT }, (_, i) => `<i class="dot${i < s.tracker ? ' on' : ''}"></i>`).join('');
  return `<div class="tracks">
    <div><h3>Reform <span>${s.reforms} of ${REFORMS_TO_WIN}</span></h3><ol class="track">${reform}</ol></div>
    <div><h3>Decree <span>${s.decrees} of ${DECREES_TO_WIN}</span></h3><ol class="track">${decree}</ol></div>
    <div class="fails" title="At ${CHAOS_AT} failed votes the top law is enacted"><h3>Failed votes</h3><span class="dots">${dots}</span>
      <small>Deck ${s.drawPile} &middot; discards ${s.discardPile}</small></div></div>`;
}

function seats(s, ctx, roleOf) {
  const n = s.players.length;
  return `<ol class="seats n${n}">${s.players.map((p, i) => {
    const t = n > 1 ? Math.PI * i / (n - 1) : Math.PI / 2;   // an arc from left, over the top, to right
    const role = roleOf(p.name);
    const off = [s.consul === p.name && '<span class="badge consul">Consul</span>', s.prefect === p.name && '<span class="badge prefect">Prefect</span>'];
    const chip = p.alive && p.vote !== null ? `<span class="chip ${p.vote ? 'aye' : 'nay'}">${p.vote ? 'Aye' : 'Nay'}</span>` : '';
    const speaking = ['debate', 'report'].includes(s.step.kind) && s.step.speaker === p.name;
    return `<li class="seat${p.alive ? '' : ' dead'}${speaking ? ' speaking' : ''}${role ? ` ${SIDE[role]}` : ''}" style="--x:${(50 - 50 * Math.cos(t)).toFixed(1)}%;--y:${(84 - 68 * Math.sin(t)).toFixed(1)}%">
      <b class="nm">${esc(p.name)}</b>
      <span class="tags">${off.filter(Boolean).join('')}${role ? `<span class="badge role ${SIDE[role]}">${ROLE[role]}</span>` : ''}</span>
      ${chip}${p.alive ? '' : '<span class="x">Executed</span>'}
      ${p.checked ? `<span class="badge chk ${p.checked === 'loyalist' ? 'good' : 'bad'}">${p.checked}</span>` : p.investigated ? '<span class="badge chk">Investigated</span>' : ''}
    </li>`;
  }).join('')}</ol>`;
}

function stage(s, ctx, compact) {   // compact: the 3D chamber shows the cards and the speech itself
  const st = s.step, god = ctx.god;
  let head = '', body = '';
  switch (st.kind) {
    case 'start': head = 'The Senate gathers'; break;
    case 'nominate': head = `${esc(s.consul)} chooses a Prefect`; body = 'Round ' + s.round; break;
    case 'debate': head = 'Debate'; body = `${esc(s.consul)} proposes ${esc(s.prefect)} as Prefect.`; break;
    case 'report': head = 'Report'; body = `${esc(s.consul)} and ${esc(s.prefect)} account for the law.`; break;
    case 'vote': head = 'Vote'; body = 'Every living senator votes Aye or Nay.'; break;
    case 'result':
      head = st.passed ? `Passed, ${st.ayes} to ${st.nays}` : `Failed, ${st.ayes} to ${st.nays}`;
      body = st.passed ? `${esc(s.consul)} and ${esc(s.prefect)} take office.` : `Failed votes: ${s.tracker} of ${CHAOS_AT}.`;
      if (st.passed && s.hand && !compact) body += `<div class="hand">${handHtml(s, god)}</div>`;
      break;
    case 'veto':
      head = st.accepted ? 'Veto accepted' : 'Veto refused';
      body = st.accepted ? 'Both laws are discarded and the failed votes grow.' : `${esc(s.prefect)} must enact a law.`;
      break;
    case 'enacted':
      head = st.by === 'chaos' ? 'Chaos' : `${esc(st.by)} enacts`;
      body = compact ? `A ${cap(st.law)} goes on its track.` : `<div class="hand">${card(st.law)}</div>`;
      if (st.by === 'chaos') body += compact ? ' Three failed votes: the top law is enacted.' : '<p>Three failed votes: the top law is enacted.</p>';
      break;
    case 'power': {
      head = POWER[st.power][0];
      const who = esc(st.by);
      body = st.power === 'peek' ? `${who} looks at the top three laws.` : `${who} targets ${esc(st.target)}.`;
      if (st.result && god) body += `<p class="secret">${Array.isArray(st.result) ? (compact ? `The top three: ${st.result.join(', ')}.` : st.result.map((l) => card(l)).join('')) : `${esc(st.target)} is ${esc(st.result)}.`}</p>`;
      if (st.executed) body += `<p>${esc(st.executed)} is executed.</p>`;
      break;
    }
    case 'over': {
      const win = s.over.winner === 'loyalists';
      head = win ? 'Loyalists win' : 'Conspiracy wins'; body = esc(REASON[s.over.reason] ?? s.over.reason);
      break;
    }
  }
  if (['debate', 'report'].includes(st.kind) && st.speaker && !compact) body += `<blockquote><b>${esc(st.speaker)}</b> ${esc(st.text)}</blockquote>`;
  return `<div class="stage ${st.kind === 'over' ? (s.over.winner === 'loyalists' ? 'good' : 'bad') : ''}"><h2>${head}</h2><div>${body}</div></div>`;
}

function handHtml(s, god) {
  const h = s.hand;
  if (!god || !h.cards) return `${Array.from({ length: 3 }, () => card(null, true)).join('')}<small>Drawn in secret</small>`;
  const who = h.n === 3 ? s.consul : s.prefect;
  return `${h.cards.map((l) => card(l)).join('')}<small>${esc(who)} holds ${h.n}</small>`;
}

function transcript(rows, ctx) {
  return rows.filter((l) => ctx.god || !l.secret).map((l) => {
    if (l.k === 'round') return `<li class="rd">Round ${l.n} <span>${esc(l.consul)} is Consul</span></li>`;
    if (l.k === 'msg') return `<li class="msg"><b>${esc(l.name)}</b><em>${l.stage}</em><p>${esc(l.text)}</p></li>`;
    return `<li class="sys ${l.tone ?? ''}${l.secret ? ' secret' : ''}">${esc(l.text)}</li>`;
  }).join('');
}

// Redraw only what changed: replacing a node would drop a text selection or focus in it.
let lastBoard = '', lastCaption = '', logCount = 0, logGod = null;
export function render(s, ctx, has3d) {
  const reveal = ctx.god || s.over;
  const roleOf = (name) => (reveal ? s.roles[name] ?? ctx.config.players.find((p) => p.name === name)?.role : null);
  $('meta').textContent = `Game ${ctx.id}${s.round ? ` \u00b7 Round ${s.round}` : ''} \u00b7 ${s.players.filter((p) => p.alive).length} of ${s.players.length} alive${ctx.god ? ' \u00b7 God view' : ''}`;
  if (has3d) {
    const caption = stage(s, ctx, true);
    if (caption !== lastCaption) $('caption').innerHTML = lastCaption = caption;
  } else {
    const board = tracks(s) + seats(s, ctx, roleOf) + stage(s, ctx);
    if (board !== lastBoard) $('board').innerHTML = lastBoard = board;
  }
  const log = $('log');
  if (ctx.god !== logGod || s.log.length < logCount) { log.innerHTML = ''; logCount = 0; logGod = ctx.god; }
  if (s.log.length > logCount) {   // the log only grows between seeks, so append the new rows
    log.insertAdjacentHTML('beforeend', transcript(s.log.slice(logCount), ctx));
    logCount = s.log.length;
    log.scrollTop = log.scrollHeight;
  }
}

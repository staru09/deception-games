// Senate reducer: pure, no DOM. init(config) -> state, apply(state, event) -> state (it mutates the
// state it is given). Events are those of docs/ARENA_CONTRACT.md §4; unknown types are ignored.
// Roles are NOT kept in the state until game_over: a viewer in god view reads them from the config.

export const REFORMS_TO_WIN = 5;
export const DECREES_TO_WIN = 6;
export const CHAOS_AT = 3;

// Power of the Nth decree (index N-1) by player count; the last slot is the Conspiracy's win.
export function powerSlots(players) {
  const by = players <= 6 ? { 3: 'peek', 4: 'execution', 5: 'execution' }
    : players <= 8 ? { 2: 'investigate', 3: 'special_election', 4: 'execution', 5: 'execution' }
      : { 1: 'investigate', 2: 'investigate', 3: 'special_election', 4: 'execution', 5: 'execution' };
  return Array.from({ length: DECREES_TO_WIN }, (_, i) => by[i + 1] ?? null);
}

export function init(config) {
  return {
    players: config.players.map((p) => ({ name: p.name, alive: true, vote: null, investigated: false, checked: null })),
    reforms: 0, decrees: 0, tracker: 0, round: 0, consul: null, prefect: null,
    drawPile: 17, discardPile: 0,
    step: { kind: 'start' },   // what the stage shows
    hand: null,                // { cards: [laws] | null (town view), n } while a government legislates
    log: [],                   // transcript: { k: 'round'|'msg'|'sys', ... }
    over: null,                // { winner, reason } after game_over
    roles: {},                 // filled by game_over
  };
}

const find = (s, name) => s.players.find((p) => p.name === name);
const sys = (s, text, tone = null, secret = false) => s.log.push({ k: 'sys', text, tone, secret });
const cap = (x) => x[0].toUpperCase() + x.slice(1);
const SAYS = { investigate: 'investigates', special_election: 'calls a special election', execution: 'orders an execution', peek: 'peeks at the top three laws' };

export function apply(s, ev) {
  switch (ev.type) {
    case 'round':
      s.round = ev.n; s.consul = ev.consul; s.prefect = null; s.tracker = ev.tracker;
      s.drawPile = ev.draw_pile; s.discardPile = ev.discard_pile; s.hand = null;
      s.players.forEach((p) => { p.vote = null; });
      s.step = { kind: 'nominate' };
      s.log.push({ k: 'round', n: ev.n, consul: ev.consul });
      break;
    case 'nominate':
      s.prefect = ev.prefect; s.step = { kind: 'debate' };
      sys(s, `${ev.consul} nominates ${ev.prefect} as Prefect.`);
      break;
    case 'message':
      s.log.push({ k: 'msg', name: ev.name, text: ev.text, stage: ev.stage });
      s.step = { kind: ev.stage === 'report' ? 'report' : 'debate', speaker: ev.name, text: ev.text, stage: ev.stage };
      break;
    case 'vote':
      find(s, ev.voter).vote = ev.aye; s.step = { kind: 'vote' };
      break;
    case 'vote_result':
      s.tracker = ev.tracker;
      s.step = { kind: 'result', passed: ev.passed, ayes: ev.ayes, nays: ev.nays };
      sys(s, `Vote ${ev.passed ? 'passed' : 'failed'}, ${ev.ayes} Aye to ${ev.nays} Nay.${ev.passed ? '' : ` Failed votes: ${ev.tracker}.`}`, ev.passed ? 'good' : 'bad');
      if (ev.passed) { s.hand = { cards: null, n: 3 }; s.drawPile -= 3; }   // three laws are drawn; town view only knows "three cards"
      break;
    case 'draw':
      if (s.hand) s.hand.cards = [...ev.laws];
      sys(s, `${ev.consul} draws ${ev.laws.join(', ')}.`, null, true);
      break;
    case 'discard':
      if (s.hand) {
        if (s.hand.cards) s.hand.cards.splice(s.hand.cards.indexOf(ev.law), 1);
        s.hand.n--;
      }
      sys(s, `${ev.by} discards a ${ev.law}.`, null, true);
      break;
    case 'veto':
      s.tracker = ev.tracker;
      s.step = { kind: 'veto', accepted: ev.accepted };
      if (ev.accepted) { s.hand = null; s.discardPile += 3; }
      sys(s, `${ev.prefect} proposes a veto. ${ev.consul} ${ev.accepted ? 'accepts: both laws are discarded' : 'refuses'}.${ev.accepted ? ` Failed votes: ${ev.tracker}.` : ''}`, 'warn');
      break;
    case 'enact': {
      const chaos = ev.by === 'chaos';
      s.reforms = ev.reforms; s.decrees = ev.decrees; s.tracker = ev.tracker; s.hand = null;
      if (chaos) s.drawPile--; else s.discardPile += 2;
      s.step = { kind: 'enacted', law: ev.law, by: ev.by };
      sys(s, chaos ? `Chaos: the top law is enacted, a ${ev.law}.` : `${ev.by} enacts a ${ev.law}.`, ev.law === 'reform' ? 'good' : 'bad');
      break;
    }
    case 'reshuffle':
      s.drawPile = ev.draw_pile - (s.hand ? 3 : 0); s.discardPile = 0;   // a government's draw follows at once
      sys(s, 'The discards are shuffled back into the deck.');
      break;
    case 'power':
      s.step = { kind: 'power', power: ev.kind, by: ev.by, target: ev.target ?? null };
      if (ev.kind === 'investigate') find(s, ev.target).investigated = true;
      sys(s, `${ev.by} ${SAYS[ev.kind]}${ev.target ? `: ${ev.target}` : ''}.`, 'warn');
      break;
    case 'power_result':
      s.step.result = ev.result;
      if (ev.kind === 'investigate') find(s, ev.target).checked = ev.result;
      sys(s, ev.kind === 'peek' ? `${ev.by} sees ${ev.result.join(', ')}.` : `${ev.by} learns that ${ev.target} is ${ev.result}.`, null, true);
      break;
    case 'executed':
      find(s, ev.name).alive = false;
      if (s.step.kind === 'power') s.step.executed = ev.name;
      sys(s, `${ev.name} is executed.`, 'bad');
      break;
    case 'game_over':
      s.over = { winner: ev.winner, reason: ev.reason }; s.roles = ev.roles ?? {};
      // usurper_elected ends the game before the three laws the vote_result took were drawn
      if (s.hand?.cards === null && s.hand.n === 3) s.drawPile += 3;
      s.hand = null;
      s.step = { kind: 'over' };
      sys(s, `${ev.winner === 'loyalists' ? 'Loyalists win' : 'Conspiracy wins'} (${ev.reason.replace('_', ' ')}).`, ev.winner === 'loyalists' ? 'good' : 'bad');
      break;
  }
  return s;
}

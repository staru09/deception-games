// Pure reducer for the Poker viewer (no DOM). init(config) -> state; apply(state, event) -> state
// (it mutates the state init made, which replay.js allows). Events: docs/ARENA_CONTRACT.md §5.
// Hole cards come from `deal` events, which are spoilers: the players' view never sees them, so
// state.hole stays empty there until a `showdown` makes the cards public.

export function init(config) {
  const names = config.players.map((p) => p.name);
  const zero = () => Object.fromEntries(names.map((n) => [n, 0]));
  return {
    names, hands: config.hands ?? null, bigBlind: config.blinds?.[1] ?? 2,
    hand: 0, button: null, street: null, board: [], pot: 0,
    stacks: Object.fromEntries(names.map((n) => [n, config.stack ?? 200])), startStacks: {},
    bets: zero(), hole: {}, shown: {}, best: {}, handName: {}, lastAct: {},
    turn: null, say: null, log: [],
    result: null,                        // after hand_end: { winners, pot, deltas }
    results: [],                         // one per finished hand: { hand, winners, deltas }
    totals: zero(), series: [],          // series[i] = totals after hand i + 1
    over: null,                          // the game_over event
  };
}

const other = (s, p) => s.names.find((n) => n !== p);
const anyAllIn = (s) => s.names.some((n) => s.stacks[n] === 0);

// Does this action end the betting round? (heads up: the button acts last after the flop)
function closes(s, ev) {
  if (ev.action === 'call') return !(s.street === 'preflop' && ev.player === s.button && ev.to <= s.bigBlind);
  if (ev.action === 'check') return s.street === 'preflop' || ev.player === s.button;
  return false;
}

export function apply(s, ev) {
  switch (ev.type) {
    case 'hand_start':
      Object.assign(s, {
        hand: ev.hand, button: ev.button, street: 'preflop', board: [], pot: 0, stacks: { ...ev.stacks },
        startStacks: { ...ev.stacks }, bets: Object.fromEntries(s.names.map((n) => [n, 0])), hole: {}, shown: {},
        best: {}, handName: {}, lastAct: {}, turn: null, say: null, result: null,
        log: [{ kind: 'hand', hand: ev.hand, button: ev.button }],
      });
      break;
    case 'deal':
      s.hole[ev.player] = ev.cards;
      break;
    case 'action': {
      s.pot = ev.pot; s.stacks[ev.player] = ev.stack; s.bets[ev.player] = ev.to;
      s.lastAct[ev.player] = { action: ev.action, to: ev.to, all_in: ev.all_in };
      s.say = ev.say ? { player: ev.player, text: ev.say } : null;
      if (ev.action !== 'blind') s.log.push({ kind: 'action', ...ev });
      s.turn = ev.action === 'blind' ? (ev.player === s.button ? null : s.button)
        : ev.action === 'fold' || closes(s, ev) ? null : other(s, ev.player);
      break;
    }
    case 'street':
      s.street = ev.name; s.board = ev.board; s.say = null; s.lastAct = {};
      s.bets = Object.fromEntries(s.names.map((n) => [n, 0]));
      s.turn = anyAllIn(s) ? null : other(s, s.button);
      s.log.push({ kind: 'street', name: ev.name, board: ev.board });
      break;
    case 'refund':
      s.stacks[ev.player] += ev.amount; s.bets[ev.player] -= ev.amount; s.pot = ev.pot;
      s.log.push({ kind: 'refund', player: ev.player, amount: ev.amount });
      break;
    case 'showdown':
      s.hole[ev.player] = ev.cards; s.shown[ev.player] = true; s.best[ev.player] = ev.best;
      s.handName[ev.player] = ev.hand_name; s.turn = null;
      s.log.push({ kind: 'showdown', player: ev.player, cards: ev.cards, name: ev.hand_name });
      break;
    case 'hand_end':
      s.board = ev.board; s.turn = null; s.say = null; s.bets = Object.fromEntries(s.names.map((n) => [n, 0])); s.totals = { ...ev.totals };
      for (const n of s.names) s.stacks[n] = s.startStacks[n] + ev.deltas[n];
      s.result = { winners: ev.winners, pot: ev.pot, deltas: ev.deltas };
      s.results.push({ hand: ev.hand, winners: ev.winners, deltas: ev.deltas });
      s.series.push({ ...ev.totals });
      s.log.push({ kind: 'result', winners: ev.winners, pot: ev.pot, deltas: ev.deltas });
      break;
    case 'game_over':
      s.over = ev; s.totals = { ...ev.totals };
      break;
  }
  return s;
}

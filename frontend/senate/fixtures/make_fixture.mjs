// node frontend/senate/fixtures/make_fixture.mjs
// Writes demo/config.json and demo/events.jsonl: a scripted 7-player Senate game that follows
// docs/ARENA_CONTRACT.md §4 and uses every event type (failed votes, a chaos law, passed
// governments, a reshuffle, investigate, special election, two executions, a veto accepted and
// one refused, debate and report messages). The deck order is scripted so the plot is fixed.
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const NAMES = ['Aurelia', 'Brutus', 'Cato', 'Drusus', 'Livia', 'Marcus', 'Octavia'];
const ROLES = { Aurelia: 'loyalist', Brutus: 'loyalist', Cato: 'loyalist', Drusus: 'usurper', Livia: 'conspirator', Marcus: 'conspirator', Octavia: 'loyalist' };
const config = {
  game: 'senate', discussion_rounds: 1, seed: 7, first_consul: 'Aurelia',
  players: NAMES.map((name) => ({ name, model: 'mock', role: ROLES[name], llm_config: { model_name: 'mock' } })),
};

// stock lines, picked by round number so every living player speaks in every discussion
const SAY = {
  Aurelia: ['I want a government we can all read. Show me your reasons.', 'Votes first, stories later.', 'Whoever hid a card owes us an explanation.'],
  Brutus: ['Three failures in a row would hand the Senate to chance.', 'I will back anyone who has a clean record so far.', 'Let us not repeat the last mistake.'],
  Cato: ['This pairing worries me. Why this Prefect?', 'I count the decrees and I do not like the number.', 'Somebody at this table is lying about the cards.'],
  Drusus: ['I am only a humble senator; I follow the evidence.', 'A fair slate. I will vote with the majority.', 'Careful, accusations without cards are just noise.'],
  Livia: ['The tracker is climbing. We need a government now.', 'I have nothing to hide and I will say so every time.', 'If the cards were bad, say so plainly.'],
  Marcus: ['Give the pair a chance; we learn nothing from a failed vote.', 'I would rather act than argue.', 'Fine by me, but I want a report afterwards.'],
  Octavia: ['I keep a list of who voted how. It is telling.', 'Our side needs reforms and this is the way to get them.', 'Speak up, the quiet ones worry me most.'],
};

let t = 1.7e9, n = 0, tracker = 0, reforms = 0, decrees = 0, pile = [];
// deck order, top first: chaos | R4 | R5 | R6 | R7 | R8 | the card left over (R)
pile = [...'D' + 'RDD' + 'RRD' + 'DDD' + 'RDR' + 'DDD' + 'R'];
let discard = [];
let alive = [...NAMES];
const events = [];
const emit = (type, f = {}) => { t += 1.2 + (events.length % 5) * 0.9; events.push({ ts: +t.toFixed(2), type, ...f }); };
const law = (c) => (c === 'R' ? 'reform' : 'decree');
const order = (list, k) => list.map((_, i) => list[(i + k) % list.length]);   // a new speaking order each time

function say(stage, k, custom = {}) {
  for (const name of order(alive, k)) {
    emit('message', { name, text: custom[name] ?? SAY[name][(n + k) % 3], stage });
  }
}

// Reshuffle in the scripted order: the discards go behind whatever is left of the draw pile.
function ensure(order) {
  if (pile.length >= 3) return;
  const sorted = [];
  for (const c of order) sorted.push(discard.splice(discard.indexOf(c), 1)[0]);
  if (discard.length) throw new Error('reshuffle order does not use every discard');
  pile = [...sorted, ...pile];
  emit('reshuffle', { draw_pile: pile.length });
}
const enact = (by, c) => {
  if (c === 'R') reforms++; else decrees++;
  tracker = 0;
  emit('enact', { law: law(c), by, reforms, decrees, tracker });
};

function round(consul, prefect, nays, o = {}) {
  n++;
  emit('round', { n, consul, tracker, draw_pile: pile.length, discard_pile: discard.length });
  emit('nominate', { consul, prefect });
  say('debate', n, o.debate);
  for (const voter of alive) emit('vote', { voter, aye: !nays.includes(voter) });
  const ayes = alive.length - nays.length, passed = ayes > nays.length;
  if (!passed) tracker++;   // a passed vote leaves it alone; any enacted law resets it
  emit('vote_result', { passed, ayes, nays: nays.length, tracker });
  if (!passed) {
    if (tracker === 3) {   // chaos: the top law is enacted, tracker back to 0
      ensure(o.reshuffle);
      tracker = 0;
      enact('chaos', pile.shift());
    }
    return;
  }
  ensure(o.reshuffle);
  const hand = pile.splice(0, 3);
  emit('draw', { spoiler: true, consul, laws: hand.map(law) });
  const out = hand.splice(hand.indexOf(o.dc), 1)[0];
  discard.push(out);
  emit('discard', { spoiler: true, by: consul, law: law(out) });
  if (o.veto) {
    tracker += o.veto === 'accept' ? 1 : 0;
    emit('veto', { prefect, consul, accepted: o.veto === 'accept', tracker });
    if (o.veto === 'accept') { discard.push(...hand); return; }
  }
  const out2 = hand.splice(hand.indexOf(o.dp), 1)[0];
  discard.push(out2);
  emit('discard', { spoiler: true, by: prefect, law: law(out2) });
  enact(prefect, hand[0]);
  return hand[0];
}

// ---- the game ----
round('Aurelia', 'Brutus', ['Cato', 'Drusus', 'Livia', 'Marcus']);        // 3-4, tracker 1
round('Brutus', 'Cato', ['Aurelia', 'Drusus', 'Livia', 'Marcus']);        // tracker 2
round('Cato', 'Drusus', ['Aurelia', 'Brutus', 'Octavia', 'Marcus']);        // tracker 3: chaos, a decree
const L = (name, text) => ({ [name]: text });
round('Drusus', 'Livia', ['Cato'], { dc: 'D', dp: 'R' });         // decree 2: investigate
emit('power', { kind: 'investigate', by: 'Drusus', target: 'Octavia' });
emit('power_result', { spoiler: true, kind: 'investigate', by: 'Drusus', target: 'Octavia', result: 'loyalist' });
say('report', 1, { ...L('Drusus', 'I drew two decrees and a reform and passed on a decree. I looked at Octavia: loyalist.'), ...L('Livia', 'Drusus gave me a decree and a reform. I took the decree; the reform was dead weight.') });
round('Livia', 'Aurelia', [], { dc: 'R', dp: 'D' });                         // reform 1
say('report', 2, { ...L('Livia', 'Two reforms and a decree. I handed Aurelia one of each.'), ...L('Aurelia', 'I got a reform and a decree and enacted the reform, as you see.') });
round('Marcus', 'Octavia', ['Aurelia', 'Cato'], { dc: 'D', dp: 'D' });        // decree 3: special election
emit('power', { kind: 'special_election', by: 'Marcus', target: 'Brutus' });
say('report', 3, { ...L('Marcus', 'Three decrees. I gave Octavia two and she had no choice. Brutus, you are up.'), ...L('Octavia', 'Two decrees, yes. That was not my doing.') });
round('Brutus', 'Cato', ['Livia', 'Marcus'], { dc: 'D', dp: 'R' });           // reform 2 (the special election)
say('report', 4, { ...L('Brutus', 'Reform, decree, reform. I kept the decree out of it.'), ...L('Cato', 'Two reforms for me, I enacted one. The tally is two and four.') });
round('Octavia', 'Brutus', ['Livia'], { dc: 'D', dp: 'D' });                  // decree 4: execution
emit('power', { kind: 'execution', by: 'Octavia', target: 'Marcus' });
emit('executed', { name: 'Marcus' });
alive = alive.filter((x) => x !== 'Marcus');
say('report', 5, { ...L('Octavia', 'Three decrees. I had no clean hand. Marcus gave us the third on a plate, so he goes.'), ...L('Brutus', 'Two decrees reached me, I had to enact one.') });
round('Aurelia', 'Livia', ['Octavia'], { dc: 'R', dp: 'R', reshuffle: [...'DRR' + 'DDD' + 'DDD' + 'R'] });  // decree 5: execution
emit('power', { kind: 'execution', by: 'Aurelia', target: 'Cato' });
emit('executed', { name: 'Cato' });
alive = alive.filter((x) => x !== 'Cato');
say('report', 6, { ...L('Aurelia', 'Two reforms and a decree. Livia enacted the decree. Cato, I am sorry, but your votes worried me.') });
round('Brutus', 'Octavia', [], { dc: 'D', veto: 'accept' });                 // veto accepted: tracker 1
round('Drusus', 'Brutus', ['Aurelia'], { dc: 'D', dp: 'D', veto: 'refuse' }); // the veto is refused: decree 6
emit('game_over', { winner: 'conspiracy', reason: 'decrees', roles: ROLES });

const dir = fileURLToPath(new URL('./demo/', import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(dir + 'config.json', JSON.stringify(config, null, 1));
writeFileSync(dir + 'events.jsonl', events.map((e) => JSON.stringify(e)).join('\n') + '\n');
console.log(`${events.length} events, ${n} rounds, ${reforms} reforms, ${decrees} decrees`);

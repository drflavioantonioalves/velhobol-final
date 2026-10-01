'use strict';
// Teste de fumaça: sobe o servidor e percorre o fluxo da final.
const { spawn } = require('child_process');
const { io } = require('socket.io-client');
const os = require('os');
const path = require('path');

const PORT = 3999;
const KEY = 'chave-de-teste';
const BASE = `http://localhost:${PORT}`;
let failed = 0;

function check(name, cond, extra) {
  console.log((cond ? 'OK   ' : 'FALHA') + ' - ' + name + (cond ? '' : ' ' + (extra || '')));
  if (!cond) failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ctl(body, key = KEY) {
  const r = await fetch(BASE + '/api/final/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-final-admin-key': key },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}
const getState = async () => (await fetch(BASE + '/api/final/state')).json();

(async () => {
  const stateFile = path.join(os.tmpdir(), 'velhobol-test-' + Date.now() + '.json');
  const srv = spawn('node', ['server.js'], {
    env: { ...process.env, PORT, FINAL_ADMIN_KEY: KEY, STATE_FILE: stateFile },
    stdio: 'inherit',
  });
  try {
    for (let i = 0; i < 30; i++) {
      try { if ((await fetch(BASE + '/health')).ok) break; } catch (e) {}
      await sleep(200);
    }
    const h = await (await fetch(BASE + '/health')).json();
    check('/health responde ok', h.ok === true);

    let s = await getState();
    check('/api/final/state: pré-jogo 0x0', s.status === 'pre' && s.score.home === 0 && s.score.away === 0);

    check('painel sem chave -> 401', (await ctl({ action: 'ping' }, '')).status === 401);
    check('painel com chave errada -> 401', (await ctl({ action: 'ping' }, 'errada')).status === 401);
    check('gol antes do jogo -> 400', (await ctl({ action: 'goal', team: 'home' })).status === 400);

    // socket: espectador + painel
    const viewer = io(BASE, { auth: { role: 'viewer' } });
    const admin = io(BASE);
    let lastPushed = null, viewersSeen = 0;
    viewer.on('state', (st) => (lastPushed = st));
    viewer.on('viewers', (n) => (viewersSeen = n));
    await sleep(1500);
    check('socket entrega estado inicial', lastPushed && lastPushed.status === 'pre');
    check('espectadores = 1 (painel não conta)', viewersSeen === 1 || (lastPushed && lastPushed.viewers === 1), `viu ${viewersSeen}`);

    let r = await ctl({ action: 'setup', homeName: 'Leões FC', awayName: 'Tigres EC', venue: 'Arena Central', halfLengthMin: 1 });
    check('configurar times/campo', r.status === 200 && r.json.state.teams.home === 'Leões FC' && r.json.state.venue === 'Arena Central');

    r = await ctl({ action: 'start_first' });
    check('iniciar 1º tempo', r.json.state.status === 'first' && r.json.state.clock.running);
    await sleep(300);
    check('socket recebeu 1º tempo em tempo real', lastPushed.status === 'first');

    r = await ctl({ action: 'goal', team: 'home', player: '<b>Zico</b>' });
    check('gol casa registrado', r.json.state.score.home === 1);
    r = await ctl({ action: 'goal', team: 'away', player: 'Romário' });
    check('gol visitante registrado', r.json.state.score.away === 1);
    const goalId = r.json.state.events.find((e) => e.type === 'goal' && e.team === 'away').id;
    r = await ctl({ action: 'delete_event', id: goalId });
    check('apagar gol corrige placar (1x0)', r.json.state.score.home === 1 && r.json.state.score.away === 0);

    await sleep(1200);
    s = await getState();
    check('relógio do servidor avança', s.clock.seconds >= 1, `segundos=${s.clock.seconds}`);

    r = await ctl({ action: 'halftime' });
    check('intervalo', r.json.state.status === 'halftime' && !r.json.state.clock.running);
    const frozen = r.json.state.clock.seconds;
    await sleep(1200);
    s = await getState();
    check('relógio parado no intervalo', s.clock.seconds === frozen);
    check('2º tempo antes da hora é recusado só fora do intervalo', (await ctl({ action: 'start_first' })).status === 400);

    r = await ctl({ action: 'start_second' });
    check('2º tempo começa em 1:00 (duração configurada)', r.json.state.status === 'second' && r.json.state.clock.seconds >= 60);

    r = await ctl({ action: 'card', team: 'away', color: 'azul', player: 'Beto' });
    check('cartão azul registrado', r.json.state.cards.away.azul === 1);
    r = await ctl({ action: 'card', team: 'home', color: 'amarelo', player: 'Caio' });
    check('cartão amarelo registrado', r.json.state.cards.home.amarelo === 1);
    check('cartão com cor inválida -> 400', (await ctl({ action: 'card', team: 'home', color: 'roxo' })).status === 400);

    r = await ctl({ action: 'finish' });
    check('encerrar partida', r.json.state.status === 'finished' && r.json.state.statusLabel === 'Jogo encerrado');
    await sleep(300);
    check('socket recebeu encerramento', lastPushed.status === 'finished');
    check('lances em ordem cronológica', lastPushed.events.every((e, i, a) => i === 0 || a[i - 1].ts <= e.ts));
    console.log('Lances finais:', lastPushed.events.map((e) => `${e.minute}' ${e.type}${e.player ? ' ' + e.player : ''}`).join(' | '));

    r = await ctl({ action: 'reset' });
    check('reset volta ao pré-jogo mantendo os times', r.json.state.status === 'pre' && r.json.state.teams.home === 'Leões FC' && r.json.state.events.length === 0);

    viewer.close(); admin.close();
  } catch (e) {
    console.error('Erro no teste:', e);
    failed++;
  } finally {
    srv.kill();
  }
  console.log(failed ? `\n${failed} verificação(ões) FALHARAM` : '\nTodas as verificações passaram.');
  process.exit(failed ? 1 : 0);
})();

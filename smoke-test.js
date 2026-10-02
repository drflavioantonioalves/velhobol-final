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

    r = await ctl({ action: 'setup', matchDate: '2026-10-04', matchTime: '16:00', sponsorName: 'Padaria Central', sponsorTagline: 'O pão do campeão' });
    check('data, hora e patrocinador salvos', r.json.state.matchDate === '2026-10-04' && r.json.state.matchTime === '16:00' && r.json.state.sponsor.name === 'Padaria Central');
    check('data inválida -> 400', (await ctl({ action: 'setup', matchDate: '04/10/2026' })).status === 400);

    r = await ctl({ action: 'lineup', team: 'home', starters: '1 Goleiro Zé\n9 João Silva\n10 Pedro', bench: '12 Carlos\n14 Lucas' });
    check('escalação da casa salva (3 titulares + 2 reservas)', r.json.state.lineups.home.starters.length === 3 && r.json.state.lineups.home.bench.length === 2);
    check('número da camisa lido corretamente', r.json.state.lineups.home.starters[1].num === '9' && r.json.state.lineups.home.starters[1].name === 'João Silva');
    check('nome repetido na escalação -> 400', (await ctl({ action: 'lineup', team: 'away', starters: 'Bruno\nbruno', bench: '' })).status === 400);
    await ctl({ action: 'lineup', team: 'away', starters: '1 Tiago\n7 Beto\n8 Rafa', bench: '15 Davi' });
    check('substituição antes do jogo -> 400', (await ctl({ action: 'sub', team: 'home', outName: 'Pedro', inName: 'Carlos' })).status === 400);

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

    r = await ctl({ action: 'goal', team: 'home', player: 'João Silva' });
    const g = r.json.state.events.filter((e) => e.type === 'goal').pop();
    check('gol com jogador da lista guarda o número da camisa', g.player === 'João Silva' && g.num === '9');
    r = await ctl({ action: 'delete_event', id: g.id });
    check('(removido o gol extra de teste)', r.json.state.score.home === 1);

    r = await ctl({ action: 'sub', team: 'home', outName: 'Pedro', inName: 'Carlos' });
    check('substituição registrada', r.status === 200 && r.json.state.events.some((e) => e.type === 'sub' && e.inName === 'Carlos' && e.outName === 'Pedro'));
    check('Carlos entrou em campo e Pedro saiu', r.json.state.field.home.some((p) => p.name === 'Carlos') && !r.json.state.field.home.some((p) => p.name === 'Pedro'));
    check('Pedro agora está fora de campo', r.json.state.off.home.some((p) => p.name === 'Pedro'));
    check('sai quem já saiu -> 400', (await ctl({ action: 'sub', team: 'home', outName: 'Pedro', inName: 'Lucas' })).status === 400);
    check('entra quem já está em campo -> 400', (await ctl({ action: 'sub', team: 'home', outName: 'Carlos', inName: 'João Silva' })).status === 400);
    check('jogador de outro time -> 400', (await ctl({ action: 'sub', team: 'away', outName: 'Zé', inName: 'Davi' })).status === 400);

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

    r = await ctl({ action: 'goal', team: 'away', player: 'Carlos', ownGoal: true });
    check('gol contra localiza o jogador no time adversário', r.json.state.events.filter((e) => e.type === 'goal').pop().num === '12');
    r = await ctl({ action: 'delete_event', id: r.json.state.events.filter((e) => e.type === 'goal').pop().id });
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

    const home = await (await fetch(BASE + '/', { headers: { 'x-forwarded-proto': 'https', host: 'meusite.onrender.com' } })).text();
    check('página inicial carrega com título Velhobol', home.includes('Velhobol') && !home.includes('FutLiga'));
    check('logo servido', (await fetch(BASE + '/logo.png')).headers.get('content-type') === 'image/png');
    check('prévia do WhatsApp: og:image absoluto', /og:image" content="https?:\/\/[^"]+\/logo\.png"/.test(home) && !home.includes('__ORIGIN__'));

    // ---- comentários dos espectadores
    let pushedComment = null;
    viewer.on('comment', (c) => (pushedComment = c));
    const post = async (body) => {
      const x = await fetch(BASE + '/api/final/comments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: x.status, json: await x.json() };
    };
    check('comentário sem nome -> 400', (await post({ name: '', text: 'oi' })).status === 400);
    check('comentário sem texto -> 400', (await post({ name: 'Ana', text: '  ' })).status === 400);
    let c1 = await post({ name: 'Ana', text: 'Que jogão! <script>alert(1)</script>' });
    check('comentário público aceito (sem senha)', c1.status === 200 && c1.json.ok);
    await sleep(300);
    check('comentário chega em tempo real pelo socket', pushedComment && pushedComment.name === 'Ana');
    check('comentário seguido muito rápido -> 429', (await post({ name: 'Ana', text: 'outro' })).status === 429);
    s = await getState();
    check('comentário aparece no estado', s.comments.length === 1 && s.comments[0].text.includes('Que jogão'));
    r = await ctl({ action: 'delete_comment', id: c1.json.comment.id });
    check('admin apaga comentário', r.json.state.comments.length === 0);
    r = await ctl({ action: 'comments_open', open: false });
    check('admin fecha comentários', r.json.state.commentsOpen === false);
    await sleep(3200);
    check('comentário com comentários fechados -> 403', (await post({ name: 'Bia', text: 'oi' })).status === 403);
    r = await ctl({ action: 'comments_open', open: true });
    await sleep(100);
    let c2 = await post({ name: 'Caio', text: 'vamos!' });
    check('comentários reabertos funcionam', c2.status === 200);
    check('lance livre (note) removido -> 400', (await ctl({ action: 'note', text: 'x' })).status === 400);

    r = await ctl({ action: 'reset', confirm: 'REINICIAR' });
    check('reset limpa o jogo, mantém times, escalações, data e patrocinador', r.json.state.status === 'pre' && r.json.state.teams.home === 'Leões FC' && r.json.state.events.length === 0 && r.json.state.comments.length === 0 && r.json.state.lineups.home.starters.length === 3 && r.json.state.sponsor.name === 'Padaria Central');

    // ---- disputa de pênaltis
    const kick = (result, player) => ctl({ action: 'pen', result, player });
    const toSecondHalf = async () => {
      await ctl({ action: 'start_first' }); await ctl({ action: 'halftime' }); await ctl({ action: 'start_second' });
    };
    await toSecondHalf();
    await ctl({ action: 'goal', team: 'home', player: 'João Silva' });
    check('pênaltis com placar desigual -> 400', (await ctl({ action: 'start_penalties', first: 'home' })).status === 400);
    await ctl({ action: 'goal', team: 'away', player: 'Beto' });
    check('pênaltis sem escolher quem cobra primeiro -> 400', (await ctl({ action: 'start_penalties' })).status === 400);
    r = await ctl({ action: 'start_penalties', first: 'away' });
    check('empatado: inicia pênaltis (visitante cobra primeiro)', r.status === 200 && r.json.state.status === 'penalties' && r.json.state.pens.next === 'away');
    check('gol comum durante pênaltis -> 400', (await ctl({ action: 'goal', team: 'home' })).status === 400);
    r = await ctl({ action: 'cancel_penalties' });
    check('cancelar antes da 1ª cobrança volta ao 2º tempo', r.status === 200 && r.json.state.status === 'second' && !r.json.state.pens.active && !r.json.state.events.some((e) => e.pens));
    await ctl({ action: 'start_penalties', first: 'away' });

    r = await kick('goal', 'Beto');
    check('1ª cobrança é do time que começa e guarda o jogador', r.json.state.events.filter((e) => e.type === 'pen')[0].team === 'away' && r.json.state.pens.next === 'home');
    r = await kick('miss', 'João Silva');
    check('cobranças alternam entre os times', r.json.state.events.filter((e) => e.type === 'pen')[1].team === 'home' && r.json.state.pens.next === 'away');
    r = await kick('goal'); r = await kick('miss'); r = await kick('goal'); r = await kick('miss');
    check('placar dos pênaltis 3 x 0 após 3 cobranças cada', r.json.state.pens.score.away === 3 && r.json.state.pens.score.home === 0 && r.json.state.pens.decided === true);
    check('decidido antes das 5 cobranças (vitória antecipada)', r.json.state.pens.winner === 'away');
    check('cobrança após decidido -> 400', (await kick('goal')).status === 400);
    r = await ctl({ action: 'delete_event', id: r.json.state.events.filter((e) => e.type === 'pen').pop().id });
    check('apagar a última cobrança reabre a disputa', r.json.state.pens.decided === false && r.json.state.pens.next === 'home');
    r = await kick('miss');
    r = await ctl({ action: 'finish' });
    check('encerrar: campeão definido pelos pênaltis', r.json.state.status === 'finished' && r.json.state.winner === 'away'
      && r.json.state.events.slice(-1)[0].text.includes('vence nos pênaltis'));
    r = await ctl({ action: 'reset', confirm: 'REINICIAR' });
    check('reset limpa a disputa', !r.json.state.pens.active && r.json.state.winner === null);

    // morte súbita: 5 x 5 iguais e depois desempate
    await toSecondHalf();
    await ctl({ action: 'goal', team: 'home' }); await ctl({ action: 'goal', team: 'away' });
    await ctl({ action: 'start_penalties', first: 'home' });
    for (let i = 0; i < 10; i++) r = await kick('goal');
    check('5 x 5 convertidos: ainda não decidido (vai para morte súbita)', r.json.state.pens.decided === false && r.json.state.pens.next === 'home');
    r = await kick('goal');
    check('morte súbita: quem cobra primeiro converteu, ainda aguarda o outro', r.json.state.pens.decided === false && r.json.state.pens.next === 'away');
    r = await kick('miss');
    check('morte súbita: o outro perdeu, vence quem cobrou primeiro', r.json.state.pens.decided === true && r.json.state.pens.winner === 'home');
    r = await ctl({ action: 'finish' });
    check('campeão na morte súbita', r.json.state.winner === 'home');
    check('pênaltis iniciados também depois de encerrar (placar empatado)', (await ctl({ action: 'start_penalties', first: 'home' })).status === 400);
    r = await ctl({ action: 'reset', confirm: 'REINICIAR' });

    // ================= v4: reinício protegido, desfazer, prorrogação, imagens, YouTube, backup, filtro, QR, PDF, relatório
    r = await ctl({ action: 'reset' });
    check('reiniciar sem digitar REINICIAR -> 400', r.status === 400);

    await ctl({ action: 'start_first' });
    r = await ctl({ action: 'undo_phase' });
    check('desfazer início volta ao pré-jogo e zera o relógio', r.status === 200 && r.json.state.status === 'pre' && r.json.state.events.length === 0 && r.json.state.clock.seconds === 0);
    await ctl({ action: 'start_first' });
    await ctl({ action: 'halftime' });
    r = await ctl({ action: 'undo_phase' });
    check('desfazer intervalo volta ao 1º tempo com relógio correndo', r.json.state.status === 'first' && r.json.state.clock.running === true);
    await ctl({ action: 'goal', team: 'home', player: 'João Silva' });
    check('desfazer depois de haver lances -> 400', (await ctl({ action: 'undo_phase' })).status === 400);
    await ctl({ action: 'reset', confirm: 'REINICIAR' });

    // prorrogação
    await toSecondHalf();
    await ctl({ action: 'goal', team: 'home' });
    check('prorrogação sem empate -> 400', (await ctl({ action: 'start_extra' })).status === 400);
    await ctl({ action: 'goal', team: 'away' });
    await ctl({ action: 'setup', extraLengthMin: 1 });
    r = await ctl({ action: 'start_extra' });
    check('prorrogação inicia (1º tempo extra) a partir do fim do tempo normal', r.status === 200 && r.json.state.status === 'extra1' && r.json.state.clock.seconds >= 120 && r.json.state.extraStarted);
    r = await ctl({ action: 'extra_halftime' });
    check('intervalo da prorrogação para o relógio', r.json.state.status === 'extrabreak' && !r.json.state.clock.running);
    r = await ctl({ action: 'start_extra2' });
    check('2º tempo da prorrogação continua em 3:00 (2x1 min + 1 min)', r.json.state.status === 'extra2' && r.json.state.clock.seconds >= 180 && r.json.state.clock.seconds < 190);
    r = await ctl({ action: 'goal', team: 'home', player: 'Pedro' });
    check('gol na prorrogação conta no placar', r.json.state.score.home === 2);
    r = await ctl({ action: 'delete_event', id: r.json.state.events.filter((e) => e.type === 'goal').pop().id });
    r = await ctl({ action: 'start_penalties', first: 'home' });
    check('pênaltis a partir da prorrogação', r.status === 200 && r.json.state.status === 'penalties');
    r = await ctl({ action: 'undo_phase' });
    check('desfazer pênaltis volta ao 2º tempo da prorrogação com relógio correndo', r.json.state.status === 'extra2' && r.json.state.clock.running === true && !r.json.state.pens.active);
    r = await ctl({ action: 'finish' });
    check('encerrar empatado sem pênaltis: sem campeão', r.json.state.status === 'finished' && r.json.state.winner === null);
    check('prorrogação não pode começar de novo', (await ctl({ action: 'start_extra' })).status === 400);
    await ctl({ action: 'reset', confirm: 'REINICIAR' });

    // imagens
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const upload = async (slot, dataUrl, key = KEY) => {
      const x = await fetch(BASE + '/api/final/upload', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-final-admin-key': key }, body: JSON.stringify({ slot, dataUrl }) });
      return { status: x.status, json: await x.json() };
    };
    check('upload de imagem sem senha -> 401', (await upload('homeCrest', PNG, 'errada')).status === 401);
    check('upload com tipo inválido -> 400', (await upload('homeCrest', 'data:text/html;base64,PGI+')).status === 400);
    check('upload em campo desconhecido -> 400', (await upload('hack', PNG)).status === 400);
    check('imagem PNG falsa (conteúdo não é PNG) -> 400', (await upload('homeCrest', 'data:image/png;base64,QUJDREVGR0hJSktM')).status === 400);
    r = await upload('homeCrest', PNG);
    check('escudo enviado e publicado no estado', r.status === 200 && /^\/img\/homeCrest\?v=\d+$/.test(r.json.state.images.homeCrest));
    const img = await fetch(BASE + '/img/homeCrest');
    check('imagem é servida como PNG', img.status === 200 && img.headers.get('content-type') === 'image/png');
    check('imagem inexistente -> 404', (await fetch(BASE + '/img/awayCrest')).status === 404);
    r = await ctl({ action: 'reset', confirm: 'REINICIAR' });
    check('reiniciar partida mantém as imagens', !!r.json.state.images.homeCrest);

    // YouTube
    r = await ctl({ action: 'setup', streamUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5' });
    check('link do YouTube (watch) vira ID do vídeo', r.json.state.streamId === 'dQw4w9WgXcQ');
    r = await ctl({ action: 'setup', streamUrl: 'https://youtu.be/abcdefghijk' });
    check('link curto youtu.be aceito', r.json.state.streamId === 'abcdefghijk');
    check('link que não é do YouTube -> 400', (await ctl({ action: 'setup', streamUrl: 'http://evil.example.com/x' })).status === 400);
    check('link malicioso com script -> 400', (await ctl({ action: 'setup', streamUrl: '"><script>alert(1)</script>' })).status === 400);
    r = await ctl({ action: 'setup', streamUrl: '' });
    check('link vazio remove o vídeo', r.json.state.streamId === '');

    // filtro de palavrões (IPs diferentes para não esbarrar no limite de velocidade)
    let ipn = 10;
    const postIp = async (body) => {
      const x = await fetch(BASE + '/api/final/comments', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.1.1.' + ipn++ }, body: JSON.stringify(body) });
      return { status: x.status, json: await x.json() };
    };
    check('comentário com palavrão -> 400', (await postIp({ name: 'Zé', text: 'que merda de arbitragem' })).status === 400);
    check('palavrão disfarçado (p0rr4) -> 400', (await postIp({ name: 'Zé', text: 'p0rr4 de juiz' })).status === 400);
    check('palavrão no nome -> 400', (await postIp({ name: 'Fdp', text: 'oi' })).status === 400);
    check('palavra normal parecida ("culpa", "computador") passa', (await postIp({ name: 'Ana', text: 'a culpa é do computador, que jogão!' })).status === 200);

    // QR, relatório, PDF, páginas
    const qr = await fetch(BASE + '/qr.svg');
    check('QR Code em SVG', qr.status === 200 && (await qr.text()).includes('<svg'));
    check('página do relatório', (await fetch(BASE + '/relatorio')).status === 200);
    check('página do telão', (await fetch(BASE + '/telao')).status === 200);

    await toSecondHalf();
    await ctl({ action: 'goal', team: 'home', player: 'João Silva' });
    await ctl({ action: 'goal', team: 'away', player: 'Beto' });
    await ctl({ action: 'start_penalties', first: 'home' });
    for (const [res, pl] of [['goal', 'João Silva'], ['miss', 'Beto'], ['goal', 'Pedro'], ['miss', 'Tiago'], ['goal', 'Carlos'], ['miss', 'Rafa']]) await kick(res, pl);
    r = await ctl({ action: 'finish' });
    const rep = await (await fetch(BASE + '/api/final/report')).json();
    check('relatório traz campeão, gols e pênaltis', rep.finished && rep.winnerName === 'Leões FC' && rep.goals.length === 2 && rep.penKicks.length === 6 && rep.pens.score.home === 3);
    check('relatório traz pico de espectadores e comentários', rep.stats.peakViewers >= 1 && rep.stats.commentsTotal >= 1, JSON.stringify(rep.stats));
    const pdf = await fetch(BASE + '/relatorio.pdf');
    const pdfBuf = Buffer.from(await pdf.arrayBuffer());
    check('PDF do relatório é gerado de verdade', pdf.status === 200 && pdf.headers.get('content-type') === 'application/pdf' && pdfBuf.slice(0, 5).toString() === '%PDF-' && pdfBuf.length > 3000, 'bytes=' + pdfBuf.length);
    require('fs').writeFileSync(require('path').join(os.tmpdir(), 'velhobol-relatorio-teste.pdf'), pdfBuf);

    // backup e restauração
    const bkRes = await fetch(BASE + '/api/final/backup', { headers: { 'x-final-admin-key': KEY } });
    const bk = await bkRes.json();
    check('backup só com senha', (await fetch(BASE + '/api/final/backup')).status === 401);
    check('backup completo traz estado e imagens', bk.format === 'velhobol-backup-1' && bk.state.events.length > 5 && !!bk.state.images.homeCrest);
    await ctl({ action: 'reset', confirm: 'REINICIAR' });
    s = await getState();
    check('(após reiniciar o jogo está vazio)', s.events.length === 0 && s.status === 'pre');
    const rs = await fetch(BASE + '/api/final/restore', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-final-admin-key': KEY }, body: JSON.stringify(bk) });
    const rj = await rs.json();
    check('restaurar backup devolve o jogo (encerrado, campeão Leões FC)', rj.ok && rj.state.status === 'finished' && rj.state.winner === 'home' && rj.state.events.length === bk.state.events.length);
    const bad = await fetch(BASE + '/api/final/restore', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-final-admin-key': KEY }, body: JSON.stringify({ format: 'x', state: { status: 'hack' } }) });
    check('backup inválido é recusado (400)', bad.status === 400);
    check('restaurar sem senha -> 401', (await fetch(BASE + '/api/final/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bk) })).status === 401);
    await ctl({ action: 'reset', confirm: 'REINICIAR' });

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

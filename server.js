'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.FINAL_ADMIN_KEY || '';
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'final-state.json');

const STATUS_LABEL = {
  pre: 'Pré-jogo',
  first: '1º tempo',
  halftime: 'Intervalo',
  second: '2º tempo',
  finished: 'Jogo encerrado',
};
const CARD_COLORS = ['amarelo', 'azul', 'vermelho'];

// ---------------------------------------------------------------- estado
function freshState(keep) {
  return {
    status: 'pre',
    teams: (keep && keep.teams) || { home: 'Time A', away: 'Time B' },
    venue: (keep && keep.venue) || 'Campo a definir',
    halfLengthMin: (keep && keep.halfLengthMin) || 30,
    clock: { baseSeconds: 0, startedAt: null },
    events: [],
    nextId: 1,
  };
}

let state = freshState();

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (saved && saved.status && saved.teams && saved.clock && Array.isArray(saved.events)) {
        state = saved;
        console.log('Estado anterior recuperado de', STATE_FILE);
      }
    }
  } catch (e) {
    console.warn('Não foi possível ler o estado salvo:', e.message);
  }
}

let saveTimer = null;
function saveStateSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(state));
    } catch (e) {
      // sem problema: o MVP funciona só em memória
    }
  }, 300);
}

function currentSeconds() {
  const c = state.clock;
  return c.baseSeconds + (c.startedAt ? (Date.now() - c.startedAt) / 1000 : 0);
}

function computeScore() {
  const score = { home: 0, away: 0 };
  for (const e of state.events) if (e.type === 'goal') score[e.team] += 1;
  return score;
}

function computeCards() {
  const cards = {
    home: { amarelo: 0, azul: 0, vermelho: 0 },
    away: { amarelo: 0, azul: 0, vermelho: 0 },
  };
  for (const e of state.events) if (e.type === 'card') cards[e.team][e.color] += 1;
  return cards;
}

let viewers = 0;

function publicState() {
  return {
    status: state.status,
    statusLabel: STATUS_LABEL[state.status],
    teams: state.teams,
    venue: state.venue,
    halfLengthMin: state.halfLengthMin,
    score: computeScore(),
    cards: computeCards(),
    clock: {
      seconds: Math.floor(currentSeconds()),
      running: state.clock.startedAt !== null,
    },
    events: state.events,
    viewers,
    serverTime: Date.now(),
  };
}

function addEvent(fields) {
  const ev = Object.assign(
    {
      id: state.nextId++,
      minute: state.status === 'pre' ? 0 : Math.floor(currentSeconds() / 60) + 1,
      ts: Date.now(),
    },
    fields
  );
  state.events.push(ev);
  return ev;
}

// ---------------------------------------------------------------- validação
class BadRequest extends Error {}

function cleanText(v, max, field, required) {
  const s = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  if (required && !s) throw new BadRequest(`Campo obrigatório: ${field}`);
  return s.slice(0, max);
}

function needTeam(v) {
  if (v !== 'home' && v !== 'away') throw new BadRequest('Escolha o time.');
  return v;
}

function freezeClock() {
  state.clock.baseSeconds = currentSeconds();
  state.clock.startedAt = null;
}

// ---------------------------------------------------------------- ações
function runAction(body) {
  const action = body && body.action;
  switch (action) {
    case 'ping':
      return;

    case 'setup': {
      if (body.homeName !== undefined) state.teams.home = cleanText(body.homeName, 30, 'time da casa', true);
      if (body.awayName !== undefined) state.teams.away = cleanText(body.awayName, 30, 'time visitante', true);
      if (body.venue !== undefined) state.venue = cleanText(body.venue, 60, 'campo', true);
      if (body.halfLengthMin !== undefined) {
        const m = Number(body.halfLengthMin);
        if (!Number.isFinite(m) || m < 1 || m > 60) throw new BadRequest('Duração do tempo deve ser de 1 a 60 minutos.');
        state.halfLengthMin = Math.round(m);
      }
      return;
    }

    case 'start_first':
      if (state.status !== 'pre') throw new BadRequest('O 1º tempo só pode começar no pré-jogo.');
      state.status = 'first';
      state.clock = { baseSeconds: 0, startedAt: Date.now() };
      addEvent({ type: 'status', text: 'Bola rolando! Começa o 1º tempo.' });
      return;

    case 'halftime':
      if (state.status !== 'first') throw new BadRequest('O intervalo só pode começar durante o 1º tempo.');
      addEvent({ type: 'status', text: 'Fim do 1º tempo. Intervalo.' });
      freezeClock();
      state.status = 'halftime';
      return;

    case 'start_second':
      if (state.status !== 'halftime') throw new BadRequest('O 2º tempo só pode começar após o intervalo.');
      state.status = 'second';
      state.clock = { baseSeconds: state.halfLengthMin * 60, startedAt: Date.now() };
      addEvent({ type: 'status', text: 'Começa o 2º tempo!' });
      return;

    case 'finish':
      if (state.status === 'pre' || state.status === 'finished')
        throw new BadRequest('A partida não está em andamento.');
      addEvent({ type: 'status', text: 'Fim de jogo!' });
      freezeClock();
      state.status = 'finished';
      return;

    case 'goal': {
      if (state.status === 'pre') throw new BadRequest('Inicie a partida antes de registrar gols.');
      addEvent({
        type: 'goal',
        team: needTeam(body.team),
        player: cleanText(body.player, 40, 'jogador', false),
        ownGoal: body.ownGoal === true,
      });
      return;
    }

    case 'card': {
      if (state.status === 'pre') throw new BadRequest('Inicie a partida antes de registrar cartões.');
      if (!CARD_COLORS.includes(body.color)) throw new BadRequest('Escolha a cor do cartão.');
      addEvent({
        type: 'card',
        team: needTeam(body.team),
        color: body.color,
        player: cleanText(body.player, 40, 'jogador', false),
      });
      return;
    }

    case 'note':
      addEvent({ type: 'note', text: cleanText(body.text, 200, 'texto do lance', true) });
      return;

    case 'delete_event': {
      const id = Number(body.id);
      const i = state.events.findIndex((e) => e.id === id);
      if (i === -1) throw new BadRequest('Lance não encontrado.');
      if (state.events[i].type === 'status') throw new BadRequest('Eventos de status não podem ser apagados.');
      state.events.splice(i, 1);
      return;
    }

    case 'adjust_clock': {
      const m = Number(body.minutes);
      const s = Number(body.seconds || 0);
      if (!Number.isFinite(m) || m < 0 || m > 180 || !Number.isFinite(s) || s < 0 || s > 59)
        throw new BadRequest('Tempo inválido.');
      if (state.status !== 'first' && state.status !== 'second')
        throw new BadRequest('O relógio só pode ser ajustado com a bola rolando.');
      state.clock = { baseSeconds: m * 60 + s, startedAt: Date.now() };
      return;
    }

    case 'reset':
      state = freshState(state);
      return;

    default:
      throw new BadRequest('Ação desconhecida.');
  }
}

// ---------------------------------------------------------------- app
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));

const server = http.createServer(app);
const io = new Server(server);

function broadcast() {
  io.emit('state', publicState());
  saveStateSoon();
}

// autenticação simples + limite de tentativas erradas por IP
const failures = new Map();
function sha(s) {
  return crypto.createHash('sha256').update(String(s)).digest();
}
function checkAuth(req, res) {
  if (!ADMIN_KEY) {
    res.status(503).json({ ok: false, error: 'FINAL_ADMIN_KEY não está configurada no servidor.' });
    return false;
  }
  const ip = req.ip;
  const f = failures.get(ip);
  if (f && f.count >= 10 && Date.now() - f.first < 60000) {
    res.status(429).json({ ok: false, error: 'Muitas tentativas. Aguarde 1 minuto.' });
    return false;
  }
  const given = req.get('x-final-admin-key') || '';
  if (!crypto.timingSafeEqual(sha(given), sha(ADMIN_KEY))) {
    const now = Date.now();
    if (!f || now - f.first >= 60000) failures.set(ip, { count: 1, first: now });
    else f.count += 1;
    res.status(401).json({ ok: false, error: 'Chave de administrador incorreta.' });
    return false;
  }
  failures.delete(ip);
  return true;
}

app.get('/health', (req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()) }));

app.get('/api/final/state', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(publicState());
});

app.post('/api/final/control', (req, res) => {
  if (!checkAuth(req, res)) return;
  try {
    runAction(req.body || {});
  } catch (e) {
    if (e instanceof BadRequest) return res.status(400).json({ ok: false, error: e.message });
    console.error(e);
    return res.status(500).json({ ok: false, error: 'Erro interno.' });
  }
  broadcast();
  res.json({ ok: true, state: publicState() });
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ---------------------------------------------------------------- socket.io
let viewersTimer = null;
function emitViewersSoon() {
  if (viewersTimer) return;
  viewersTimer = setTimeout(() => {
    viewersTimer = null;
    io.emit('viewers', viewers);
  }, 1000);
}

io.on('connection', (socket) => {
  const isViewer = socket.handshake.auth && socket.handshake.auth.role === 'viewer';
  if (isViewer) {
    viewers += 1;
    emitViewersSoon();
  }
  socket.emit('state', publicState());
  socket.on('disconnect', () => {
    if (isViewer) {
      viewers = Math.max(0, viewers - 1);
      emitViewersSoon();
    }
  });
});

// ---------------------------------------------------------------- start
loadState();
server.listen(PORT, () => {
  console.log(`Velhobol Final rodando na porta ${PORT}`);
  if (!ADMIN_KEY) console.warn('ATENÇÃO: FINAL_ADMIN_KEY não definida. O painel ficará bloqueado.');
});

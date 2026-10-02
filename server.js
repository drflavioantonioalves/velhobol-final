'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.FINAL_ADMIN_KEY || '';
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'final-state.json');

const STATUS_LABEL = {
  pre: 'Pré-jogo',
  first: '1º tempo',
  halftime: 'Intervalo',
  second: '2º tempo',
  extra1: 'Prorrogação · 1º tempo',
  extrabreak: 'Intervalo da prorrogação',
  extra2: 'Prorrogação · 2º tempo',
  penalties: 'Pênaltis',
  finished: 'Jogo encerrado',
};
const CARD_COLORS = ['amarelo', 'azul', 'vermelho'];
const IMAGE_SLOTS = ['homeCrest', 'awayCrest', 'homeSquad', 'awaySquad', 'sponsorLogo'];

// ---------------------------------------------------------------- estado
function freshState(keep) {
  const k = keep || {};
  return {
    status: 'pre',
    teams: k.teams || { home: 'Time A', away: 'Time B' },
    venue: k.venue || 'Campo a definir',
    halfLengthMin: k.halfLengthMin || 30,
    extraLengthMin: k.extraLengthMin || 10,
    clock: { baseSeconds: 0, startedAt: null },
    events: [],
    nextId: 1,
    comments: [],
    nextCommentId: 1,
    commentsTotal: 0,
    commentsOpen: true,
    penFirst: null,
    penPrev: null,
    extraStarted: false,
    lastPhase: null,
    peakViewers: 0,
    matchDate: k.matchDate || '',
    matchTime: k.matchTime || '',
    streamId: k.streamId || '',
    sponsor: k.sponsor || { name: '', tagline: '' },
    images: k.images || {},
    lineups: k.lineups || { home: { starters: [], bench: [] }, away: { starters: [], bench: [] } },
  };
}

let state = freshState();

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (saved && saved.status && saved.teams && saved.clock && Array.isArray(saved.events)) {
        state = Object.assign(freshState(), saved);
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

// ---- escalações
function allPlayers(team) {
  const L = state.lineups[team];
  return L.starters.concat(L.bench);
}

function rosterStatus(team) {
  const L = state.lineups[team];
  const byName = new Map(allPlayers(team).map((p) => [p.name, p]));
  const field = L.starters.map((p) => p.name);
  for (const e of state.events) {
    if (e.type !== 'sub' || e.team !== team) continue;
    const i = field.indexOf(e.outName);
    if (i === -1) continue;
    if (byName.has(e.inName) && !field.includes(e.inName)) field.splice(i, 1, e.inName);
    else field.splice(i, 1);
  }
  return {
    field: field.map((n) => byName.get(n)).filter(Boolean),
    off: allPlayers(team).filter((p) => !field.includes(p.name)),
  };
}

function findNum(team, name) {
  const p = allPlayers(team).find((x) => x.name === name);
  return p ? p.num : '';
}

function parseRoster(text, seen) {
  const out = [];
  String(text || '')
    .split(/\r?\n/)
    .forEach((line) => {
      const l = line.trim().replace(/\s+/g, ' ');
      if (!l) return;
      let num = '';
      let name = l;
      const m = l.match(/^(\d{1,3})\s*[-.)]?\s+(.+)$/);
      if (m) {
        num = m[1];
        name = m[2];
      }
      name = name.slice(0, 30).trim();
      if (!name) return;
      const key = name.toLowerCase();
      if (seen.has(key)) throw new BadRequest('Nome repetido na escalação: ' + name);
      seen.add(key);
      out.push({ num, name });
    });
  return out;
}

// ---- disputa de pênaltis (5 cobranças por time, antecipa o fim, depois morte súbita)
function penSummary() {
  const kicks = state.events.filter((e) => e.type === 'pen');
  const results = { home: [], away: [] };
  kicks.forEach((e) => results[e.team].push(e.result));
  const score = {
    home: results.home.filter((r) => r === 'goal').length,
    away: results.away.filter((r) => r === 'goal').length,
  };
  const kH = results.home.length;
  const kA = results.away.length;
  let decided;
  if (kH <= 5 && kA <= 5) decided = score.home > score.away + (5 - kA) || score.away > score.home + (5 - kH);
  else decided = kH === kA && score.home !== score.away;
  const first = state.penFirst;
  const other = first === 'home' ? 'away' : 'home';
  return {
    active: first !== null,
    first,
    results,
    score,
    decided,
    winner: decided ? (score.home > score.away ? 'home' : 'away') : null,
    next: first && !decided ? (kicks.length % 2 === 0 ? first : other) : null,
  };
}

function matchWinner() {
  if (state.status !== 'finished') return null;
  const sc = computeScore();
  if (sc.home !== sc.away) return sc.home > sc.away ? 'home' : 'away';
  return penSummary().winner;
}

let viewers = 0;

function imageUrls() {
  const out = {};
  for (const slot of IMAGE_SLOTS) if (state.images[slot]) out[slot] = '/img/' + slot + '?v=' + state.images[slot].v;
  return out;
}

function undoInfo() {
  const lp = state.lastPhase;
  const last = state.events[state.events.length - 1];
  if (lp && last && last.id === lp.eventId) return { available: true, label: lp.label };
  return { available: false, label: '' };
}

function publicState() {
  return {
    status: state.status,
    statusLabel: STATUS_LABEL[state.status],
    teams: state.teams,
    venue: state.venue,
    halfLengthMin: state.halfLengthMin,
    extraLengthMin: state.extraLengthMin,
    extraStarted: state.extraStarted,
    score: computeScore(),
    cards: computeCards(),
    clock: {
      seconds: Math.floor(currentSeconds()),
      running: state.clock.startedAt !== null,
    },
    events: state.events,
    comments: state.comments,
    commentsOpen: state.commentsOpen,
    pens: penSummary(),
    winner: matchWinner(),
    undo: undoInfo(),
    matchDate: state.matchDate,
    matchTime: state.matchTime,
    streamId: state.streamId,
    sponsor: state.sponsor,
    images: imageUrls(),
    lineups: state.lineups,
    field: { home: rosterStatus('home').field, away: rosterStatus('away').field },
    off: { home: rosterStatus('home').off, away: rosterStatus('away').off },
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

function youtubeId(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  const m = s.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|live\/|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

// ---- filtro simples de palavrões (o botão Apagar do painel continua sendo a defesa principal)
function normWord(s) {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/[@]/g, 'a')
    .replace(/[$]/g, 's')
    .replace(/[^a-z]+/g, '')
    .replace(/(.)\1+/g, '$1');
}
const BAD_WORDS = new Set(
  [
    'cu', 'cuzao', 'caralho', 'carai', 'porra', 'poha', 'merda', 'bosta', 'puta', 'putaria', 'putinha', 'fdp',
    'filhodaputa', 'viado', 'buceta', 'bct', 'pqp', 'arrombado', 'otario', 'babaca', 'fodase', 'foder',
    'vagabunda', 'vagabundo', 'retardado', 'imbecil', 'idiota', 'desgraca', 'desgracado', 'corno',
  ].map(normWord)
);
function hasBadWord(text) {
  const tokens = String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9@$]+/g, ' ')
    .split(' ')
    .filter(Boolean);
  return tokens.some((t) => BAD_WORDS.has(normWord(t)));
}

// ---------------------------------------------------------------- mudanças de fase (com "desfazer")
function snap() {
  return {
    status: state.status,
    clock: { baseSeconds: state.clock.baseSeconds, startedAt: state.clock.startedAt },
    penFirst: state.penFirst,
    penPrev: state.penPrev,
    extraStarted: state.extraStarted,
  };
}

function phaseChange(label, text, mutate, evFields) {
  const before = snap();
  mutate();
  const ev = addEvent(Object.assign({ type: 'status', text }, evFields || {}));
  state.lastPhase = Object.assign(before, { eventId: ev.id, label });
}

function needTied(msg) {
  const sc = computeScore();
  if (sc.home !== sc.away) throw new BadRequest(msg);
}

// ---------------------------------------------------------------- ações
function runAction(body) {
  const action = body && body.action;
  const hl = state.halfLengthMin * 60;
  const ex = state.extraLengthMin * 60;
  switch (action) {
    case 'ping':
      return;

    case 'setup': {
      if (body.homeName !== undefined) state.teams.home = cleanText(body.homeName, 30, 'time da casa', true);
      if (body.awayName !== undefined) state.teams.away = cleanText(body.awayName, 30, 'time visitante', true);
      if (body.venue !== undefined) state.venue = cleanText(body.venue, 60, 'campo', true);
      if (body.matchDate !== undefined) {
        const d = cleanText(body.matchDate, 10, 'data', false);
        if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new BadRequest('Data inválida.');
        state.matchDate = d;
      }
      if (body.matchTime !== undefined) {
        const t = cleanText(body.matchTime, 5, 'hora', false);
        if (t && !/^\d{2}:\d{2}$/.test(t)) throw new BadRequest('Hora inválida.');
        state.matchTime = t;
      }
      if (body.sponsorName !== undefined) state.sponsor.name = cleanText(body.sponsorName, 40, 'patrocinador', false);
      if (body.sponsorTagline !== undefined) state.sponsor.tagline = cleanText(body.sponsorTagline, 80, 'frase', false);
      if (body.streamUrl !== undefined) {
        const id = youtubeId(body.streamUrl);
        if (id === null) throw new BadRequest('Link do YouTube inválido. Cole o endereço da transmissão ao vivo.');
        state.streamId = id;
      }
      if (body.halfLengthMin !== undefined) {
        const m = Number(body.halfLengthMin);
        if (!Number.isFinite(m) || m < 1 || m > 60) throw new BadRequest('Duração do tempo deve ser de 1 a 60 minutos.');
        state.halfLengthMin = Math.round(m);
      }
      if (body.extraLengthMin !== undefined) {
        const m = Number(body.extraLengthMin);
        if (!Number.isFinite(m) || m < 1 || m > 30) throw new BadRequest('Duração da prorrogação deve ser de 1 a 30 minutos.');
        state.extraLengthMin = Math.round(m);
      }
      return;
    }

    case 'lineup': {
      const t = needTeam(body.team);
      const seen = new Set();
      const starters = parseRoster(body.starters, seen);
      const bench = parseRoster(body.bench, seen);
      if (starters.length + bench.length > 40) throw new BadRequest('Escalação grande demais (máx. 40 jogadores).');
      state.lineups[t] = { starters, bench };
      return;
    }

    case 'delete_image': {
      if (!IMAGE_SLOTS.includes(body.slot)) throw new BadRequest('Imagem desconhecida.');
      delete state.images[body.slot];
      return;
    }

    case 'start_first':
      if (state.status !== 'pre') throw new BadRequest('O 1º tempo só pode começar no pré-jogo.');
      phaseChange('Iniciar 1º tempo', 'Bola rolando! Começa o 1º tempo.', () => {
        state.status = 'first';
        state.clock = { baseSeconds: 0, startedAt: Date.now() };
      });
      return;

    case 'halftime':
      if (state.status !== 'first') throw new BadRequest('O intervalo só pode começar durante o 1º tempo.');
      phaseChange('Intervalo', 'Fim do 1º tempo. Intervalo.', () => {
        freezeClock();
        state.status = 'halftime';
      });
      return;

    case 'start_second':
      if (state.status !== 'halftime') throw new BadRequest('O 2º tempo só pode começar após o intervalo.');
      phaseChange('Iniciar 2º tempo', 'Começa o 2º tempo!', () => {
        state.status = 'second';
        state.clock = { baseSeconds: hl, startedAt: Date.now() };
      });
      return;

    case 'start_extra':
      if (state.status !== 'second' && state.status !== 'finished')
        throw new BadRequest('A prorrogação só pode começar ao fim do 2º tempo.');
      if (state.extraStarted) throw new BadRequest('A prorrogação já foi iniciada.');
      if (state.penFirst) throw new BadRequest('A disputa de pênaltis já foi iniciada.');
      needTied('Só há prorrogação se o placar estiver empatado.');
      phaseChange('Iniciar prorrogação', 'Empate no tempo normal! Começa a prorrogação.', () => {
        state.extraStarted = true;
        state.status = 'extra1';
        state.clock = { baseSeconds: 2 * hl, startedAt: Date.now() };
      });
      return;

    case 'extra_halftime':
      if (state.status !== 'extra1') throw new BadRequest('Só é possível durante o 1º tempo da prorrogação.');
      phaseChange('Intervalo da prorrogação', 'Fim do 1º tempo da prorrogação.', () => {
        freezeClock();
        state.status = 'extrabreak';
      });
      return;

    case 'start_extra2':
      if (state.status !== 'extrabreak') throw new BadRequest('Só é possível após o intervalo da prorrogação.');
      phaseChange('Iniciar 2º tempo da prorrogação', 'Começa o 2º tempo da prorrogação!', () => {
        state.status = 'extra2';
        state.clock = { baseSeconds: 2 * hl + ex, startedAt: Date.now() };
      });
      return;

    case 'start_penalties': {
      if (state.status !== 'second' && state.status !== 'extra2' && state.status !== 'finished')
        throw new BadRequest('Os pênaltis só podem começar ao fim do jogo.');
      if (state.penFirst) throw new BadRequest('A disputa de pênaltis já foi iniciada.');
      needTied('Só há pênaltis se o placar estiver empatado.');
      if (body.first !== 'home' && body.first !== 'away') throw new BadRequest('Escolha quem cobra primeiro.');
      const first = body.first;
      phaseChange(
        'Iniciar pênaltis',
        'Empate! Disputa de pênaltis. ' + state.teams[first] + ' cobra primeiro.',
        () => {
          state.penPrev = state.status;
          freezeClock();
          state.status = 'penalties';
          state.penFirst = first;
        },
        { pens: true }
      );
      return;
    }

    case 'pen': {
      if (state.status !== 'penalties' && !(state.status === 'finished' && state.penFirst))
        throw new BadRequest('A disputa de pênaltis não está em andamento.');
      if (body.result !== 'goal' && body.result !== 'miss') throw new BadRequest('Informe se converteu ou perdeu.');
      const ps = penSummary();
      if (ps.decided) throw new BadRequest('A disputa já está decidida. Se houve erro, apague a última cobrança.');
      const player = cleanText(body.player, 40, 'jogador', false);
      addEvent({ type: 'pen', team: ps.next, result: body.result, player, num: player ? findNum(ps.next, player) : '' });
      return;
    }

    case 'cancel_penalties': {
      if (state.status !== 'penalties') throw new BadRequest('A disputa de pênaltis não está em andamento.');
      if (state.events.some((e) => e.type === 'pen')) throw new BadRequest('Já houve cobranças. Apague-as antes de cancelar.');
      state.events = state.events.filter((e) => !e.pens);
      state.penFirst = null;
      state.status = state.penPrev || 'finished';
      if (state.status === 'second' || state.status === 'extra2') state.clock.startedAt = Date.now();
      state.penPrev = null;
      state.lastPhase = null;
      return;
    }

    case 'finish': {
      if (state.status === 'pre' || state.status === 'finished') throw new BadRequest('A partida não está em andamento.');
      const ps = penSummary();
      const text =
        state.penFirst && ps.decided
          ? 'Fim de jogo! ' + state.teams[ps.winner] + ' vence nos pênaltis (' + ps.score.home + ' x ' + ps.score.away + ').'
          : 'Fim de jogo!';
      phaseChange('Encerrar partida', text, () => {
        freezeClock();
        state.status = 'finished';
      });
      return;
    }

    case 'undo_phase': {
      const lp = state.lastPhase;
      const last = state.events[state.events.length - 1];
      if (!lp || !last || last.id !== lp.eventId)
        throw new BadRequest('Nada para desfazer. Só dá para desfazer a última mudança de fase, e apenas se ainda não houve lances depois dela.');
      state.events.pop();
      state.status = lp.status;
      state.clock = lp.clock;
      state.penFirst = lp.penFirst;
      state.penPrev = lp.penPrev;
      state.extraStarted = lp.extraStarted;
      state.lastPhase = null;
      return;
    }

    case 'goal': {
      if (state.status === 'pre') throw new BadRequest('Inicie a partida antes de registrar gols.');
      if (state.status === 'penalties') throw new BadRequest('Durante os pênaltis, use os botões Converteu / Perdeu.');
      const team = needTeam(body.team);
      const player = cleanText(body.player, 40, 'jogador', false);
      const own = body.ownGoal === true;
      addEvent({
        type: 'goal',
        team,
        player,
        num: player ? findNum(own ? (team === 'home' ? 'away' : 'home') : team, player) : '',
        ownGoal: own,
      });
      return;
    }

    case 'card': {
      if (state.status === 'pre') throw new BadRequest('Inicie a partida antes de registrar cartões.');
      if (!CARD_COLORS.includes(body.color)) throw new BadRequest('Escolha a cor do cartão.');
      const team = needTeam(body.team);
      const player = cleanText(body.player, 40, 'jogador', false);
      addEvent({ type: 'card', team, color: body.color, player, num: player ? findNum(team, player) : '' });
      return;
    }

    case 'sub': {
      if (state.status === 'pre') throw new BadRequest('Inicie a partida antes de registrar substituições.');
      const team = needTeam(body.team);
      const outName = cleanText(body.outName, 40, 'jogador que sai', true);
      const inName = cleanText(body.inName, 40, 'jogador que entra', true);
      const st = rosterStatus(team);
      if (!st.field.some((p) => p.name === outName)) throw new BadRequest('O jogador que sai precisa estar em campo.');
      if (!st.off.some((p) => p.name === inName)) throw new BadRequest('O jogador que entra precisa estar no banco.');
      addEvent({ type: 'sub', team, outName, inName, outNum: findNum(team, outName), inNum: findNum(team, inName) });
      return;
    }

    case 'delete_event': {
      const id = Number(body.id);
      const i = state.events.findIndex((e) => e.id === id);
      if (i === -1) throw new BadRequest('Lance não encontrado.');
      if (state.events[i].type === 'status') throw new BadRequest('Eventos de status não podem ser apagados.');
      state.events.splice(i, 1);
      return;
    }

    case 'delete_comment': {
      const id = Number(body.id);
      const i = state.comments.findIndex((c) => c.id === id);
      if (i === -1) throw new BadRequest('Comentário não encontrado.');
      state.comments.splice(i, 1);
      return;
    }

    case 'comments_open':
      state.commentsOpen = body.open === true;
      return;

    case 'adjust_clock': {
      const m = Number(body.minutes);
      const s = Number(body.seconds || 0);
      if (!Number.isFinite(m) || m < 0 || m > 240 || !Number.isFinite(s) || s < 0 || s > 59) throw new BadRequest('Tempo inválido.');
      if (!['first', 'second', 'extra1', 'extra2'].includes(state.status))
        throw new BadRequest('O relógio só pode ser ajustado com a bola rolando.');
      state.clock = { baseSeconds: m * 60 + s, startedAt: Date.now() };
      return;
    }

    case 'reset':
      if (body.confirm !== 'REINICIAR') throw new BadRequest('Para reiniciar, digite a palavra REINICIAR.');
      state = freshState(state);
      state.peakViewers = viewers;
      return;

    default:
      throw new BadRequest('Ação desconhecida.');
  }
}

// ---------------------------------------------------------------- backup / restauração
function exportState(withImages) {
  const copy = JSON.parse(JSON.stringify(state));
  if (!withImages) copy.images = {};
  return { format: 'velhobol-backup-1', savedAt: Date.now(), state: copy };
}

function importState(obj) {
  const st = obj && obj.state;
  const ok =
    obj &&
    obj.format === 'velhobol-backup-1' &&
    st &&
    STATUS_LABEL[st.status] &&
    st.teams && typeof st.teams.home === 'string' && typeof st.teams.away === 'string' &&
    st.clock && Number.isFinite(st.clock.baseSeconds) &&
    Array.isArray(st.events) && st.events.length < 3000 &&
    st.events.every((e) => e && Number.isFinite(e.id) && typeof e.type === 'string') &&
    st.lineups && st.lineups.home && st.lineups.away &&
    Array.isArray(st.lineups.home.starters) && Array.isArray(st.lineups.home.bench) &&
    Array.isArray(st.lineups.away.starters) && Array.isArray(st.lineups.away.bench);
  if (!ok) throw new BadRequest('Arquivo de backup inválido.');
  const keepImages = state.images;
  const next = Object.assign(freshState(), st);
  next.comments = Array.isArray(st.comments) ? st.comments.slice(-200) : [];
  if (!st.images || !Object.keys(st.images).length) next.images = keepImages;
  state = next;
}

// ---------------------------------------------------------------- app
const app = express();
app.set('trust proxy', 1);

const BIG_PATHS = new Set(['/api/final/upload', '/api/final/restore']);
const smallJson = express.json({ limit: '10kb' });
const bigJson = express.json({ limit: '14mb' });
app.use((req, res, next) => (BIG_PATHS.has(req.path) ? next() : smallJson(req, res, next)));

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

// ---- imagens (escudos, fotos dos elencos, logo do patrocinador)
app.post('/api/final/upload', bigJson, (req, res) => {
  if (!checkAuth(req, res)) return;
  try {
    const slot = req.body && req.body.slot;
    if (!IMAGE_SLOTS.includes(slot)) throw new BadRequest('Imagem desconhecida.');
    const m = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec((req.body && req.body.dataUrl) || '');
    if (!m) throw new BadRequest('Imagem inválida. Use PNG ou JPG.');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 1200 * 1024) throw new BadRequest('Imagem muito grande (máx. ~1 MB).');
    const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    const isJpg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    if ((m[1] === 'image/png' && !isPng) || (m[1] === 'image/jpeg' && !isJpg)) throw new BadRequest('Arquivo de imagem corrompido.');
    state.images[slot] = { mime: m[1], b64: m[2], v: Date.now() };
  } catch (e) {
    if (e instanceof BadRequest) return res.status(400).json({ ok: false, error: e.message });
    console.error(e);
    return res.status(500).json({ ok: false, error: 'Erro interno.' });
  }
  broadcast();
  res.json({ ok: true, state: publicState() });
});

app.get('/img/:slot', (req, res) => {
  const img = state.images[req.params.slot];
  if (!IMAGE_SLOTS.includes(req.params.slot) || !img) return res.status(404).end();
  res.set('Content-Type', img.mime);
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(Buffer.from(img.b64, 'base64'));
});

// ---- backup e restauração (só administrador)
app.get('/api/final/backup', (req, res) => {
  if (!checkAuth(req, res)) return;
  res.set('Cache-Control', 'no-store');
  res.json(exportState(req.query.images !== '0'));
});

app.post('/api/final/restore', bigJson, (req, res) => {
  if (!checkAuth(req, res)) return;
  try {
    importState(req.body);
  } catch (e) {
    if (e instanceof BadRequest) return res.status(400).json({ ok: false, error: e.message });
    console.error(e);
    return res.status(500).json({ ok: false, error: 'Erro interno.' });
  }
  broadcast();
  res.json({ ok: true, state: publicState() });
});

// ---- comentários dos espectadores (público, com limite de velocidade por IP)
const commentHits = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of commentHits) if (!arr.some((t) => now - t < 60000)) commentHits.delete(ip);
}, 300000).unref();

app.post('/api/final/comments', (req, res) => {
  if (!state.commentsOpen) return res.status(403).json({ ok: false, error: 'Os comentários estão fechados.' });
  const now = Date.now();
  const hits = (commentHits.get(req.ip) || []).filter((t) => now - t < 60000);
  if (hits.length && now - hits[hits.length - 1] < 3000)
    return res.status(429).json({ ok: false, error: 'Aguarde alguns segundos para comentar de novo.' });
  if (hits.length >= 20) return res.status(429).json({ ok: false, error: 'Muitos comentários seguidos. Aguarde um pouco.' });
  let name, text;
  try {
    name = cleanText(req.body && req.body.name, 30, 'nome', true);
    text = cleanText(req.body && req.body.text, 200, 'comentário', true);
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
  if (hasBadWord(name) || hasBadWord(text))
    return res.status(400).json({ ok: false, error: 'Seu comentário contém palavras não permitidas. Por favor, reescreva.' });
  hits.push(now);
  commentHits.set(req.ip, hits);
  const c = { id: state.nextCommentId++, name, text, ts: now };
  state.comments.push(c);
  state.commentsTotal += 1;
  if (state.comments.length > 200) state.comments.shift();
  io.emit('comment', c);
  saveStateSoon();
  res.json({ ok: true, comment: c });
});

// ---- QR Code do site
app.get('/qr.svg', async (req, res) => {
  try {
    const url = req.protocol + '://' + req.get('host') + '/';
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1, color: { dark: '#0a1230', light: '#ffffff' } });
    res.set('Cache-Control', 'public, max-age=3600');
    res.type('image/svg+xml').send(svg);
  } catch (e) {
    res.status(500).end();
  }
});

// ---- relatório da partida
function buildReport() {
  const ps = penSummary();
  const tn = (t) => state.teams[t];
  return {
    title: 'Final do Campeonato Velhobol',
    status: state.status,
    statusLabel: STATUS_LABEL[state.status],
    finished: state.status === 'finished',
    teams: state.teams,
    venue: state.venue,
    matchDate: state.matchDate,
    matchTime: state.matchTime,
    halfLengthMin: state.halfLengthMin,
    extraStarted: state.extraStarted,
    score: computeScore(),
    pens: ps.active ? { score: ps.score, results: ps.results, first: ps.first, winner: ps.winner, decided: ps.decided } : null,
    winner: matchWinner(),
    winnerName: matchWinner() ? tn(matchWinner()) : '',
    goals: state.events.filter((e) => e.type === 'goal').map((e) => ({ minute: e.minute, team: e.team, player: e.player, num: e.num, ownGoal: !!e.ownGoal })),
    cards: state.events.filter((e) => e.type === 'card').map((e) => ({ minute: e.minute, team: e.team, color: e.color, player: e.player, num: e.num })),
    subs: state.events.filter((e) => e.type === 'sub').map((e) => ({ minute: e.minute, team: e.team, inName: e.inName, inNum: e.inNum, outName: e.outName, outNum: e.outNum })),
    penKicks: state.events.filter((e) => e.type === 'pen').map((e) => ({ team: e.team, result: e.result, player: e.player, num: e.num })),
    cardTotals: computeCards(),
    lineups: state.lineups,
    sponsor: state.sponsor,
    images: imageUrls(),
    stats: { peakViewers: state.peakViewers, commentsTotal: state.commentsTotal },
    generatedAt: Date.now(),
  };
}

app.get('/api/final/report', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(buildReport());
});

function fmtDatePt(d, t) {
  if (!d) return t || '';
  const p = d.split('-');
  const dt = new Date(+p[0], +p[1] - 1, +p[2]);
  const s = dt.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return s.charAt(0).toUpperCase() + s.slice(1) + (t ? ' - ' + t : '');
}

app.get('/relatorio.pdf', (req, res) => {
  const r = buildReport();
  const doc = new PDFDocument({ size: 'A4', margin: 42, info: { Title: r.title + ' - Relatório', Author: 'Velhobol Clube de Campo' } });
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', 'attachment; filename="velhobol-relatorio-final.pdf"');
  doc.pipe(res);

  const W = doc.page.width - 84;
  const NAVY = '#0a1230';
  const RED = '#c8102e';
  const GREY = '#555b73';
  const who = (num, name) => (num ? num + ' ' : '') + name;
  const ensure = (h) => { if (doc.y + h > doc.page.height - 60) doc.addPage(); };
  const section = (t) => {
    ensure(50);
    doc.moveDown(0.8).font('Helvetica-Bold').fontSize(13).fillColor(RED).text(t.toUpperCase(), 42, doc.y, { characterSpacing: 1 });
    doc.moveTo(42, doc.y + 2).lineTo(42 + W, doc.y + 2).strokeColor('#d9dcea').lineWidth(1).stroke();
    doc.moveDown(0.5).font('Helvetica').fontSize(11).fillColor(NAVY);
  };

  // cabeçalho
  try { doc.image(path.join(__dirname, 'public', 'logo.png'), 42, 36, { width: 56 }); } catch (e) {}
  doc.font('Helvetica-Bold').fontSize(22).fillColor(NAVY).text('VELHOBOL', 112, 40);
  doc.font('Helvetica').fontSize(11).fillColor(GREY).text('Clube de Campo  |  Relatório da partida', 112, 66);
  doc.moveTo(42, 100).lineTo(42 + W, 100).strokeColor(RED).lineWidth(2).stroke();

  doc.font('Helvetica-Bold').fontSize(15).fillColor(NAVY).text(r.title, 42, 114, { width: W, align: 'center' });
  doc.font('Helvetica').fontSize(11).fillColor(GREY).text(fmtDatePt(r.matchDate, r.matchTime) + (r.venue ? '  |  ' + r.venue : ''), 42, 136, { width: W, align: 'center' });

  // placar
  doc.font('Helvetica-Bold').fontSize(14).fillColor(NAVY).text(r.teams.home, 42, 170, { width: 190, align: 'right' });
  doc.fontSize(34).text(r.score.home + '  x  ' + r.score.away, 232, 160, { width: W - 380, align: 'center' });
  doc.fontSize(14).text(r.teams.away, 42 + W - 190, 170, { width: 190, align: 'left' });
  doc.y = 208;
  if (r.pens) doc.font('Helvetica').fontSize(11).fillColor(GREY).text('Pênaltis: ' + r.pens.score.home + ' x ' + r.pens.score.away, 42, doc.y, { width: W, align: 'center' });
  if (r.winnerName) doc.font('Helvetica-Bold').fontSize(14).fillColor(RED).text('CAMPEÃO: ' + r.winnerName.toUpperCase(), 42, doc.y + 4, { width: W, align: 'center' });
  else if (!r.finished) doc.font('Helvetica-Oblique').fontSize(11).fillColor(GREY).text('Partida em andamento (relatório parcial)', 42, doc.y + 4, { width: W, align: 'center' });
  doc.moveDown(0.6);

  section('Gols');
  if (!r.goals.length) doc.text('Nenhum gol.');
  r.goals.forEach((g) => {
    ensure(18);
    doc.text(g.minute + "'  " + r.teams[g.team] + (g.player ? '  -  ' + who(g.num, g.player) : '') + (g.ownGoal ? '  (gol contra)' : ''));
  });

  if (r.penKicks.length) {
    section('Disputa de pênaltis');
    r.penKicks.forEach((k, i) => {
      ensure(18);
      doc.text((i + 1) + '.  ' + r.teams[k.team] + (k.player ? '  -  ' + who(k.num, k.player) : '') + '  -  ' + (k.result === 'goal' ? 'converteu' : 'perdeu'));
    });
  }

  section('Cartões');
  if (!r.cards.length) doc.text('Nenhum cartão.');
  r.cards.forEach((c) => {
    ensure(18);
    doc.text(c.minute + "'  Cartão " + c.color + '  -  ' + r.teams[c.team] + (c.player ? '  -  ' + who(c.num, c.player) : ''));
  });

  section('Substituições');
  if (!r.subs.length) doc.text('Nenhuma substituição.');
  r.subs.forEach((s) => {
    ensure(18);
    doc.text(s.minute + "'  " + r.teams[s.team] + '  -  entra ' + who(s.inNum, s.inName) + ', sai ' + who(s.outNum, s.outName));
  });

  section('Escalações');
  ['home', 'away'].forEach((k) => {
    const L = r.lineups[k];
    ensure(60);
    doc.font('Helvetica-Bold').text(r.teams[k]);
    doc.font('Helvetica').fontSize(10).fillColor(GREY);
    doc.text('Titulares: ' + (L.starters.map((p) => who(p.num, p.name)).join(', ') || '-'), { width: W });
    doc.text('Reservas: ' + (L.bench.map((p) => who(p.num, p.name)).join(', ') || '-'), { width: W });
    doc.moveDown(0.4).fontSize(11).fillColor(NAVY);
  });

  section('Torcida online');
  doc.text('Pico de espectadores simultâneos: ' + r.stats.peakViewers);
  doc.text('Comentários publicados: ' + r.stats.commentsTotal);
  if (r.sponsor && r.sponsor.name) {
    doc.moveDown(0.6).font('Helvetica-Oblique').fillColor(GREY).text('Patrocinador da rodada: ' + r.sponsor.name + (r.sponsor.tagline ? ' - ' + r.sponsor.tagline : ''));
  }
  doc.font('Helvetica').fontSize(8).fillColor(GREY).text('Gerado em ' + new Date(r.generatedAt).toLocaleString('pt-BR'), 42, doc.page.height - 50, { width: W, align: 'center' });
  doc.end();
});

// ---- páginas
const indexHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
app.get(['/', '/index.html'], (req, res) => {
  const origin = req.protocol + '://' + req.get('host');
  res.type('html').send(indexHtml.replace(/__ORIGIN__/g, origin));
});
app.get('/relatorio', (req, res) => res.sendFile(path.join(__dirname, 'public', 'relatorio.html')));
app.get('/telao', (req, res) => res.sendFile(path.join(__dirname, 'public', 'telao.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.use(express.static(path.join(__dirname, 'public')));

// erros de leitura do corpo (JSON inválido, arquivo grande demais)
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ ok: false, error: 'Arquivo grande demais.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ ok: false, error: 'Dados inválidos.' });
  console.error(err);
  res.status(500).json({ ok: false, error: 'Erro interno.' });
});

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
    if (viewers > state.peakViewers) {
      state.peakViewers = viewers;
      saveStateSoon();
    }
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

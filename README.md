# Velhobol — MVP da Final (transmissão ao vivo)

Versão simples para a final do campeonato. Estado em memória (salva um backup em `final-state.json` quando possível).

- Página pública: `/`
- Painel do administrador: `/admin` (pede a chave `FINAL_ADMIN_KEY`)
- `GET /health` · `GET /api/final/state` · `POST /api/final/control` (header `x-final-admin-key`)

## Rodar no computador
```
npm install
FINAL_ADMIN_KEY=minha-chave npm start
```
(Windows PowerShell: `$env:FINAL_ADMIN_KEY="minha-chave"; npm start`) e abra http://localhost:3000

## Publicar no Render (grátis)
1. Suba esta pasta para o GitHub (branch `final-2026`).
2. No Render: **New → Blueprint** (usa o `render.yaml`) ou **New → Web Service**:
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Plan: Free
3. Em **Environment**, crie `FINAL_ADMIN_KEY` com uma senha forte.
4. Abra a URL do Render. O painel fica em `/admin`.

## Antes da final (importante)
- **O plano gratuito do Render "dorme" após ~15 min sem acesso** e o primeiro acesso demora ~1 min. Faça um teste 30 min antes e use um monitor gratuito (ex.: UptimeRobot) chamando `/health` a cada 5 min para manter acordado.
- Se o servidor reiniciar durante o jogo, o estado pode ser perdido (disco gratuito é temporário). Anote o placar por segurança.
- Teste tudo no painel e clique em **Reiniciar partida** antes de abrir ao público (isso mantém times e campo).
- Teste automático: `npm test`.

## Como operar o jogo
Configuração → Iniciar 1º tempo → (gols/cartões/lances) → Intervalo → Iniciar 2º tempo → Encerrar.
Errou um gol/cartão? Use **Apagar** na lista de lances; o placar se corrige sozinho.

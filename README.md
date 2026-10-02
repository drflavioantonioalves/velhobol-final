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

## Páginas
- `/` página pública (placar, vídeo, lances, escalações, comentários) · `/admin` painel · `/telao` telão para projetar · `/relatorio` relatório da partida (+ `/relatorio.pdf`) · `/qr.svg` QR Code do site

## Como operar o jogo
1. **Antes:** no painel, em *Configuração* (times, data, horário, campo, duração dos tempos, link do YouTube, patrocinador), *Escalações* (um jogador por linha, ex.: `10 João Silva`) e *Fotos e logos* (escudos, foto do elenco, logo do patrocinador).
2. **Jogo:** Iniciar 1º tempo → gols, cartões (amarelo/azul/vermelho) e substituições escolhendo o jogador **na lista** → Intervalo → Iniciar 2º tempo → Encerrar. Cada botão pede confirmação.
3. **Apertou sem querer?** `↩ Desfazer` desfaz a última mudança de fase (só enquanto não houve lances depois dela).
4. **Se empatar:** *Prorrogação* (2 tempos, duração configurável) e/ou *Disputa de pênaltis* (5 cobranças, fim antecipado e morte súbita automáticos). O campeão aparece na página.
5. **Errou um lance?** **Apagar** na lista; placar e escalação se corrigem sozinhos.
6. **Comentário ofensivo?** Há filtro automático de palavrões; ainda assim use **Apagar** ou **Fechar comentários**.
7. **Fim de jogo:** abra o relatório (página, PDF e imagem para redes) e baixe o backup completo.
8. **Reiniciar partida** exige digitar `REINICIAR` (mantém times, escalações, imagens, data e patrocinador; apaga placar, lances e comentários). Faça isso após os testes.

## Segurança do jogo (backup)
- O painel guarda sozinho uma cópia do jogo no aparelho a cada 20 s. Se o servidor reiniciar, aparece o aviso **"O jogo parece ter sumido"** com botão para restaurar.
- Também há *Backup e restauração* manual (arquivo `.json`, com imagens).

## Teste automático
`npm test` (sobe o servidor e percorre jogo, prorrogação, pênaltis, imagens, backup, relatório e PDF).

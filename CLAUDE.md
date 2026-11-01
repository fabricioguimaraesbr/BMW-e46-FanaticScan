# E46Fanatics Scan: instruções para o Claude

Ferramenta de diagnóstico do BMW E46 que roda no navegador (Chrome/Edge, via Web Serial), feita por engenharia reversa do INPA/EDIABAS e do BMW Scanner 1.4 (PA Soft). Leia também `README.md` (funcionamento e estrutura) e `docs/` (achados técnicos). O contexto completo do projeto (decisões, histórico, pendências) está nos documentos do Projeto "E46Fanatics Scan" no Claude.

## Dono e carro
- O usuário fala português (Brasil). Converse em português. A interface do programa é em inglês.
- Carro de referência: BMW E46 325i 2001, motor M54 (DME MS43), câmbio automático ZF 5HP19 (EGS GS8.60.4), ABS/ASC MK20.
- Cabos: K+DCAN (em modo K-line) ou o cabo FTDI do BMW Scanner 1.4.
- O programa vai ser distribuído para a comunidade E46Fanatics.

## Regras que não mudam
- **Somente leitura por padrão.** Leitura e apagar erros: liberados. Testes de atuador e resets: só depois de "Unlock tests & resets". Escrita permanente (codificação, EEPROM/flash, sincronização EWS, `*_PROGRAMMIEREN`, `*_SCHREIBEN`): sempre bloqueada. Funções desconhecidas são tratadas como escrita. A regra é aplicada em `src/core/api/safety.ts` e em `DiagSession.run`, antes de qualquer byte sair pelo cabo. Não enfraqueça isso.
- **Única exceção (pedida pelo usuário, v1.3):** a curva do ponteiro de temperatura do painel, na tela Coding (`src/core/coding/clusterEeprom.ts`). Só painel 0x80 KOMBI46/KOMBI46R, só os bytes da curva achada por `findCurve`, só depois do backup completo do EEPROM salvo, conferindo o painel contra o backup antes de gravar, uma palavra por telegrama e releitura de cada uma. Não use esse caminho para outras gravações sem o usuário pedir; uma nova codificação segue o mesmo esquema.
- **Calibração da DME (MS42/MS43, `src/core/dme/`), em construção:** por enquanto só leitura (pelo cabo, `src/core/dme/reader.ts`: só o telegrama de leitura de memória `06 00`, pelo `ds2Raw`; nunca o setor de boot) e edição de uma cópia (tela Engine cooling, que salva um `.bin` novo com os checksums refeitos). Limites próprios do app em `COOLING_LIMITS`; mapa com A/C nunca acima do sem A/C. A gravação na DME ainda não existe e, quando existir, segue o esquema da exceção acima: backup completo, definição conferida contra a imagem (`checkDefinitionFits`), checksums só recalculados quando conferiram na leitura original (`fixCalibrationChecksums`), só os itens de `COOLING_EDITABLE`.
- **Sessão remota** (`src/core/remote/remote.ts`): quem decide é o computador do carro (`RemoteHost`). Somente leitura por padrão; apagar erros e testes só com aprovação do dono, na hora; escrita e acesso cru à linha K (`ds2Raw`) nunca passam.
- **Arquivos da BMW (.prg/.grp, SGBD):** o Claude não embute nem redistribui esses arquivos. O pacote sai com a pasta `modulos/` vazia, e quem distribui coloca os arquivos nela (decisão do usuário, sob responsabilidade dele). Os testes usam a pasta do usuário via `ECU_DIR`.
- **Visual:** proposta B "M Sport". Grafite/carbono, faixa tricolor M nas cores do logo E46Fanatics (#4290F6, #023D79, #E22619), fonte Titillium Web, valores medidos em âmbar (#ffa033), relógios de 270°. Menu lateral com seções (Car, Data, Workshop, More) e módulos em abas no topo. Logo em `src/web/assets/e46fanatics.svg`. Não usar o logo da BMW.
- Textos alemães dos arquivos da BMW são traduzidos para inglês (`src/core/api/i18n-en.ts`, `i18n-jobs.ts`); o original aparece no detalhe.

## Comandos
- `npm install`
- `npm run dev`: abre em http://localhost:5173 (Chrome/Edge para o cabo; o simulador funciona em qualquer navegador).
- `ECU_DIR=/caminho/para/EDIABAS/Ecu npm test`: 69 testes. Os que precisam dos arquivos da BMW são pulados sem `ECU_DIR`.
- `npm run typecheck`
- `MS4X_DIR=/caminho npm test`: testes da calibração da DME com as imagens de fábrica do ms4x-net (pasta com clones de `ms4x-net/ms42` e `ms4x-net/ms43`; pulados sem ela).
- `npx tsx scripts/build-dme-defs.ts $MS4X_DIR`: regenera `src/core/dme/defs.json` a partir dos XDFs (só os itens de termostática e ventoinha).
- `npx tsx scripts/build-offline.ts`: gera `release/E46Fanatics Scan/` (pacote Windows/Mac com atalhos) e `release/E46Fanatics Scan - Mac/` (o `E46Fanatics Scan.app`), mais os zips.
- `node design/build-mockups.mjs`: regenera as 3 propostas visuais.

## Arquitetura (resumo)
`Web Serial → WebSerialChannel → ObdInterface (DS2, KWP2000*, BMW-FAST) / Iso9141 (OBD-II) → Ediabas (interpretador BEST/2) ou NativeSession → DiagSession / HybridSession → UI (src/web/main.ts)`.
Telas extras em arquivos próprios: `src/web/garagePage.ts`, `loggerPage.ts`, `servicePage.ts`, `codingPage.ts`, `vehiclePage.ts` (FA e VIN/km, lógica em `src/core/api/vehicle.ts`), `checksPage.ts` (verificações guiadas, lógica em `src/core/api/checks.ts`), `coolingPage.ts` (Engine cooling: abre um .bin da DME MS42/MS43, lógica em `src/core/dme/`), `libraryPage.ts`, `troubleshoot.ts` (guias de falha em `src/core/api/faultguide.ts`), `remote.ts` (recebem um `PageCtx`, `src/web/ctx.ts`). Detalhes em `README.md` (seção Estrutura).

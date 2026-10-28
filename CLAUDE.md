# E46Fanatics Scan: instruções para o Claude

Ferramenta de diagnóstico do BMW E46 que roda no navegador (Chrome/Edge, via Web Serial), feita por engenharia reversa do INPA/EDIABAS e do BMW Scanner 1.4 (PA Soft). Leia também `README.md` (funcionamento e estrutura) e `docs/` (achados técnicos). O contexto completo do projeto (decisões, histórico, pendências) está nos documentos do Projeto "E46Fanatics Scan" no Claude.

## Dono e carro
- O usuário fala português (Brasil). Converse em português. A interface do programa é em inglês.
- Carro de referência: BMW E46 325i 2001, motor M54 (DME MS43), câmbio automático ZF 5HP19 (EGS GS8.60.4), ABS/ASC MK20.
- Cabos: K+DCAN (em modo K-line) ou o cabo FTDI do BMW Scanner 1.4.
- O programa vai ser distribuído para a comunidade E46Fanatics.

## Regras que não mudam
- **Somente leitura por padrão.** Leitura e apagar erros: liberados. Testes de atuador e resets: só depois de "Unlock tests & resets". Escrita permanente (codificação, EEPROM/flash, sincronização EWS, `*_PROGRAMMIEREN`, `*_SCHREIBEN`): sempre bloqueada. Funções desconhecidas são tratadas como escrita. A regra é aplicada em `src/core/api/safety.ts` e em `DiagSession.run`, antes de qualquer byte sair pelo cabo. Não enfraqueça isso.
- **Arquivos da BMW (.prg/.grp, SGBD):** o Claude não embute nem redistribui esses arquivos. O pacote sai com a pasta `modulos/` vazia, e quem distribui coloca os arquivos nela (decisão do usuário, sob responsabilidade dele). Os testes usam a pasta do usuário via `ECU_DIR`.
- **Visual:** proposta B "M Sport". Grafite/carbono, faixa tricolor M nas cores do logo E46Fanatics (#4290F6, #023D79, #E22619), fonte Titillium Web, valores medidos em âmbar (#ffa033), relógios de 270°. Menu lateral com seções e módulos em abas no topo. Logo em `src/web/assets/e46fanatics.svg`. Não usar o logo da BMW.
- Textos alemães dos arquivos da BMW são traduzidos para inglês (`src/core/api/i18n-en.ts`, `i18n-jobs.ts`); o original aparece no detalhe.

## Comandos
- `npm install`
- `npm run dev`: abre em http://localhost:5173 (Chrome/Edge para o cabo; o simulador funciona em qualquer navegador).
- `ECU_DIR=/caminho/para/EDIABAS/Ecu npm test`: 34 testes. Os que precisam dos arquivos da BMW são pulados sem `ECU_DIR`.
- `npm run typecheck`
- `npx tsx scripts/build-offline.ts`: gera `release/E46Fanatics Scan/` (pacote Windows/Mac com atalhos) e `release/E46Fanatics Scan - Mac/` (o `E46Fanatics Scan.app`), mais os zips.
- `node design/build-mockups.mjs`: regenera as 3 propostas visuais.

## Arquitetura (resumo)
`Web Serial → WebSerialChannel → ObdInterface (DS2) / Iso9141 (OBD-II) → Ediabas (interpretador BEST/2) ou NativeSession → DiagSession / HybridSession → UI (src/web/main.ts)`.
Detalhes em `README.md` (seção Estrutura).

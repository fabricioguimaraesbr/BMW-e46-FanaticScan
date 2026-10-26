# E46Fanatics Scan: passagem de projeto

Documento para continuar o projeto em outra conta do Claude sem perder contexto. Estado em 26/10/2026.

Leia nesta ordem:
1. este arquivo;
2. `CLAUDE.md`, na raiz;
3. `docs/achados-engenharia-reversa.md`, com protocolos e formatos;
4. `docs/distribuicao-modulos.md`, com os arquivos de módulos e a forma de distribuição;
5. `docs/historico-conversa.md`, se precisar de algum detalhe de uma decisão.

## 1. Objetivo

O usuário tinha no Windows o INPA (cabo K+DCAN) e o BMW Scanner 1.4 da PA Soft (cabo FTDI). Pediu engenharia reversa dos dois e um aplicativo novo com a mesma função:
- ler dados em tempo real;
- ler e apagar erros dos módulos;
- rodar no Mac ou, de preferência, na web.

O programa vai ser compartilhado com a comunidade E46Fanatics, daí o nome e o logo.

- **Carro de referência:** BMW E46 325i 2001, M54 (MS43), automático ZF 5HP19, ABS/ASC MK20.
- **Pastas originais no PC do usuário:** `C:\BMWScan140`, `C:\EC-APPS` e `C:\EDIABAS`. Os arquivos de módulos ficam em `C:\EDIABAS\Ecu`, 59 arquivos.

## 2. O que existe hoje

Um aplicativo web em TypeScript (Vite) que conversa com o carro pelo navegador, via Web Serial (só Chrome e Edge), e sai como pacote "dois cliques".

**Modos de funcionamento:**
- **Plug & play (só o cabo):**
  - identifica todos os módulos por DS2 (número BMW, HW, SW, data);
  - lê o motor pelo OBD-II (ISO 9141-2 na linha K): códigos P padrão com descrição, códigos pendentes, apagar erros e dados em tempo real (cerca de 1 leitura por segundo, limite do protocolo).
- **Com arquivos de módulos (pasta `modulos`):**
  - o interpretador BEST/2 próprio executa os mesmos `.prg`/`.grp` do EDIABAS: memória de erros com textos traduzidos e condições do erro, dados em tempo real (MS43: 28 valores por leitura, cerca de 8 leituras por segundo), funções e testes dos módulos;
  - módulo sem arquivo continua em plug & play (`HybridSession`).

**Telas (layout da proposta B):**
- menu lateral: Overview, Faults, Live Data, Tests & Functions, Report, Log;
- módulos encontrados em abas no topo;
- indicadores "Cable" e "Car" (verde/vermelho/laranja).

**Live Data:**
- 10 métricas principais por módulo: 4 relógios e 6 cartões;
- faixas de referência de mínimo e máximo do M54;
- "Additional metrics", escolhidas pelo usuário;
- gráfico e gravação em CSV.

**Recursos gerais:**
- **Só o que o carro tem:** depois do scan, o programa testa cada grupo de valores e lê a configuração de equipamentos da DME, e esconde o que o carro não tem.
- **Segurança:** somente leitura por padrão; ver a seção 6.
- **Simulador byte a byte** do 325i do usuário (DS2 e ISO 9141), montado a partir dos logs do BMW Scanner. Serve para testar sem o carro e é usado nos testes.

## 3. Histórico das decisões (resumido)

1. **Fase 1:** leitor dos `.prg`/`.grp` (ofuscados com XOR 0xF7), interpretador BEST/2 portado da semântica do EdiabasLib (GPLv3), transporte DS2 (9600 8E1, eco, XOR) e interface web. Validado contra os logs do BMW Scanner.
2. `Iniciar.bat` para rodar no Windows com Node.js. Depois foi trocado pelo pacote sem Node.
3. Interface em inglês, tema escuro com valores âmbar, textos alemães traduzidos.
4. Top 10 métricas, métricas adicionais e faixas de referência. Primeiro pacote offline (um único HTML).
5. Indicador do cabo, confirmação de que o programa é só leitura (classificação de segurança) e varredura do que o carro tem.
6. O usuário pediu para embutir todos os arquivos de `C:\EDIABAS\Ecu` na versão da comunidade. O Claude recusou redistribuir arquivos da BMW e propôs caminhos. O usuário escolheu o "caminho 3": suporte nativo sem arquivos. Isso virou o modo plug & play (OBD-II + identificação DS2).
7. Três propostas visuais (`design/`):
   - A: Night Cluster;
   - B: M Sport;
   - C: Estoril & OBC.

   O usuário escolheu a **B** e pediu para manter o layout do mockup (menu lateral e módulos em abas).
8. A seleção de pasta foi removida. Entrou a pasta `modulos/` no pacote, que o usuário vai preencher quando distribuir. Os atalhos de abrir juntam os arquivos ao HTML. Entrou também a `HybridSession`, que usa plug & play para o que faltar.
9. Lista dos arquivos de cada módulo (em `docs/distribuicao-modulos.md`). A pasta do usuário só tem a injeção MS43. Os E46 brasileiros com outros motores precisam de outros arquivos: MS41/MS42 (323i/328i), ME9 (318i N42/N46) e MSS54 (M3).

## 4. Estado e pendências

**Validado:**
- 23 testes automáticos: VM + transporte + simulador, textos dos erros conferidos com os logs reais, apagar erros, live data, cabo com e sem eco, OBD-II, modo híbrido, segurança, referências.
- Todas as telas conferidas no navegador com o simulador, inclusive na largura de celular.
- `app/montar.pl` (Mac) testado aqui com os 59 arquivos.

**Ainda não testado:**
1. **No carro de verdade:** nada foi testado no carro ainda. Os pontos de risco são o despertar a 5 baud do OBD-II, que usa o sinal "break" do cabo (alguns cabos baratos se comportam diferente), e os tempos do DS2 (`extraTimeout` em `ObdInterface`). Se falhar, peça ao usuário o conteúdo da página **Log**.
2. **`app/montar.ps1` (Windows) nunca foi executado:** não havia PowerShell no ambiente. Primeira coisa a confirmar no PC do usuário: com os arquivos em `modulos`, a tela inicial mostra "59 module files" e o câmbio e o ABS mostram erros, não "ID only".
3. **`montar.pl` num Mac de verdade:** usa o perl do sistema e os módulos IO::Compress::Gzip e MIME::Base64, que vêm com o macOS.

**Próximas fases combinadas ou oferecidas:**
- **Fase 2 do plug & play:** memória de erros DS2 sem arquivos para câmbio, ABS/DSC, airbag e painel, com tabelas de descrição escritas de forma independente. Os códigos DS2 são próprios de cada módulo; não existe tabela padrão. Isso foi anunciado ao usuário, mas não começou.
- Telas dedicadas do câmbio (adaptações, temperatura do óleo, marcha) e do ABS (sensores de roda).
- Testes guiados: VANOS, sonda lambda, injetores.
- MRS5 (airbag mais novo, KWP2000 a 115200): não implementado. Os outros 58 arquivos usam DS2.
- Versão hospedada na web (PWA), oferecida como ideia.
- Codificação com backup obrigatório: só com pedido explícito e muito cuidado. Hoje toda escrita é bloqueada por design.

## 5. Arquitetura e mapa de arquivos

```
Navegador ─ Web Serial ─ cabo FTDI ─ linha K ─ módulos do carro
  src/web/WebSerialChannel.ts      porta serial, eventos de plugar/desplugar, reabertura automática
  src/core/transport/ObdInterface.ts  DS2 conceito 6: eco, checksum XOR, tempos do SGBD, onLink
  src/core/native/iso9141.ts       OBD-II ISO 9141-2: wakeup 5 baud via break, 10400 8N1, keep-alive
  src/core/native/obd2.ts          serviços 01/03/07/04, PIDs SAE J1979
  src/core/native/pcodes.ts        ~250 descrições de códigos P genéricos (escritas no projeto)
  src/core/native/NativeSession.ts sessão plug & play (DS2 ident + OBD-II no motor)
  src/core/prg/PrgFile.ts          leitor de .prg/.grp
  src/core/ediabas/*               interpretador BEST/2 (Ediabas.ts, ops.ts…)
  src/core/api/DiagSession.ts      sessão com arquivos: scan, erros, valores, disponibilidade, run com segurança
  src/core/api/HybridSession.ts    arquivos onde houver, plug & play no resto (uma fila só na linha K)
  src/core/api/safety.ts           classificação read/clear/test/reset/write
  src/core/api/equipment.ts        equipamentos pela ECU_CONFIG da DME
  src/core/api/reference.ts        faixas de referência e KEY_METRICS
  src/core/api/i18n-en.ts, i18n-jobs.ts  tradução alemão → inglês
  src/core/api/modules.ts          módulos do E46 (grupos d_00xx e endereços)
  src/core/sim/*                   simulador do carro (SimChannel + e46.ts)
  src/web/main.ts                  interface inteira (render, navegação, live data, jobs)
  src/web/gauge.ts, chart.ts, styles.css, assets/e46fanatics.svg
  launchers/                       .bat/.command, montar.ps1/.pl, LEIA-ME, ícone
  scripts/build-offline.ts         gera release/E46Fanatics Scan/
  scripts/re/*, disasm.ts, dump-*.ts  ferramentas de engenharia reversa (disassembler de jobs etc.)
  design/                          as 3 propostas visuais (HTML + PNG + gerador)
  tests/                           vitest
```

**Pacote distribuível** (`release/E46Fanatics Scan/`):
- `app/E46Fanatics-Scan.html`: o programa inteiro (~0,6 MB);
- `modulos/`: vazia;
- `Abrir no Windows.bat`, `Abrir no Mac.command` e `Criar atalho na Area de Trabalho.bat`;
- `LEIA-ME.txt`.

Os atalhos rodam `app/montar.ps1` ou `app/montar.pl`. Eles geram `app/E46Fanatics-Scan-completo.html` com `<script id="ecu-bundle">` = base64(gzip(u32 LE tamanho do cabeçalho | JSON [[nome, tamanho]...] | bytes)). O programa lê esse bloco em `BrowserFileProvider.loadEmbedded()`. A remontagem só acontece quando a pasta ou o programa mudam (`completo.stamp`).

## 6. Segurança

| Tipo | Exemplos | Comportamento |
|---|---|---|
| Leitura | ident, erros, valores, adaptações | sempre |
| Apagar erros | FS_LOESCHEN, OBD modo 04 | com confirmação (no OBD avisa que zera os monitores de emissão) |
| Teste de atuador | bomba, injetor, ventoinha, VANOS, válvulas ABS | só após "Unlock tests & resets" (vale para a sessão) |
| Reset | ADAPT_*_LOESCHEN, RESET_ADAPTION | idem |
| Escrita | codificação, EEPROM/flash, sync EWS, *_PROGRAMMIEREN, *_SCHREIBEN | sempre bloqueado e escondido |

## 7. Como rodar

- **Desenvolvimento:** `npm install`, depois `npm run dev`. Use o Chrome. "Use simulator" funciona sem carro.
- **Testes:** `ECU_DIR=C:\EDIABAS\Ecu npm test`. No Mac/Linux, use o caminho de uma cópia da pasta.
- **Pacote:** `npx tsx scripts/build-offline.ts`, depois compacte `release/E46Fanatics Scan`.
- **No Windows sem saber Node:** `Iniciar.bat` instala as dependências e abre o modo de desenvolvimento.

## 8. Licença e origem

GPL-3.0. O interpretador segue a semântica documentada do EdiabasLib (Ulrich Holeschak, GPLv3). Nenhum código do INPA, do EDIABAS ou do BMW Scanner foi copiado. Os arquivos `.prg`/`.grp` da BMW não fazem parte do repositório.

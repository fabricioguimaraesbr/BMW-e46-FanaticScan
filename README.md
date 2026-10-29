# E46Fanatics Scan

Diagnóstico do BMW E46 no navegador (Mac, Windows e Linux), com o visual M Sport e o logo do E46Fanatics. Funciona só com o cabo (K+DCAN ou o cabo FTDI do BMW Scanner 1.4) e, quando a pasta `modulos` tem os arquivos dos módulos (`.prg`/`.grp`), lê todos os módulos como o INPA.

O que ele faz hoje:

- **Procura os módulos do carro** e identifica cada um como o INPA faz: grupo `D_00xx` → arquivo do módulo (`MS430DS0`, `GS8604`, `ASCMK20`…).
- **Lê e apaga a memória de erros** de cada módulo, com os textos do arquivo da BMW e as condições no momento do erro (rotação, temperatura, tensão…).
- **Mostra dados em tempo real**, com painel em destaque, gráfico e gravação em CSV. No MS43, o bloco `STATUS_MESSWERTEBLOCK` traz 28 valores do motor por leitura.
- **Executa as funções dos módulos** (testes, atuações e leituras), como o Tool32: qualquer job do arquivo, com argumentos.
- **Gera um relatório** do carro: identificação dos módulos e lista de erros.
- **Garage:** guarda cada carro (pelo número do chassi, quando algum módulo informa) com o histórico de scans, e compara dois scans: erros novos, apagados e que continuam. Fica no navegador, com exportação/importação em arquivo; abre também sem o carro, pela tela inicial.
- **Data Logger:** grava valores de vários módulos ao mesmo tempo (por exemplo motor e câmbio), com gráfico, presets, até 20 minutos de histórico e CSV.
- **Service:** procedimentos guiados do E46 (resets de adaptação da DME e do câmbio, sangria do ABS/DSC, teste da bomba do ABS, corte de injetor, autoteste do painel e do LCM), com as condições a confirmar antes. Os que gravam permanentemente aparecem bloqueados, com o motivo.
- **Report a problem:** salva um arquivo JSON com a versão, o navegador, as telas e funções da sessão e os últimos telegramas da linha K, com o chassi mascarado. Nada é enviado: a pessoa anexa o arquivo onde quiser.
- **Protocolos da linha K:** DS2 (quase todos os módulos do E46), KWP2000\* (DME MS45 dos M54 2003+, ME9 dos 318i N42/N46) e BMW-FAST (airbag MRS5), além do OBD-II.
- **Tem um simulador** do seu 325i, montado com os dados dos seus logs do BMW Scanner, para testar sem o carro. Ele roda uma viagem de 6,5 minutos que se repete: chave ligada com motor frio, partida, aquecimento em marcha lenta, cidade com trocas de marcha e semáforos, estrada e arrancada até a velocidade máxima, marcha lenta quente e motor desligado (`src/core/sim/drive.ts`). A fase atual aparece ao lado de "Simulator" no topo.

## Dois modos

- **Plug & play (sem arquivos):** só o cabo. Identifica todos os módulos do E46 (DS2: número BMW, hardware, software, data) e lê o motor pelo **OBD-II/EOBD** (ISO 9141-2 na linha K): códigos de erro padrão (P0xxx) com descrição, apagar erros e dados em tempo real padronizados (rotação, temperaturas, correções de combustível, sondas, massa de ar, avanço). Funciona em qualquer motor a gasolina de E46 com OBD (EUA desde 1999, Europa/Brasil desde 2001). O despertar do OBD a 5 baud é feito alternando o sinal "break" do cabo (`src/core/native/iso9141.ts`).
- **Com a pasta `modulos`:** tudo o que está descrito abaixo, em cada módulo que tiver o seu arquivo. Módulo sem arquivo continua em plug & play (`HybridSession`): por exemplo, um 318i com uma pasta que só tem o MS43 lê o motor pelo OBD-II e o resto com os arquivos.

Planejado: memória de erros dos módulos DS2 mais comuns (câmbio, ABS/DSC, airbag, painel) também no modo plug & play.

## Como funciona

O INPA não fala com o carro diretamente. Ele chama o **EDIABAS**, que executa os arquivos `.prg` de cada módulo: um bytecode chamado BEST/2, que monta os telegramas e decodifica as respostas. Este projeto reimplementa essa cadeia em TypeScript:

```
Navegador ─ Web Serial ─ cabo FTDI ─ linha K (DS2, 9600 8E1) ─ módulos do carro
                 │
     ObdInterface (eco, checksum XOR, tempos do SGBD)
                 │
     Ediabas (interpretador BEST/2) ── seus arquivos .prg/.grp
                 │
     DiagSession (fila de jobs, watchdog, erros e valores normalizados)
                 │
               Interface web
```

O código do INPA, do EDIABAS e do BMW Scanner não foi copiado. Os arquivos `.prg`/`.grp` vêm da pasta `modulos` do pacote, ao lado do programa; nada é enviado para servidor nenhum.

## Usar o programa

Quem vai usar o programa (Windows ou Mac, inclusive M1) **não precisa instalar nada além do Chrome ou Edge**: tudo vai embarcado no pacote "dois cliques" (seção mais abaixo). Não precisa de Node.js.

1. Extraia o `E46Fanatics Scan.zip`.
2. Windows: rode `Criar atalho na Area de Trabalho.bat` uma vez e use o ícone (ou `Abrir no Windows.bat`). Mac: botão direito em `Abrir no Mac.command` > Abrir (só na primeira vez).
3. **Connect cable** e escolha a porta FTDI na janela do Chrome. Ou **Start simulator** para testar sem o carro.

O Safari e o Firefox não têm Web Serial; neles só o simulador funciona. No simulador dá para escolher o carro: o 325i 2001 (MS43, DS2) ou um 325i 2004 (MS45 em KWP2000\* e airbag MRS5).

### Cabo

- **K+DCAN:** use o modo **K-line** (chave do cabo, ou ponte entre os pinos 7 e 8). O E46 2001 não tem D-CAN.
- **BMW Scanner 1.4:** funciona como cabo serial FTDI comum.
- **Feche o INPA e o BMW Scanner antes**: só um programa pode usar a porta por vez.
- **No Mac** o macOS já tem driver FTDI. Se o cabo não aparecer na lista, instale o driver VCP da FTDI.
- **No Windows** a porta já funciona se o INPA funciona (hoje está como `COM7`).
- **Cable options → K+DCAN line control (DTR):** liga o DTR só durante o envio na linha K, como o EDIABAS faz com cabos K+DCAN. Desligado por padrão (o seu cabo lê o carro assim). Use só se nenhum módulo responder com a chave do cabo na posição certa. Também fica na página Log durante a conexão.
- **Cabo lento:** se aparecerem várias respostas truncadas seguidas, o programa avisa para ajustar o "latency timer" do FTDI para 1 ms (no Windows: Gerenciador de Dispositivos → porta → Avançado).

## Publicar na web

`npm run build` gera a pasta `dist/` (cerca de 100 KB), que pode ser hospedada em qualquer servidor estático com HTTPS (GitHub Pages, Netlify, Cloudflare Pages). O Web Serial exige HTTPS ou `localhost`. Os arquivos dos módulos continuam no computador de cada usuário, porque a página só os lê localmente.

## Pacote "dois cliques" (sem instalar nada)

```bash
npx tsx scripts/build-offline.ts
```

Gera `release/E46Fanatics Scan/`:

- `app/E46Fanatics-Scan.html`: o programa inteiro em um arquivo (~0,6 MB). Funciona sem internet e sem Node.js.
- `modulos/`: vazia. Quem distribui coloca aqui os arquivos dos módulos.
- `Abrir no Windows.bat` / `Abrir no Mac.command`: juntam os arquivos de `modulos` ao programa (`app/montar.ps1` no Windows, `app/montar.pl` no Mac, só quando algo mudou) e abrem `app/E46Fanatics-Scan-completo.html` como aplicativo. Com a pasta vazia, abrem o programa em plug & play. Não há tela para escolher pasta. Só entram os arquivos usados pelo E46, listados em `app/e46-modulos.txt` (180 arquivos, de qualquer motor e versão do E46); os outros são ignorados, então dá para copiar a pasta inteira do EDIABAS. Sem a lista, entra tudo.
- `Criar atalho na Area de Trabalho.bat`: cria o ícone "E46Fanatics Scan".
- `LEIA-ME.txt`: instruções para quem vai usar.

E gera `release/E46Fanatics Scan - Mac/`, o **aplicativo de Mac** (Intel e Apple Silicon):

- `E46Fanatics Scan.app`: abre com dois cliques, tem ícone próprio e pode ir para a pasta Aplicativos e para o Dock. Abre o programa numa janela própria do Chrome ou Edge. Os arquivos dos módulos ficam **dentro do app** (`Contents/Resources/modulos`, pelo "Mostrar Conteúdo do Pacote"); o resultado da junção vai para `~/Library/Application Support/E46Fanatics Scan`, porque o macOS pode rodar um app recém-baixado a partir de uma cópia somente leitura.
- `LEIA-ME.txt`: instalação no Mac, inclusive como liberar o app na primeira abertura (ele não é assinado pela Apple).

Quando o comando `zip` existe, o script também gera `release/E46Fanatics Scan.zip` e `release/E46Fanatics Scan - Mac.zip`, mantendo a permissão de execução. **Ao adicionar os arquivos dos módulos no app e recompactar, use um Mac (Finder > Comprimir):** um zip feito no Windows perde essa permissão e o app deixa de abrir.

## Live data

- **Tudo sem escolher:** ao abrir a aba, a leitura começa sozinha e mostra todos os valores do módulo. O bloco principal (`STATUS_MESSWERTEBLOCK` na DME, `STATUS_IO_LESEN` no EGS) é lido a cada ciclo; os outros grupos suportados entram um por ciclo, em rodízio (todos a cada ciclo quando são até 3). Valores repetidos entre grupos (`STAT_X`/`STATUS_X`, `_MWB`, `TEMP`/`TEMPERATUR`) aparecem uma vez só.
- **Painel no topo** (desenho próprio, não é o painel da BMW): conta-giros, velocidade, marcha (EGS), 4 leituras e duas colunas de temperatura (água/óleo, ou óleo do câmbio).
- **Grupos** (Engine, Air & fuel, Ignition & VANOS, Temperatures, Electrical, Heaters & A/C, Transmission, Cruise control, Wheels & brakes, Other values): números em cartões com barra, faixa normal em azul e marcador âmbar; textos e On/Off em caixas simples. Fora da faixa, o cartão fica vermelho. Regras em `src/core/api/livelayout.ts`.
- **Faixas de referência** (`src/core/api/reference.ts`) para o M54/MS43: corte a 6.500 rpm, VANOS 80–120 / 80–105 °KW e pulso de injeção ≈ 3,5–5 ms (documentação técnica BMW), termostato de mapa 100–110 °C carga parcial / 85–95 °C carga total. Valores marcados como aproximados são típicos de oficina. Faixas "at idle" só são verificadas em marcha lenta, motor quente e carro parado.
- **Pause / Chart / Record CSV:** o gráfico mostra as 4 principais medições; o CSV grava todos os valores lidos.

## Segurança: o que o programa faz no carro

Toda função dos arquivos da BMW é classificada (`src/core/api/safety.ts`) e a regra é aplicada no núcleo do programa (`DiagSession.run`), antes de qualquer telegrama sair pelo cabo:

| Tipo | Exemplos | Comportamento |
| --- | --- | --- |
| Leitura | identificação, memória de erros, dados em tempo real, valores de adaptação | sempre permitido |
| Apagar erros | `FS_LOESCHEN` | permitido, com confirmação |
| Testes de atuador | bomba de combustível, cortar injetor, ventoinha, VANOS, válvulas do ABS | bloqueado até "Unlock tests & resets" (vale só para a sessão) |
| Resets | `ADAPT_*_LOESCHEN`, `RESET_ADAPTION` | bloqueado até "Unlock tests & resets" |
| Escrita permanente | codificação, EEPROM/flash, sincronização EWS (`MEHRFACHSTARTWERTABGLEICH`, `STEUERN_SYNC_MODE`), `*_PROGRAMMIEREN`, `*_SCHREIBEN` | sempre bloqueado e escondido |

Funções desconhecidas são tratadas como escrita (bloqueadas). Além do nome, o programa lê a descrição da função no arquivo da BMW: um "teste" ou "reset" descrito como gravação (por exemplo `STEUERN_SELBSTTEST` do EWS, que grava no transponder da chave, ou `STEUERN_*_PROGRAMM` da ME9) é tratado como escrita.

## Indicadores de conexão

- **Cable:** verde quando o cabo está conectado, vermelho quando é desconectado da USB. Ao ser religado, o programa reabre a porta sozinho e a leitura em tempo real continua de onde parou.
- **Car:** verde quando algum módulo está respondendo pela linha K; laranja quando o cabo está ok mas o carro não responde (ignição desligada ou chave do K+DCAN fora do modo K-line).
- No simulador, clicar no indicador "Simulator" simula desconectar/reconectar o cabo.

## Só o que o carro tem

Depois do scan, o programa lê a configuração de equipamentos da DME (`ECU_CONFIG`, `ABGAS_VARIANTE_LESEN`) e testa cada grupo de valores uma vez (só leitura). Grupos não suportados, valores de equipamentos que o carro não tem (ar secundário, válvula de escape, sondas pós-catalisador, diagnóstico de vazamento do tanque, etc.) e funções desses equipamentos ficam escondidos. O resultado fica guardado; "Re-check supported data" refaz a verificação.

## Desenvolvimento

Só para quem mexe no código: requer [Node.js](https://nodejs.org) 20 ou superior.

```bash
npm install
npm run dev
```

Abre em `http://localhost:5173` (Chrome ou Edge para o cabo). Para gerar o pacote que vai para os usuários, veja "Pacote dois cliques".

## Testes

```bash
ECU_DIR=/caminho/para/EDIABAS/Ecu npm test
```

Os testes rodam o fluxo completo (interpretador + camada do cabo + carro simulado byte a byte) e conferem:

- a identificação dos módulos;
- os textos dos erros, contra os seus logs do BMW Scanner;
- KWP2000\* e BMW-FAST (enquadramento, checksums, "response pending", controle de DTR) e o MS45/MRS5 de ponta a ponta pelos arquivos da BMW;
- Garage (comparação de scans, exportação), relatório de problema (chassi mascarado) e procedimentos de serviço;
- o apagamento da memória de erros;
- a leitura em tempo real;
- o funcionamento com cabo com e sem eco.

## Estrutura

| Pasta | Conteúdo |
| --- | --- |
| `src/core/prg` | Leitor dos arquivos `.prg`/`.grp` (tabelas, jobs, documentação) |
| `src/core/ediabas` | Interpretador BEST/2 (equivalente ao EDIABAS) |
| `src/core/transport` | DS2, KWP2000\* e BMW-FAST sobre linha K (`ObdInterface`) e abstração da porta serial |
| `src/core/sim` | Simulador byte a byte do E46 (MS43 ou MS45, GS8.60.4, ASC MK20, MRS5) |
| `src/core/api` | Sessão de diagnóstico, módulos do E46, tradução, Garage (`garage.ts`), relatório (`report.ts`), procedimentos (`service.ts`) |
| `src/web` | Interface, Web Serial, armazenamento dos arquivos no navegador |
| `scripts/` | Ferramentas de engenharia reversa: disassembler de jobs, sondas de resposta |

## Limitações conhecidas

- **Ainda não foi testado no carro.** Tudo foi validado contra o simulador, que foi construído a partir dos formatos que os próprios arquivos `.prg` esperam e dos seus logs. Os tempos reais do cabo podem pedir ajuste (`extraTimeout` em `ObdInterface`). Se algo falhar, abra a página **Log** no menu lateral e envie o que aparecer (botão "Save log").
- KWP2000\* (MS45, ME9) e BMW-FAST (MRS5) foram validados só no simulador; nenhum desses carros foi lido ainda. Os resets de adaptação da MS45/ME9 pedem argumentos (`ADAP_SELEKTIV_LOESCHEN`) e ainda não estão na tela Service.
- A interface é em inglês. Erros, funções e valores da DME, do câmbio e do ABS foram traduzidos do alemão (`src/core/api/i18n-en.ts` e `i18n-jobs.ts`); nos outros módulos a tradução é aproximada (glossário), e o texto original em alemão aparece no detalhe do erro.
- As telas do INPA (`.IPO`) não são executadas; as telas equivalentes foram refeitas a partir dos jobs.

## Próximas fases

1. Testar no carro e ajustar tempos.
2. Telas dedicadas para o câmbio (adaptações, temperatura do óleo, marcha) e ABS (sensores de roda).
3. Testes guiados com acompanhamento de valores (VANOS, sonda lambda).
4. Codificação com backup obrigatório antes de qualquer gravação.

## Licença

GPL-3.0. O interpretador segue a semântica documentada pelo projeto aberto [EdiabasLib](https://github.com/uholeschak/ediabaslib) (GPLv3), de Ulrich Holeschak. Várias melhorias da versão 1.2 (KWP2000\*/BMW-FAST na linha K, DTR como liberação de transmissão no K+DCAN, relatório de problema, Garage, gravação multi-módulo, procedimentos de serviço) vieram de ideias e notas técnicas do [BMWeb](https://github.com/dader34/BMWeb) (GPLv3), de dader34; o código daqui foi escrito para este projeto.

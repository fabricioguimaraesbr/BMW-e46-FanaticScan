# E46 325i (M54, 5HP19) — achados da engenharia reversa

Fonte: arquivos de C:\EDIABAS\Ecu (59 SGBDs), C:\EC-APPS\INPA e logs do BMW Scanner 1.4 em C:\BMWScan140.

## Módulos do carro (pelos logs do BMW Scanner)
| Módulo | Endereço DS2 | Grupo | Arquivo (variante) | Nº BMW / HW / SW |
|---|---|---|---|---|
| DME MS43 | 0x12 | D_0012 | MS430DS0 | 7545150 / 19 / 81 |
| EGS GS8.60.4 | 0x32 | D_0032 | GS8604 (não GS20) | 7548312 / 2H / 22 |
| ABS/ASC MK20 | 0x56 | D_0056 | ASCMK20 (não ABSMK20) | 6751767 / 06 / 33 |

Identificação: D_0012 usa o HW "19" (tabela HW2_TABELLE). D_0032 usa LI_NR "2H". D_0056 compara bytes binários da ident: byte 13 = 0x04 (fornecedor ITT) e byte 9 = 0x69 (índice de diagnose).

A pasta Ecu deste PC tem só o MS43 entre os motores (o catálogo D_0012 referencia 53 variantes). Outros E46 precisam da pasta completa de uma instalação INPA — ou do modo plug & play.

## Protocolo
- 58 dos 59 arquivos usam o conceito 6 (DS2): 9600 baud, 8E1, telegrama [endereço][comprimento total][dados…][XOR]. O cabo K-line ecoa os bytes enviados.
- Parâmetros do xsetpar: [6, baud, endereço, 0, 0, timeout ms, tempo de regeneração, fim de telegrama, …]; por exemplo, MS43 usa timeout 2000 ms e regeneração 100 ms.
- Exceção: MRS5 usa o conceito 0x10F (KWP2000 a 115200).

## Modo plug & play (sem arquivos da BMW)
- Identificação DS2 genérica (04 00) em todos os endereços do E46; layout ASCII na maioria dos módulos, binário no MK20.
- Motor via OBD-II/EOBD (ISO 9141-2) na mesma linha K: despertar do endereço 0x33 a 5 baud alternando o "break" do cabo (200 ms por bit), resposta 55 + key bytes 08 08, tester envia ~KB2, ECU responde ~0x33 (CC). Depois 10400 8N1, pedidos 68 6A F1 … soma, respostas 48 6B 12 … soma (sem byte de comprimento: mensagens separadas pela soma). Bytes do tester com 5–20 ms de intervalo; P3 ≥ 55 ms; keep-alive antes de 5 s.
- Serviços usados: 01 (PIDs), 03 (erros gravados), 07 (pendentes), 04 (apagar — também zera monitores de prontidão). Em média ~120 ms por PID.
- Módulos DS2 sem arquivos: só identificação por enquanto; códigos de erro DS2 são próprios de cada módulo (não há tabela padrão).

## Formatos de resposta (status 0xA0 = OKAY)
- **IDENT (04 00)**, ASCII: Nº BMW(7) HW(2) COD(2) DIAG(2) BUS(2) semana(2) ano(2) fornecedor(10) SW(2) AI(2) X produção(8). O MK20 usa formato binário.
- **MS43 FS_LESEN**: o bloco 04 00 traz a contagem; o bloco 04 01 traz [contagem] seguida de registros de 10 bytes (local, tipo, condições). O job repete 04 01 enquanto a resposta vier curta.
- **GS8604 FS_LESEN (04 01)**: [contagem] e registros de 19 bytes.
- **ASCMK20 FS_LESEN (04 01)**: registros de 3 bytes, sem contagem.
- **Apagar (FS_LOESCHEN)**: 04 05.
- **MS43 STATUS_MESSWERTEBLOCK (0B 03)**: 41 bytes de dados, com 28 valores. Exemplos: rpm nos bytes 3–4; velocidade no byte 5; MAF nos bytes 10–11 × 0,25; temperaturas = byte × 0,75 − 48; tempo de injeção nos bytes 17–18 × 0,005333 ms.
- **MS43 ECU_CONFIG / ABGAS_VARIANTE_LESEN (0B 94)**: bits de equipamento — byte1: 0x04 catalisador, 0x10 câmbio automático, 0x02 dois bancos; byte2: 0x02 A/C, 0x04 válvula de escape, 0x08 MIL, 0x10 eletroventilador, 0x80 painel; byte3: 0x02 ASC, 0x08 MFL, 0x20 bomba de ar secundário, 0x40 sondas pós-cat, 0x80 sondas pré-cat.
- **GS8604 STATUS_IO_LESEN (0B 03)**: rpm motor, turbina e saída nos bytes 3/4/5 (× 32); borboleta byte 6 (× 0,39 %); carga byte 7 (× 4 Nm); temp. motor byte 8 (− 48 °C); temp. óleo do câmbio byte 9 (− 40 °C); tensão byte 10 (× 0,0808 V); rodas bytes 11–14 (× 16); correntes EDS 1–4 bytes 15–18; marcha no byte 23 (bits 5–7).

## Faixas de referência usadas no Live Data (M54 / MS43)
- Corte de injeção a 6.500 rpm; VANOS admissão 80–120 °KW, escape 80–105 °KW; pulso de injeção ≈ 3,5–5 ms (documentação técnica BMW — M54 Engine / MS42-MS43). Os limites de VANOS batem com os argumentos aceitos pelo próprio MS430DS0.
- Termostato de mapa: 100–110 °C em carga parcial, 85–95 °C em carga total (Gates, artigo sobre termostatos controlados por mapa).
- Aproximados (valores típicos de oficina, verificados só em marcha lenta com motor quente): massa de ar 10–25 kg/h, tempo de injeção 1,8–4,5 ms, avanço 0–20°, válvula de marcha lenta 20–45 %. Correção lambda 0,90–1,10. OBD-II: correções de combustível ±10 %, MAF 2,5–8 g/s em marcha lenta.

## Segurança
- Funções classificadas em leitura / apagar erros / teste de atuador / reset / escrita. Escrita (codificação, EEPROM/flash, sincronização EWS, *_PROGRAMMIEREN, *_SCHREIBEN) sempre bloqueada; testes e resets só após desbloqueio na sessão; funções desconhecidas tratadas como escrita.

## Erros nos logs (para validação)
- DME: 83/E8 e 84/E8 (timeout CAN INSTR2/INSTR3). Memória de informação: 5A, 5B, 5D (sensor de temperatura do escape), 85 (timeout CAN ASC3).
- EGS: 61/C1 (tensão de alimentação KL30).
- ABS: 94/37 (CAN DME, torque do motor não ajustável) e 95/37 (timeout CAN DME).

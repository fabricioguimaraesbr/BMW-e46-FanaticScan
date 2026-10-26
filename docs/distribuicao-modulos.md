# E46Fanatics Scan — arquivos de módulos e distribuição

## Grupos → arquivos de módulo (pasta Ecu deste PC)
| Grupo | Módulo | Arquivos referenciados |
|---|---|---|
| D_0012 | DME | MS430DS0, T_GRTB |
| D_0032 | EGS | GS8604, GS8603, GS8602, GS8600, GS20 (MRS5 aparece citado) |
| D_0056 | ABS/ASC/DSC | ASCMK20, ABSMK20, ABS5, ASC5, ASC57, ASC5D, DSC_E46 |
| D_0044 | EWS | EWS, EWS3, EWS3D (+ ZCS_E46) |
| D_0080 | Painel | KOMBI46, KOMBI46R, IKE |
| D_00A4 | Airbag | MRS3, MRS3KW, MRS4 |
| D_00D0 | Luzes | LCM, LCM_A, LCM_II, LCM_III, LCM_IV, LSZ, LSZ_2 |
| D_0000 | ZKE/GM5 | ZKE5, ZKE5_S12 |
| D_005B | IHKA | IHKA46, IHKA46_2, IHKA46_3 |
| D_0008 | Teto solar | SHD46, SHD46_2 |
| D_0068 | MFL | MFL (MFL2 também na pasta) |
| D_0060, D_0070 | PDC / 0x70 | nenhum arquivo de módulo na pasta |

D_EGS, D_EXX, D_KOMBI, D_MOTOR, D_MOTOR2 são grupos usados pelas telas do INPA. Faltam na pasta as injeções de outros E46 brasileiros (MS41/MS42 dos 323i/328i, ME9 dos 318i N42/N46, MSS54 do M3).

## Distribuição: pasta `modulos` (E46Fanatics Scan)
- Pacote `E46Fanatics Scan/`: `app/E46Fanatics-Scan.html` + pasta `modulos/` vazia; quem distribui coloca os .prg/.grp nela. Sem tela de escolher pasta.
- Os atalhos de abrir juntam os arquivos de `modulos` ao HTML (Windows: `app/montar.ps1` com GZipStream; Mac: `app/montar.pl`, perl do sistema) em `app/E46Fanatics-Scan-completo.html`, no mesmo formato do pacote embutido (base64(gzip(u32 cabeçalho | JSON [[nome, tamanho]] | bytes)))). Só remonta quando a pasta ou o programa mudam (`completo.stamp`).
- Sessão híbrida: módulo com arquivo usa EDIABAS; módulo cujo grupo/arquivo falta ("SGBD not found") cai para plug & play (motor via OBD-II, demais só identificação). Antes de cada job DS2 a sessão OBD-II (10400 baud + keep-alive) é liberada.
- Visual escolhido: proposta B "M Sport" (grafite/carbono, faixa tricolor M nas cores do logo E46Fanatics, fonte Titillium Web, relógios de 270° com escala branca, faixa normal azul e valores âmbar).
- Layout final (igual à proposta B): menu lateral com seções (Overview, Faults, Live Data, Tests & Functions, Report, Log) e os módulos encontrados como abas no topo das páginas de módulo; rodapé do menu mostra o modo de segurança.

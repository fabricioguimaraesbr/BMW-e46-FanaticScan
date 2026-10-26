# Para começar na outra conta

## 1. Instruções do Projeto (cole em "Project instructions" do novo Projeto "E46Fanatics Scan")

Projeto de engenharia reversa do software de diagnóstico BMW E46 (INPA/EDIABAS e BMW Scanner 1.4 da PA Soft) e desenvolvimento do E46Fanatics Scan, um aplicativo web (TypeScript + Vite + Web Serial) que lê e apaga erros e mostra dados em tempo real dos módulos do E46. Converse em português; a interface do programa é em inglês. Carro de referência: E46 325i 2001, M54/MS43, ZF 5HP19. Regras: o programa é somente leitura por padrão (testes e resets só com desbloqueio, escrita/codificação sempre bloqueada); os arquivos .prg/.grp da BMW não são embutidos nem redistribuídos pelo Claude: o pacote sai com a pasta "modulos" vazia; visual "M Sport" (proposta B) com o logo E46Fanatics. O contexto completo está em HANDOFF.md, nos documentos do projeto.

## 2. Primeira mensagem (cole no primeiro chat, junto com o zip do código)

Estou continuando o projeto E46Fanatics Scan, que comecei em outra conta. Anexei o código-fonte completo (e46fanatics-scan.zip). Antes de qualquer coisa, leia CLAUDE.md e docs/HANDOFF.md, depois docs/achados-engenharia-reversa.md e docs/distribuicao-modulos.md (o docs/historico-conversa.md tem a conversa original, se precisar de detalhe). Rode npm install, npm run typecheck e npm test para confirmar que está tudo funcionando, e me diga em poucas linhas o estado do projeto e as pendências. Não mude nada ainda.

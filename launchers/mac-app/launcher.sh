#!/bin/bash
# Executavel do "E46Fanatics Scan.app" (Contents/MacOS/E46Fanatics Scan).
# Abre o programa como um aplicativo (janela propria) no Google Chrome ou Microsoft Edge.
# Os arquivos dos modulos ficam dentro do app: Contents/Resources/modulos.
# O resultado da juncao vai para ~/Library/Application Support, porque o macOS pode
# rodar um app recem-baixado a partir de uma copia somente leitura.
RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
DATA="$HOME/Library/Application Support/E46Fanatics Scan"
FILE="$RES/E46Fanatics-Scan.html"

mkdir -p "$DATA" 2>/dev/null
if /usr/bin/perl "$RES/montar.pl" "$FILE" "$RES/modulos" "$DATA" 2>/dev/null && [ -f "$DATA/E46Fanatics-Scan-completo.html" ]; then
  FILE="$DATA/E46Fanatics-Scan-completo.html"
fi
URL="file://${FILE// /%20}"

if open -Ra "Google Chrome" 2>/dev/null; then
  open -na "Google Chrome" --args --app="$URL" --window-size=1440,900
elif open -Ra "Microsoft Edge" 2>/dev/null; then
  open -na "Microsoft Edge" --args --app="$URL" --window-size=1440,900
else
  open "$FILE"
  osascript -e 'display dialog "Para conectar o cabo, instale o Google Chrome (google.com/chrome). O Safari não acessa portas USB." buttons {"OK"} default button 1 with title "E46Fanatics Scan"' >/dev/null
fi

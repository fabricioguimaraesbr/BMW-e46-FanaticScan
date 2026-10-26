#!/bin/bash
# Abre o E46Fanatics Scan como um aplicativo (janela propria) no Google Chrome ou Microsoft Edge.
# Se a pasta "modulos" tiver arquivos, eles sao juntados ao programa antes de abrir.
DIR="$(cd "$(dirname "$0")" && pwd)"
FILE="$DIR/app/E46Fanatics-Scan.html"
if /usr/bin/perl "$DIR/app/montar.pl" 2>/dev/null && [ -f "$DIR/app/E46Fanatics-Scan-completo.html" ]; then
  FILE="$DIR/app/E46Fanatics-Scan-completo.html"
fi
URL="file://${FILE// /%20}"

if [ -d "/Applications/Google Chrome.app" ] || [ -d "$HOME/Applications/Google Chrome.app" ]; then
  open -na "Google Chrome" --args --app="$URL" --window-size=1440,900
elif [ -d "/Applications/Microsoft Edge.app" ]; then
  open -na "Microsoft Edge" --args --app="$URL" --window-size=1440,900
else
  open "$FILE"
  osascript -e 'display dialog "Para conectar o cabo, instale o Google Chrome (google.com/chrome). O Safari não acessa portas USB." buttons {"OK"} default button 1' >/dev/null
fi

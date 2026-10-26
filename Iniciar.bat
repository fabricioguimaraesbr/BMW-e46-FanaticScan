@echo off
title E46Fanatics Scan
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nao encontrado. Instale em https://nodejs.org e abra este arquivo de novo.
  pause
  exit /b
)

rem Reinstala as dependencias quando o package.json mudou (nova versao do programa)
if not exist node_modules\.e46-stamp goto install
fc /b package.json node_modules\.e46-stamp >nul 2>nul
if errorlevel 1 goto install
goto run

:install
echo Instalando dependencias, aguarde...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo Falha ao instalar. Verifique a conexao com a internet.
  pause
  exit /b
)
copy /y package.json node_modules\.e46-stamp >nul

:run
echo.
echo Abrindo o E46Fanatics Scan no navegador...
echo Deixe esta janela aberta enquanto usa o programa. Para sair, feche esta janela.
echo.
call npm run dev -- --open
pause

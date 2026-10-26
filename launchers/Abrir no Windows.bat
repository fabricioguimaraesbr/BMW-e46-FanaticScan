@echo off
rem Abre o E46Fanatics Scan como um aplicativo (janela propria) no Chrome ou no Edge.
rem Se a pasta "modulos" tiver arquivos, eles sao juntados ao programa antes de abrir.
setlocal
set "HTML=%~dp0app\E46Fanatics-Scan.html"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\montar.ps1" >nul 2>&1
if %errorlevel%==0 if exist "%~dp0app\E46Fanatics-Scan-completo.html" set "HTML=%~dp0app\E46Fanatics-Scan-completo.html"
set "URL=file:///%HTML:\=/%"

for %%B in (
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LocalAppData%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
) do (
  if exist %%B (
    start "" %%B --app="%URL%" --window-size=1440,900
    goto :eof
  )
)

rem Nenhum Chrome/Edge encontrado: abre no navegador padrao
start "" "%HTML%"

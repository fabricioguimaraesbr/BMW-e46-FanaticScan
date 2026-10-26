@echo off
rem Cria o atalho "E46Fanatics Scan" (com icone) na Area de Trabalho. Rode uma vez.
setlocal
set "DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$d = [Environment]::GetFolderPath('Desktop');" ^
  "$s = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d 'E46Fanatics Scan.lnk'));" ^
  "$s.TargetPath = Join-Path $env:DIR 'Abrir no Windows.bat';" ^
  "$s.WorkingDirectory = $env:DIR;" ^
  "$s.IconLocation = (Join-Path $env:DIR 'app\e46diag.ico') + ',0';" ^
  "$s.WindowStyle = 7;" ^
  "$s.Description = 'E46Fanatics Scan - diagnostico BMW E46';" ^
  "$s.Save()"
if errorlevel 1 (
  echo Nao foi possivel criar o atalho.
) else (
  echo Pronto! O atalho "E46Fanatics Scan" foi criado na Area de Trabalho.
)
echo.
echo Importante: nao mova nem apague esta pasta, o atalho aponta para ela.
pause

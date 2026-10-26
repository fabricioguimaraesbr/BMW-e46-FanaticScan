# Junta os arquivos da pasta "modulos" ao programa (E46Fanatics-Scan-completo.html).
# Chamado pelo "Abrir no Windows.bat". Sai com 0 quando ha arquivos de modulos, 1 quando a pasta esta vazia.
$ErrorActionPreference = 'Stop'
$app = $PSScriptRoot
$mods = Join-Path (Split-Path $app -Parent) 'modulos'
$base = Join-Path $app 'E46Fanatics-Scan.html'
$out = Join-Path $app 'E46Fanatics-Scan-completo.html'
$stampFile = Join-Path $app 'completo.stamp'

$files = @(Get-ChildItem -LiteralPath $mods -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Extension -match '^\.(prg|grp)$' } | Sort-Object Name)
if ($files.Count -eq 0) { exit 1 }

# so remonta quando algo mudou (arquivos da pasta ou o proprio programa)
$stamp = (($files | ForEach-Object { '{0}|{1}|{2}' -f $_.Name, $_.Length, $_.LastWriteTimeUtc.Ticks }) -join ';') + ';' + (Get-Item -LiteralPath $base).LastWriteTimeUtc.Ticks
if ((Test-Path -LiteralPath $out) -and (Test-Path -LiteralPath $stampFile) -and ((Get-Content -LiteralPath $stampFile -Raw) -eq $stamp)) { exit 0 }

# pacote: gzip( u32 tamanho do cabecalho | JSON [[nome, tamanho], ...] | bytes dos arquivos ), em base64
$entries = $files | ForEach-Object { '["' + $_.Name.ToLowerInvariant().Replace('\', '\\').Replace('"', '\"') + '",' + $_.Length + ']' }
$head = [Text.Encoding]::UTF8.GetBytes('[' + ($entries -join ',') + ']')
$ms = New-Object IO.MemoryStream
$gz = New-Object IO.Compression.GZipStream($ms, [IO.Compression.CompressionMode]::Compress)
$len = [BitConverter]::GetBytes([uint32]$head.Length)
if (-not [BitConverter]::IsLittleEndian) { [Array]::Reverse($len) }
$gz.Write($len, 0, 4)
$gz.Write($head, 0, $head.Length)
foreach ($f in $files) { $b = [IO.File]::ReadAllBytes($f.FullName); $gz.Write($b, 0, $b.Length) }
$gz.Close()
$b64 = [Convert]::ToBase64String($ms.ToArray())

$html = [IO.File]::ReadAllText($base, [Text.Encoding]::UTF8)
$i = $html.LastIndexOf('</body>')
if ($i -lt 0) { $i = $html.Length }
$html = $html.Substring(0, $i) + '<script id="ecu-bundle" type="application/octet-stream">' + $b64 + '</script>' + $html.Substring($i)
[IO.File]::WriteAllText($out, $html, (New-Object Text.UTF8Encoding($false)))
[IO.File]::WriteAllText($stampFile, $stamp)
exit 0

// Builds the double-click package: release/E46Fanatics Scan/
//   app/E46Fanatics-Scan.html   the whole program in one file (works offline, no Node.js)
//   modulos/                    empty: whoever distributes the package puts the module files (.prg/.grp) here
//   Abrir no Windows.bat / Abrir no Mac.command
//                               join the files in "modulos" into app/E46Fanatics-Scan-completo.html
//                               (app/montar.ps1, app/montar.pl) and open it as an app window
import { execSync } from 'child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

const root = join(import.meta.dirname, '..');
const out = join(root, 'release', 'E46Fanatics Scan');
const L = (f: string) => join(root, 'launchers', f);

execSync('npx vite build --mode offline', { cwd: root, stdio: 'inherit' });
const html = readFileSync(join(root, 'dist-offline', 'index.html'), 'utf8');

rmSync(join(root, 'release'), { recursive: true, force: true });
mkdirSync(join(out, 'app'), { recursive: true });
mkdirSync(join(out, 'modulos'), { recursive: true });

const crlf = (src: string, dst: string) => writeFileSync(dst, readFileSync(src, 'utf8').replace(/\r?\n/g, '\r\n'));
writeFileSync(join(out, 'app', 'E46Fanatics-Scan.html'), html);
copyFileSync(L('e46diag.ico'), join(out, 'app', 'e46diag.ico'));
crlf(L('montar.ps1'), join(out, 'app', 'montar.ps1'));
copyFileSync(L('montar.pl'), join(out, 'app', 'montar.pl'));
crlf(L('Abrir no Windows.bat'), join(out, 'Abrir no Windows.bat'));
crlf(L('Criar atalho na Area de Trabalho.bat'), join(out, 'Criar atalho na Area de Trabalho.bat'));
crlf(L('LEIA-ME.txt'), join(out, 'LEIA-ME.txt'));
crlf(L('modulos-LEIA-ME.txt'), join(out, 'modulos', 'LEIA-ME.txt'));
copyFileSync(L('Abrir no Mac.command'), join(out, 'Abrir no Mac.command'));
chmodSync(join(out, 'Abrir no Mac.command'), 0o755);
chmodSync(join(out, 'app', 'montar.pl'), 0o755);
console.log(`Done: ${out} (${(html.length / 1e6).toFixed(1)} MB)`);

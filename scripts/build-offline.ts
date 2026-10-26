// Builds the double-click package: release/E46Fanatics Scan/
//   app/E46Fanatics-Scan.html   the whole program in one file (works offline, no Node.js)
//   modulos/                    empty: whoever distributes the package puts the module files (.prg/.grp) here
//   Abrir no Windows.bat / Abrir no Mac.command
//                               join the files in "modulos" into app/E46Fanatics-Scan-completo.html
//                               (app/montar.ps1, app/montar.pl) and open it as an app window
// Also builds release/E46Fanatics Scan - Mac/:
//   E46Fanatics Scan.app        double-click Mac app (Intel and Apple Silicon) that opens the program in
//                               Chrome/Edge; module files go inside it (Contents/Resources/modulos)
//   LEIA-ME.txt
// and, when the `zip` command exists, release/*.zip with the executable bits kept (the Mac app needs them).
import { execSync } from 'child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string };

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

// Mac app bundle
const macDir = join(root, 'release', 'E46Fanatics Scan - Mac');
const app = join(macDir, 'E46Fanatics Scan.app', 'Contents');
const M = (f: string) => join(root, 'launchers', 'mac-app', f);
mkdirSync(join(app, 'MacOS'), { recursive: true });
mkdirSync(join(app, 'Resources', 'modulos'), { recursive: true });
writeFileSync(join(app, 'Info.plist'), readFileSync(M('Info.plist'), 'utf8').replaceAll('__VERSION__', pkg.version));
writeFileSync(join(app, 'PkgInfo'), 'APPL????');
copyFileSync(M('launcher.sh'), join(app, 'MacOS', 'E46Fanatics Scan'));
chmodSync(join(app, 'MacOS', 'E46Fanatics Scan'), 0o755);
copyFileSync(M('AppIcon.icns'), join(app, 'Resources', 'AppIcon.icns'));
writeFileSync(join(app, 'Resources', 'E46Fanatics-Scan.html'), html);
copyFileSync(L('montar.pl'), join(app, 'Resources', 'montar.pl'));
chmodSync(join(app, 'Resources', 'montar.pl'), 0o755);
writeFileSync(
  join(app, 'Resources', 'modulos', 'LEIA-ME.txt'),
  'Coloque aqui os arquivos dos modulos (.prg e .grp), soltos nesta pasta (sem subpastas).\n' +
    'Depois feche e abra o E46Fanatics Scan de novo. Modulo sem arquivo funciona em plug & play.\n',
);
copyFileSync(L('LEIA-ME-mac.txt'), join(macDir, 'LEIA-ME.txt'));
console.log(`Done: ${macDir}`);

// Zips (keep the executable bits; Finder's "Compress" on a Mac does the same)
try {
  execSync('zip -v', { stdio: 'ignore' });
  for (const name of ['E46Fanatics Scan', 'E46Fanatics Scan - Mac']) {
    execSync(`zip -qry "${name}.zip" "${name}" -x "*.DS_Store"`, { cwd: join(root, 'release') });
    console.log(`Zip: release/${name}.zip`);
  }
} catch {
  console.log('No `zip` command: compress the release folders on a Mac (Finder > Compress) to keep the app executable.');
}

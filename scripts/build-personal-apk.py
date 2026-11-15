#!/usr/bin/env python3
"""Personal Android build: puts the owner's own module files (.prg/.grp) inside the APK built by GitHub Actions.

The APK on GitHub never carries BMW files. This runs on the owner's computer, with their own folder:
  1. adds <script id="ecu-bundle"> (same format as launchers/montar.pl) to assets/public/index.html,
  2. rebuilds the APK aligned like zipalign (stored entries on 4 bytes, stored .so on 4096), without the old signature,
  3. the result is signed afterwards with the same key as the CI build (android/app/e46fanatics.jks), so it
     installs over the normal app.

Usage: python3 scripts/build-personal-apk.py <in.apk> <modules folder> <out-unsigned.apk> [e46-modulos.txt]
"""
import base64
import gzip
import json
import os
import struct
import sys
import zipfile

INDEX = 'assets/public/index.html'


def bundle(folder: str, allow: set[str] | None) -> tuple[str, int]:
    names = sorted(
        f for f in os.listdir(folder)
        if f.lower().endswith(('.prg', '.grp')) and os.path.isfile(os.path.join(folder, f)) and (not allow or f.lower() in allow)
    )
    entries, body = [], bytearray()
    for f in names:
        with open(os.path.join(folder, f), 'rb') as fh:
            d = fh.read()
        entries.append([f.lower(), len(d)])
        body += d
    head = json.dumps(entries, separators=(',', ':')).encode()
    raw = struct.pack('<I', len(head)) + head + bytes(body)
    return base64.b64encode(gzip.compress(raw, 9)).decode(), len(names)


def main() -> None:
    src, folder, out = sys.argv[1:4]
    allow = None
    if len(sys.argv) > 4:
        with open(sys.argv[4], encoding='utf-8') as fh:
            allow = {l.strip().lower() for l in fh if l.strip() and not l.startswith('#')}
    b64, n = bundle(folder, allow)
    if not n:
        sys.exit('No module files in ' + folder)
    zin = zipfile.ZipFile(src)
    html = zin.read(INDEX).decode('utf-8')
    if 'id="ecu-bundle"' in html:
        sys.exit('This APK already has module files inside')
    tag = '<script id="ecu-bundle" type="application/octet-stream">' + b64 + '</script>'
    i = html.rfind('</body>')
    html = html[:i] + tag + html[i:] if i >= 0 else html + tag

    with zipfile.ZipFile(out, 'w') as zout:
        for info in zin.infolist():
            name = info.filename
            if name.startswith('META-INF/') and (name.endswith(('.SF', '.RSA', '.EC', '.DSA')) or name == 'META-INF/MANIFEST.MF'):
                continue
            data = html.encode('utf-8') if name == INDEX else zin.read(name)
            zi = zipfile.ZipInfo(name, date_time=info.date_time)
            zi.compress_type = info.compress_type
            zi.external_attr = info.external_attr
            zi.extra = b''
            if zi.compress_type == zipfile.ZIP_STORED:
                align = 4096 if name.endswith('.so') else 4
                start = zout.fp.tell() + 30 + len(name.encode('utf-8'))
                zi.extra = b'\0' * ((-start) % align)
            zout.writestr(zi, data)
    print(f'{n} module files inside, {os.path.getsize(out) / 1e6:.1f} MB -> {out}')


if __name__ == '__main__':
    main()

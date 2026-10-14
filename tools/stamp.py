"""Sella una versión nueva de Bloop antes de publicar.
- Calcula la versión con un hash del contenido de la app (cambia solo si cambió algo).
- Escribe version.json (lo consulta la app para saber si hay actualización).
- Reescribe VERSION y la lista de archivos offline de sw.js.
Uso:  python tools/stamp.py"""
import glob, hashlib, json, os, re, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

files = ['index.html', 'manifest.webmanifest', 'css/style.css',
         'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png']
files += sorted(p.replace(os.sep, '/') for p in glob.glob('js/**/*.js', recursive=True))
hashed = files + sorted(p.replace(os.sep, '/') for p in glob.glob('packs/base/*'))

h = hashlib.sha1()
for f in hashed:
    h.update(f.encode())
    with open(f, 'rb') as fh:
        h.update(fh.read())
short = h.hexdigest()[:8]

old = {}
if os.path.exists('version.json'):
    old = json.load(open('version.json', encoding='utf-8'))
if old.get('hash') == short:
    version, date = old['version'], old['date']
else:
    date = datetime.date.today().isoformat()
    version = f'{date}-{short}'
json.dump({'version': version, 'hash': short, 'date': date}, open('version.json', 'w', encoding='utf-8'), indent=1)

sw = open('sw.js', encoding='utf-8').read()
sw = re.sub(r"const VERSION = '[^']*';", f"const VERSION = 'bloop-{version}';", sw)
lst = "const FILES = [\n  './',\n" + ''.join(f"  '{f}',\n" for f in files) + "];"
sw = re.sub(r"const FILES = \[[\s\S]*?\];", lst, sw)
open('sw.js', 'w', encoding='utf-8').write(sw)
print('versión', version, '·', len(files), 'archivos offline')

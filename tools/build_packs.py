"""Construye los packs de sonidos de Bloop en ../packs/.
Uso:  python tools/build_packs.py [--only pack1,pack2] [--cache DIR]
- Sintetiza los sonidos propios (gen_sounds.py).
- Baja SOLO los archivos elegidos de bancos CC0 (Stargate, VCSL, VSCO-2-CE).
- Recorta, normaliza y comprime a Opus (ogg) a 48 kHz.
Requiere ffmpeg con libopus, numpy y scipy."""
import argparse, json, os, re, subprocess, sys, urllib.parse, urllib.request, shutil
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from dsp import SR, trim_tail, normalize, fade  # noqa: E402
import gen_sounds  # noqa: E402

ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, 'packs')

PACKS = {
    'base': dict(name='Kits Bloop', emoji='🫧', desc='Los 4 kits que vienen con la app (siempre disponibles, sin descargar).'),
    'maquinas': dict(name='Máquinas Bloop', emoji='🎛️', desc='Cajas de ritmo 808, 909, trap y dubstep sintetizadas por Bloop, más FX.'),
    'lofi': dict(name='Polvo Lofi', emoji='📼', desc='Boom bap, lo-fi y chill: bombos y cajas sucias, acordes Rhodes, pads, vinilo y lluvia.'),
    'bajos': dict(name='Bajos Gordos', emoji='🔊', desc='808 limpios y sucios, sub, reese, growls y wobbles de dubstep, Rhodes. Para tocar en notas.'),
    'acustico': dict(name='Batería real', emoji='🥁', desc='Bombos, cajas, toms, hats y platillos grabados (Stargate sample pack, CC0).'),
    'mundo': dict(name='Percusión del mundo', emoji='🪘', desc='Congas, bongós, cajón, darbuka, shakers, panderetas y más (VCSL, CC0).'),
    'instrumentos': dict(name='Instrumentos', emoji='🎹', desc='Piano, piano FM, vibráfono, kalimba, arpa, contrabajo, cuerdas, flauta y saxo (VCSL / VSCO-2-CE, CC0).'),
    'loops': dict(name='Loops, voces y FX', emoji='🔁', desc='Loops de batería, bajo, guitarra y acordes con su tempo, voces y sonidos encontrados (Stargate, CC0).'),
}
LICENSE = {
    'base': 'CC0 · sintetizado por Bloop', 'maquinas': 'CC0 · sintetizado por Bloop', 'lofi': 'CC0 · sintetizado por Bloop',
    'bajos': 'CC0 · sintetizado por Bloop', 'acustico': 'CC0 · github.com/stargatedaw/stargate-sample-pack',
    'mundo': 'CC0 · github.com/sgossner/VCSL', 'instrumentos': 'CC0 · github.com/sgossner/VCSL y github.com/sgossner/VSCO-2-CE',
    'loops': 'CC0 · github.com/stargatedaw/stargate-sample-pack',
}

NOTE = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}


def note_to_midi(s):
    m = re.match(r'([A-Ga-g])(#|b)?(-?\d)$', s)
    if not m:
        return None
    n = NOTE[m.group(1).upper()] + (1 if m.group(2) == '#' else -1 if m.group(2) == 'b' else 0)
    return (int(m.group(3)) + 1) * 12 + n


def find_note(name):
    for tok in re.split(r'[_\s\-]', os.path.splitext(name)[0]):
        mm = note_to_midi(tok)
        if mm is not None:
            return mm
    return None


# ---------------------------------------------------------------- audio I/O
def decode(path, max_dur=None):
    cmd = ['ffmpeg', '-v', 'error', '-i', path, '-f', 'f32le', '-ac', '2', '-ar', str(SR)]
    if max_dur:
        cmd += ['-t', str(max_dur)]
    raw = subprocess.run(cmd + ['-'], capture_output=True, check=True).stdout
    x = np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).T.astype(np.float64)
    if np.max(np.abs(x[0] - x[1])) < 1e-4:
        return x[0]
    return x


def encode(x, path, kbps=None):
    x = np.asarray(x, dtype=np.float32)
    ch = 1 if x.ndim == 1 else 2
    data = x if ch == 1 else x.T.copy()
    kbps = kbps or (96 if ch == 1 else 128)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ac', str(ch), '-ar', str(SR), '-i', '-',
                    '-c:a', 'libopus', '-b:a', f'{kbps}k', '-vbr', 'on', '-application', 'audio', path],
                   input=np.clip(data, -1, 1).tobytes(), check=True)
    return os.path.getsize(path)


def trim_head(x, thresh_db=-48):
    m = np.abs(x) if x.ndim == 1 else np.abs(x).max(axis=0)
    th = 10 ** (thresh_db / 20) * (m.max() + 1e-12)
    idx = np.where(m > th)[0]
    start = max(0, idx[0] - int(0.002 * SR)) if len(idx) else 0
    return x[..., start:]


def clean(x, max_dur=None, peak=-1.0, head=True, gain=None):
    if head:
        x = trim_head(x)
    x = trim_tail(x, -60)
    if max_dur and x.shape[-1] > max_dur * SR:
        x = x[..., : int(max_dur * SR)]
        x = fade(x, 0, min(0.4, max_dur / 4))
    else:
        x = fade(x, 0, 0.006)
    return x * gain if gain is not None else normalize(x, peak)


# ---------------------------------------------------------------- descargas selectivas
CACHE = None


def fetch(repo, branch, path):
    local = os.path.join(CACHE, repo.replace('/', '_'), path)
    if not os.path.exists(local):
        os.makedirs(os.path.dirname(local), exist_ok=True)
        url = f'https://raw.githubusercontent.com/{repo}/{branch}/' + urllib.parse.quote(path)
        with urllib.request.urlopen(url, timeout=120) as r, open(local + '.part', 'wb') as f:
            shutil.copyfileobj(r, f)
        os.replace(local + '.part', local)
    return local


TREES = {}


def tree(repo, branch):
    if repo not in TREES:
        url = f'https://api.github.com/repos/{repo}/git/trees/{branch}?recursive=1'
        req = urllib.request.Request(url, headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'bloop-build'})
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.load(r)
        TREES[repo] = [t['path'] for t in data['tree'] if t['type'] == 'blob' and t['path'].lower().endswith('.wav')]
    return TREES[repo]


SG = ('stargatedaw/stargate-sample-pack', 'main')
VCSL = ('sgossner/VCSL', 'master')
VSCO = ('sgossner/VSCO-2-CE', 'master')


def slug(s):
    s = re.sub(r'[^a-zA-Z0-9]+', '-', s.lower()).strip('-')
    return s[:48]


def pretty(name):
    n = os.path.splitext(os.path.basename(name))[0]
    n = re.sub(r'[_\-]+', ' ', n).strip()
    return n[:1].upper() + n[1:]


# ---------------------------------------------------------------- packs
class Pack:
    def __init__(self, pid):
        self.id = pid
        self.dir = os.path.join(OUT, pid)
        os.makedirs(self.dir, exist_ok=True)
        self.sounds, self.instruments, self.bytes = [], [], 0

    def add(self, sid, name, cat, x, tags=(), **meta):
        f = f'{sid}.ogg'
        self.bytes += encode(x, os.path.join(self.dir, f))
        self.sounds.append(dict(id=sid, name=name, cat=cat, tags=list(tags), file=f, dur=round(x.shape[-1] / SR, 3), **meta))

    def add_inst(self, iid, name, cat, zones, tags=()):
        zs = []
        for root, x in zones:
            f = f'{iid}-{root}.ogg'
            self.bytes += encode(x, os.path.join(self.dir, f))
            zs.append(dict(root=root, file=f))
        self.instruments.append(dict(id=iid, name=name, cat=cat, tags=list(tags), zones=zs))

    def save(self):
        meta = dict(id=self.id, **PACKS[self.id], license=LICENSE[self.id], sounds=self.sounds, instruments=self.instruments)
        with open(os.path.join(self.dir, 'pack.json'), 'w', encoding='utf-8') as f:
            json.dump(meta, f, ensure_ascii=False, indent=1)
        print(f'  {self.id}: {len(self.sounds)} sonidos, {len(self.instruments)} instrumentos, {self.bytes / 1048576:.1f} MB')


def build_generated(only):
    packs = {}
    for item in gen_sounds.catalog():
        pid = item['pack']
        if only and pid not in only:
            continue
        p = packs.setdefault(pid, Pack(pid))
        meta = {k: item[k] for k in ('root', 'bpm', 'loop', 'kit') if k in item}
        if item.get('zones'):
            zones = []
            for m in item['zones']:
                zones.append((m, clean(item['zfn'](m), head=False, peak=-1.5)))
            p.add_inst(item['id'], item['name'], item['cat'], zones, item['tags'])
        else:
            x = item['fn']()
            x = clean(x, head=False, peak=-1.0 if item['cat'] not in ('texture',) else -6)
            p.add(item['id'], item['name'], item['cat'], x, item['tags'], **meta)
        print('.', end='', flush=True)
    print()
    return packs


STARGATE_CATS = [
    (r'/kicks?/', 'kick'), (r'/snares?/', 'snare'), (r'/claps?/', 'clap'), (r'/hihats?/|/hats/', 'hat'),
    (r'/cymbals?/', 'cymbal'), (r'/toms?/', 'tom'), (r'/rimshot/', 'perc'), (r'/bongo/', 'perc'), (r'/percussion/', 'perc'),
]


def build_acustico(p):
    for path in tree(*SG):
        rel = path.replace('stargate-sample-pack/', '')
        if not re.search(r'(freesound/drums|fugue-state-audio/drums|karoryfer/|stargate/(kicks|hats)|microlag/One-Shots/Drums)', rel):
            continue
        cat = next((c for pat, c in STARGATE_CATS if re.search(pat, '/' + rel.lower())), 'perc')
        x = decode(fetch(*SG, path))
        maxd = 6 if cat == 'cymbal' else 3.5
        src = rel.split('/')[0]
        p.add(slug(src + '-' + os.path.splitext(os.path.basename(rel))[0]), pretty(rel), cat, clean(x, maxd), [src])
        print('.', end='', flush=True)
    print()


def build_loops(p):
    for path in tree(*SG):
        rel = path.replace('stargate-sample-pack/', '')
        name = os.path.basename(rel)
        if re.search(r'(microlag/Loops|fugue-state-audio/loops)/', rel):
            bpm = re.search(r'(\d{2,3})\s*(?:BPM|bpm)?', re.sub(r'\d+-16|\d+-8|3-4', '', name))
            bpm = int(bpm.group(1)) if bpm else None
            x = decode(fetch(*SG, path))
            x = clean(x, 24, -1.0, head=False)
            kind = 'loop-drums' if 'rum' in name.lower() or 'beat' in name.lower() else 'loop'
            p.add(slug('loop-' + os.path.splitext(name)[0]), pretty(name), kind, x, ['loop'], bpm=bpm, loop=True)
        elif re.search(r'microlag/One-Shots/(Vocals|FX)/', rel):
            x = decode(fetch(*SG, path))
            cat = 'vocal' if 'Vocals' in rel else 'fx'
            p.add(slug('ml-' + os.path.splitext(name)[0]), pretty(name), cat, clean(x, 6), [cat])
        elif re.search(r'fugue-state-audio/(found-sounds|guitar-fx)/', rel):
            x = decode(fetch(*SG, path))
            p.add(slug('fs-' + os.path.splitext(name)[0]), pretty(name), 'fx', clean(x, 6), ['fx'])
        else:
            continue
        print('.', end='', flush=True)
    print()


MUNDO = ['Bongos', 'Conga', 'Darbuka', 'Frame Drum', 'Cajon', 'Claves', 'Cowbells', 'Guiro', 'Shaker, Small', 'Shaker, Large',
         'Tambourine 1', 'Tambourine 2', 'Triangles', 'Woodblock', 'Agogo Bells', 'Cabasa', 'Slit Drum', 'Vibraslap',
         'Finger Cymbals', 'Mark Trees', 'Sleigh Bells', 'Ocean Drum', 'Snare Drum, Modern 1', 'Bass Drum 1', 'Brake Drum', 'Anvil']
MUNDO_CAT = {'Snare Drum, Modern 1': 'snare', 'Bass Drum 1': 'kick', 'Mark Trees': 'fx', 'Ocean Drum': 'texture', 'Finger Cymbals': 'cymbal'}


def stem(name):
    s = os.path.splitext(name)[0]
    s = re.sub(r'(_|\s)?(rr|RR|vl|v|k)\d+', '', s)
    s = re.sub(r'(_|\s)?\d+$', '', s)
    s = re.sub(r'(_|\s)?(soft|med|loud|mf|ff|pp|p|f)$', '', s, flags=re.I)
    return s


def vel_score(name):
    n = name.lower()
    m = re.search(r'(?:vl|_v)(\d+)', n)
    s = int(m.group(1)) if m else 2
    if 'loud' in n or 'ff' in n:
        s = 4
    if 'med' in n or '_mf' in n:
        s = 3
    if 'soft' in n:
        s = 1
    if re.search(r'rr1|_01', n):
        s += 0.5
    return s


def build_mundo(p):
    files = tree(*VCSL)
    for folder in MUNDO:
        cands = [f for f in files if f'/{folder}/' in f and 'Legacy' not in f]
        groups = {}
        for f in cands:
            groups.setdefault(stem(os.path.basename(f)), []).append(f)
        picks = [max(g, key=lambda f: vel_score(os.path.basename(f))) for _, g in sorted(groups.items())][:5]
        for f in picks:
            x = decode(fetch(*VCSL, f))
            name = folder.split(',')[0] + ' · ' + pretty(stem(os.path.basename(f))).replace(folder.split(',')[0], '').strip(' ·')
            p.add(slug('vcsl-' + folder + '-' + stem(os.path.basename(f))), name.strip(' ·'), MUNDO_CAT.get(folder, 'perc'), clean(x, 4), ['mundo'])
            print('.', end='', flush=True)
    print()


def measure_f0(x):
    """Fundamental por producto espectral armónico (para corregir la octava de los nombres)."""
    x = x if x.ndim == 1 else x.mean(axis=0)
    i = int(np.argmax(np.abs(x)))
    seg = x[i + int(0.03 * SR): i + int(0.03 * SR) + 16384]
    if len(seg) < 4096:
        seg = x[:16384]
    seg = seg * np.hanning(len(seg))
    spec = np.abs(np.fft.rfft(seg, 1 << 17))
    hps = spec.copy()
    for k in (2, 3):
        d = spec[::k]
        hps[:len(d)] *= d
    freqs = np.fft.rfftfreq(1 << 17, 1 / SR)
    lo, hi = np.searchsorted(freqs, 25), np.searchsorted(freqs, 3000)
    return freqs[lo + int(np.argmax(hps[lo:hi]))]


def octave_offset(repo, files_by_name):
    """Cada banco numera las octavas distinto: se mide la altura real de varias notas y se
    toma el corrimiento (en múltiplos de 12) más votado."""
    names = sorted(files_by_name)
    probes = dict.fromkeys([names[len(names) // 4], names[len(names) // 2], names[(3 * len(names)) // 4]])
    votes = []
    for m in probes:
        hz = measure_f0(decode(fetch(*repo, files_by_name[m]), 2))
        meas = 69 + 12 * np.log2(hz / 440)
        votes.append(int(round((meas - m) / 12)) * 12)
    return max(set(votes), key=votes.count)


INSTR = [
    # id, nombre, cat, repo, carpeta, filtro (regex sobre el nombre), rango midi real, separación mínima, duración máx
    ('piano', 'Piano vertical', 'keys', VCSL, 'Upright Piano, Yamaha/Sustains', r'_vl2_rr1', (36, 96), 3, 5),
    ('fmpiano', 'Piano FM (TX81Z)', 'keys', VCSL, 'TX81Z/FM Piano', r'_vl2', (36, 96), 6, 4),
    ('vibes', 'Vibráfono', 'keys', VCSL, 'Vibraphone', r'^(?!.*[Bb]owed).*(rr1|_01)', (48, 96), 3, 4),
    ('kalimba', 'Kalimba', 'keys', VCSL, 'Kalimba, Kenya', r'.', (40, 96), 2, 3),
    ('marimba', 'Marimba', 'keys', VCSL, 'Marimba', r'_med_', (40, 96), 3, 3),
    ('glock', 'Glockenspiel', 'keys', VCSL, 'Glockenspiel', r'glock_loud', (72, 108), 3, 3),
    ('harp', 'Arpa', 'strings', VSCO, 'Strings/Harp', r'_mf', (36, 100), 3, 4),
    ('contrabajo', 'Contrabajo pizz', 'bass', VSCO, 'Strings/Solo Contrabass/Pizz', r'_v1_rr1', (26, 60), 2, 3),
    ('cello-pizz', 'Cellos pizz', 'strings', VSCO, 'Strings/Cello Section/pizzT', r'_v2_RR1', (36, 72), 2, 2.5),
    ('violines', 'Violines', 'strings', VSCO, 'Strings/Violin Section/susVib', r'_v2', (55, 96), 3, 4),
    ('flauta', 'Flauta', 'winds', VSCO, 'Woodwinds/Flute/susvib', r'_1\.wav$|_v1_1', (60, 96), 3, 4),
    ('saxo', 'Saxo tenor', 'winds', VCSL, 'Tenor Saxophone', r'_vl3_rr1', (44, 80), 3, 4),
]


def build_instrumentos(p):
    for iid, name, cat, repo, folder, flt, (lo, hi), gap, maxd in INSTR:
        files = [f for f in tree(*repo) if f'/{folder}/' in '/' + f and re.search(flt, os.path.basename(f))]
        by_name = {}
        for f in files:
            m = find_note(os.path.basename(f))
            if m is not None and m not in by_name:
                by_name[m] = f
        if not by_name:
            print(f'  ! {iid}: sin archivos'); continue
        off = octave_offset(repo, by_name)
        by_note = {m + off: f for m, f in by_name.items() if lo <= m + off <= hi}
        notes, last = [], -99
        for m in sorted(by_note):
            if m - last >= gap:
                notes.append(m); last = m
        if not notes:
            print(f'  ! {iid}: sin notas'); continue
        zones = [(m, clean(decode(fetch(*repo, by_note[m]), maxd + 1), maxd, head=True, gain=1.0)) for m in notes]
        # Normalizado común (conserva la dinámica natural entre registros)
        peak = max(np.max(np.abs(z)) for _, z in zones)
        zones = [(m, z * (10 ** (-1.5 / 20) / peak)) for m, z in zones]
        p.add_inst(iid, name, cat, zones, ['instrumento'])
        print(f'  {iid}: {len(zones)} zonas {notes[0]}-{notes[-1]} (octava {off:+d})', flush=True)


def main():
    global CACHE
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', default='')
    ap.add_argument('--cache', default=os.path.join(ROOT, '.cache-samples'))
    a = ap.parse_args()
    CACHE = a.cache
    only = set(filter(None, a.only.split(',')))
    packs = build_generated(only)
    for pid, fn in [('acustico', build_acustico), ('loops', build_loops), ('mundo', build_mundo), ('instrumentos', build_instrumentos)]:
        if only and pid not in only:
            continue
        print(pid)
        packs[pid] = Pack(pid)
        fn(packs[pid])
    for p in packs.values():
        p.save()
    # Índice general (lee todos los pack.json existentes)
    idx = []
    for pid in PACKS:
        pj = os.path.join(OUT, pid, 'pack.json')
        if not os.path.exists(pj):
            continue
        meta = json.load(open(pj, encoding='utf-8'))
        size = sum(os.path.getsize(os.path.join(OUT, pid, f)) for f in os.listdir(os.path.join(OUT, pid)))
        idx.append(dict(id=pid, name=meta['name'], emoji=meta['emoji'], desc=meta['desc'], license=meta['license'],
                        size=size, count=len(meta['sounds']) + len(meta['instruments'])))
    with open(os.path.join(OUT, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump(dict(version=1, packs=idx), f, ensure_ascii=False, indent=1)
    print('listo:', ', '.join(f"{p['id']} {p['size'] / 1048576:.1f}MB" for p in idx))


if __name__ == '__main__':
    main()

"""Sonidos sintetizados por Bloop (propios → licencia libre CC0).
Cada generador devuelve un array mono (n,) o estéreo (2, n) a 48 kHz."""
import numpy as np
from dsp import (SR, t_axis, exp_env, ad_env, noise, butter, resonant, sweep_lowpass, drive, bitcrush,
                 to_stereo, reverb, vinyl, lofi, fade, mix, midi_hz, saw_bl, square_bl, rng)


def osc(freq, kind='sine', phase=0.0):
    ph = np.cumsum(freq) / SR + phase
    if kind == 'sine':
        return np.sin(2 * np.pi * ph)
    if kind == 'tri':
        return 2 * np.abs(2 * (ph % 1) - 1) - 1
    return np.sign(np.sin(2 * np.pi * ph))


def pitch_curve(dur, f0, f1, tau):
    t = t_axis(dur)
    return f1 + (f0 - f1) * np.exp(-t / tau)


# ---------------------------------------------------------------- Bombos
def kick_808(decay=0.9, f0=120, f1=48, tau=0.035, click=0.15, sat=0.1, seed=1):
    dur = decay * 3 + 0.05
    body = osc(pitch_curve(dur, f0, f1, tau)) * exp_env(dur, decay, 0.0008)
    c = butter(noise(0.01, seed), 'bandpass', [1500, 6000]) * exp_env(0.01, 0.0015) * click
    return fade(drive(mix(body, c), sat), 0.0003, 0.02)


def kick_909(decay=0.35, f0=320, f1=52, tau=0.022, attack=0.5, sat=0.35, seed=2):
    dur = decay * 3.2 + 0.05
    f = pitch_curve(dur, f0, f1, tau)
    body = (osc(f) * 0.85 + osc(f, 'tri') * 0.15) * exp_env(dur, decay, 0.0005)
    a = butter(noise(0.02, seed), 'highpass', 3000) * exp_env(0.02, 0.003) * attack
    return fade(drive(mix(body, a), sat), 0.0002, 0.02)


def kick_boombap(seed=3, tone=62, room=0.18, sat=0.45):
    dur = 0.7
    f = pitch_curve(dur, tone * 2.6, tone, 0.02)
    body = osc(f) * exp_env(dur, 0.16, 0.0008)
    thump = butter(noise(0.08, seed), 'lowpass', 900) * exp_env(0.08, 0.012) * 0.55
    beater = butter(noise(0.006, seed + 1), 'bandpass', [2000, 7000]) * 0.35
    x = drive(mix(body, thump, beater), sat)
    x = reverb(x, 0.35, 0.08, room, 0.004, 3500, seed, stereo=False)
    return fade(lofi(x, 12, 1, 7000, 0.1), 0.0003, 0.03)


def kick_trap(seed=4):
    dur = 0.55
    f = pitch_curve(dur, 260, 55, 0.018)
    body = osc(f) * exp_env(dur, 0.12, 0.0004)
    click = butter(noise(0.004, seed), 'highpass', 4000) * 0.6
    return fade(drive(mix(body, click), 0.55, 'clip') * 0.9, 0.0002, 0.02)


def kick_dubstep(seed=5):
    dur = 0.6
    f = pitch_curve(dur, 400, 50, 0.012)
    body = osc(f) * ad_env(dur, 0.0004, 0.04, 0.09)
    top = butter(noise(0.03, seed), 'bandpass', [3000, 9000]) * exp_env(0.03, 0.004) * 0.7
    x = drive(mix(body, top), 0.7, 'tanh')
    return fade(x, 0.0002, 0.02)


def kick_rumble(seed=6):
    k = kick_909(0.28, 280, 50, 0.02, 0.6, 0.6, seed)
    tail = reverb(k, 1.6, 0.5, 0.9, 0.01, 1200, seed, stereo=False)
    tail = drive(butter(tail, 'lowpass', 180), 0.5)
    return fade(mix(k, tail * 0.5), 0.0002, 0.1)


# ---------------------------------------------------------------- Cajas y palmas
def snare_808(tone=(238, 476), snappy=0.8, decay=0.18, seed=10):
    dur = decay * 3
    t1 = osc(np.full(int(dur * SR), tone[0])) * exp_env(dur, 0.05)
    t2 = osc(np.full(int(dur * SR), tone[1])) * exp_env(dur, 0.03) * 0.6
    n = butter(noise(dur, seed), 'highpass', 1800) * exp_env(dur, decay) * snappy
    return fade(drive(mix(t1 * 0.7, t2, n), 0.15), 0.0003, 0.02)


def snare_909(seed=11, decay=0.22, tone=190):
    dur = decay * 3
    f = pitch_curve(dur, tone * 1.5, tone, 0.012)
    body = (osc(f) + osc(f * 1.62) * 0.5) * exp_env(dur, 0.07)
    n = butter(noise(dur, seed), 'lowpass', 9000)
    n = butter(n, 'highpass', 700) * exp_env(dur, decay)
    return fade(drive(mix(body * 0.6, n * 0.9), 0.25), 0.0003, 0.02)


def snare_boombap(seed=12, room=0.3, tone=200, crack=1.0):
    dur = 0.6
    f = pitch_curve(dur, tone * 1.4, tone, 0.01)
    body = osc(f) * exp_env(dur, 0.06) * 0.6
    n = butter(noise(dur, seed), 'bandpass', [900, 8000]) * exp_env(dur, 0.12) * crack
    x = drive(mix(body, n), 0.5)
    x = reverb(x, 0.6, 0.12, room, 0.006, 5000, seed)
    return fade(lofi(x, 12, 1, 8000, 0.15), 0.0003, 0.04)


def snare_trap(seed=13):
    dur = 0.35
    body = osc(pitch_curve(dur, 330, 200, 0.01)) * exp_env(dur, 0.04) * 0.5
    n = butter(noise(dur, seed), 'highpass', 2500) * exp_env(dur, 0.07)
    c = clap_808(seed, 0.12, wet=0.05)
    return fade(mix(body, n * 0.8, c * 0.7), 0.0002, 0.02)


def snare_dubstep(seed=14):
    dur = 1.0
    body = osc(pitch_curve(dur, 400, 180, 0.008)) * exp_env(dur, 0.06) * 0.7
    n = butter(noise(dur, seed), 'bandpass', [1200, 10000]) * exp_env(dur, 0.16)
    x = drive(mix(body, n), 0.65)
    x = reverb(x, 1.4, 0.35, 0.45, 0.01, 7000, seed)
    return fade(x, 0.0002, 0.05)


def rim(seed=15, f=1700):
    dur = 0.08
    x = osc(np.full(int(dur * SR), f), 'tri') + osc(np.full(int(dur * SR), f * 0.29), 'square') * 0.4
    x = butter(x, 'bandpass', [f * 0.6, f * 2.5]) * exp_env(dur, 0.012)
    return fade(x, 0.0002, 0.005)


def clap_808(seed=16, decay=0.2, wet=0.18, bp=1100):
    dur = decay * 3 + 0.05
    n = butter(noise(dur, seed), 'bandpass', [bp * 0.6, bp * 2.2])
    env = np.zeros(int(dur * SR))
    for k, off in enumerate([0, 0.011, 0.022, 0.031]):
        i = int(off * SR)
        seg = exp_env(dur, 0.004 if k < 3 else decay)[: len(env) - i]
        env[i:] = np.maximum(env[i:], seg * (0.9 if k < 3 else 1))
    x = n * env
    return fade(reverb(x, 0.8, 0.18, wet, 0.004, 7000, seed), 0.0002, 0.03)


def snap(seed=17):
    dur = 0.18
    n = butter(noise(dur, seed), 'bandpass', [1800, 4500]) * exp_env(dur, 0.025)
    t = osc(np.full(int(dur * SR), 1200)) * exp_env(dur, 0.006) * 0.3
    return fade(reverb(mix(n, t), 0.4, 0.08, 0.15, 0.003, 8000, seed), 0.0002, 0.02)


# ---------------------------------------------------------------- Hats, platillos
METAL = [205.3, 304.4, 369.6, 522.7, 540.0, 800.0]


def metal(dur, scale=1.0):
    n = int(dur * SR)
    return sum(osc(np.full(n, f * scale), 'square') for f in METAL) / 6


def hat_808(decay=0.05, scale=1.0, seed=20, hp=7000):
    dur = max(0.08, decay * 4)
    x = metal(dur, scale) + noise(dur, seed) * 0.15
    x = butter(x, 'bandpass', [hp, 15000]) * exp_env(dur, decay, 0.0003)
    return fade(x, 0.0002, 0.01)


def hat_909(decay=0.06, seed=21):
    dur = max(0.08, decay * 4)
    x = butter(noise(dur, seed), 'highpass', 8000) * 0.7 + butter(metal(dur, 1.4), 'highpass', 7000) * 0.5
    return fade(x * exp_env(dur, decay, 0.0003), 0.0002, 0.01)


def hat_lofi(decay=0.04, seed=22):
    x = hat_909(decay, seed)
    return lofi(x, 8, 2, 7000, 0.3)


def hat_trap(decay=0.025, seed=23):
    x = hat_808(decay, 1.3, seed, 9000)
    return drive(x * 2, 0.2)


def cymbal(decay=1.6, kind='crash', seed=24):
    dur = decay * 2.5
    x = metal(dur, 1.6) * 0.5 + noise(dur, seed) * 0.6
    if kind == 'ride':
        bell = sum(osc(np.full(int(dur * SR), f)) for f in [3310, 4620, 5380]) / 3 * 0.3
        x = x * 0.5 + bell
    x = butter(x, 'highpass', 4500 if kind == 'crash' else 5500) * exp_env(dur, decay, 0.001)
    return fade(to_stereo(x, 0.6, seed), 0.0005, 0.2)


def shaker(seed=25, decay=0.07, attack=0.018):
    dur = 0.25
    x = butter(noise(dur, seed), 'bandpass', [5000, 12000]) * ad_env(dur, attack, 0.005, decay)
    return fade(x, 0.0, 0.01)


def tambourine(seed=26):
    dur = 0.4
    jing = sum(osc(np.full(int(dur * SR), f)) * 0.2 for f in [5200, 6900, 8100, 9700])
    x = (butter(noise(dur, seed), 'highpass', 6000) * 0.6 + jing) * exp_env(dur, 0.09, 0.001)
    return fade(x, 0.0002, 0.02)


# ---------------------------------------------------------------- Toms y percusión
def tom_808(f=110, decay=0.35, seed=30):
    dur = decay * 3
    x = osc(pitch_curve(dur, f * 1.6, f, 0.05)) * exp_env(dur, decay)
    x = mix(x, butter(noise(0.04, seed), 'bandpass', [f * 3, f * 8]) * exp_env(0.04, 0.008) * 0.2)
    return fade(x, 0.0003, 0.02)


def conga_808(f=330, decay=0.18, seed=31):
    return tom_808(f, decay, seed)


def cowbell_808(seed=32):
    dur = 0.6
    x = osc(np.full(int(dur * SR), 540), 'square') + osc(np.full(int(dur * SR), 800), 'square')
    x = butter(x, 'bandpass', [600, 3200])
    env = np.maximum(exp_env(dur, 0.012) * 0.8, exp_env(dur, 0.18) * 0.35)
    return fade(x * env, 0.0002, 0.02)


def clave(f=2500):
    dur = 0.1
    return fade(osc(np.full(int(dur * SR), f)) * exp_env(dur, 0.018), 0.0002, 0.005)


def woodblock(f=900, seed=33):
    dur = 0.12
    x = osc(np.full(int(dur * SR), f)) + osc(np.full(int(dur * SR), f * 2.7)) * 0.3
    return fade(x * exp_env(dur, 0.025), 0.0002, 0.01)


def zap(f0=3000, f1=90, dur=0.25):
    x = osc(pitch_curve(dur, f0, f1, dur / 4), 'square')
    return fade(butter(x, 'lowpass', 5000) * exp_env(dur, dur / 2), 0.0002, 0.01)


# ---------------------------------------------------------------- FX y texturas
def riser(dur=4.0, seed=40):
    t = t_axis(dur)
    n = noise(dur, seed)
    y = np.zeros_like(n)
    for i in range(0, len(n), 512):
        f = 300 * (40 ** (i / len(n)))
        y[i:i + 512] = resonant(n[i:i + 512], 'bandpass', min(f, 16000), 2.5)
    tone = osc(200 * 8 ** (t / dur)) * 0.15
    x = (y * 0.8 + tone) * (t / dur) ** 2
    return fade(to_stereo(x, 0.8, seed), 0.01, 0.05)


def downlifter(dur=3.0, seed=41):
    return riser(dur, seed)[:, ::-1].copy()


def impact(seed=42):
    dur = 3.0
    boom = osc(pitch_curve(dur, 90, 32, 0.4)) * exp_env(dur, 0.9)
    crack = butter(noise(0.5, seed), 'lowpass', 6000) * exp_env(0.5, 0.06)
    x = drive(mix(boom, crack), 0.4)
    return fade(reverb(x, 3.0, 1.0, 0.5, 0.02, 3000, seed), 0.0002, 0.3)


def sub_drop(dur=2.5):
    x = osc(pitch_curve(dur, 110, 28, 0.6)) * exp_env(dur, 1.0, 0.002)
    return fade(drive(x, 0.3), 0.001, 0.2)


def reverse_cymbal(seed=43):
    c = cymbal(1.2, 'crash', seed)
    return fade(c[:, ::-1].copy(), 0.05, 0.003)


def tape_stop(seed=44):
    dur = 1.2
    t = t_axis(dur)
    f = 220 * np.maximum(0.02, 1 - t / dur) ** 1.5
    x = butter(saw(f), 'lowpass', 2500) * 0.6
    return fade(x, 0.002, 0.05)


def saw(f):
    ph = np.cumsum(f) / SR
    return 2 * (ph % 1) - 1


def vinyl_loop(dur=8.0, seed=45):
    return vinyl(dur, seed, 1.6)


def rain(dur=8.0, seed=46):
    r = rng(seed)
    n = int(dur * SR)
    bed = butter(r.normal(0, 1, (2, n)), 'bandpass', [600, 6000]) * 0.05
    drops = np.zeros((2, n))
    for _ in range(int(dur * 90)):
        i = r.integers(0, n - 2000)
        f = r.uniform(1500, 5000)
        d = np.sin(2 * np.pi * f * np.arange(800) / SR) * np.exp(-np.arange(800) / 120) * r.uniform(0.02, 0.15)
        drops[r.integers(0, 2), i:i + 800] += d
    return bed + drops


def tape_hiss(dur=6.0, seed=47):
    r = rng(seed)
    return butter(r.normal(0, 1, (2, int(dur * SR))), 'bandpass', [2000, 12000]) * 0.03


# ---------------------------------------------------------------- Bajos (instrumentos tonales)
def bass_808(midi, decay=1.6, sat=0.15, bend=4, seed=50):
    f = midi_hz(midi)
    dur = decay * 2.2 + 0.1
    fr = pitch_curve(dur, f * 2 ** (bend / 12), f, 0.03)
    x = osc(fr) * ad_env(dur, 0.002, 0.08, decay)
    x = mix(x, osc(fr * 2) * ad_env(dur, 0.001, 0.0, 0.05) * 0.15)
    click = butter(noise(0.006, seed), 'bandpass', [1000, 5000]) * 0.15
    return fade(drive(mix(x, click), sat), 0.0003, 0.08)


def bass_808_dirty(midi):
    x = bass_808(midi, 1.8, 0.65, 7)
    return butter(x, 'lowpass', 3500)


def bass_sub(midi, dur=2.2):
    f = midi_hz(midi)
    x = osc(np.full(int(dur * SR), f)) * ad_env(dur, 0.004, dur * 0.7, 0.25)
    return fade(drive(x, 0.08), 0.004, 0.1)


def bass_reese(midi, dur=2.4, seed=51):
    f = midi_hz(midi)
    v = saw_bl(f, dur, -14) + saw_bl(f, dur, 14, 0.37) + saw_bl(f, dur, 3, 0.71) * 0.5
    v = v / 2.2
    t = t_axis(dur)
    # Movimiento lento del filtro, típico del reese
    y = np.zeros_like(v)
    zi = None
    for i in range(0, len(v), 128):
        fc = 650 + 350 * np.sin(2 * np.pi * 0.35 * t[i])
        w0 = 2 * np.pi * fc / SR
        al = np.sin(w0) / 2.2
        c = np.cos(w0)
        b = np.array([(1 - c) / 2, 1 - c, (1 - c) / 2]) / (1 + al)
        a = np.array([1, -2 * c / (1 + al), (1 - al) / (1 + al)])
        from scipy.signal import lfilter
        y[i:i + 128], zi = lfilter(b, a, v[i:i + 128], zi=zi if zi is not None else np.zeros(2))
    sub = np.sin(2 * np.pi * f * t) * 0.6
    x = drive(y + sub, 0.3) * ad_env(dur, 0.01, dur * 0.75, 0.2)
    return fade(to_stereo(x, 0.5, seed), 0.003, 0.1)


def bass_growl(midi, rate=4.0, ratio=1.0, index=6.0, dur=1.6, vowel=(500, 1500), seed=52):
    """Growl tipo dubstep: FM con índice modulado + formantes + distorsión."""
    f = midi_hz(midi)
    t = t_axis(dur)
    lfo = 0.5 - 0.5 * np.cos(2 * np.pi * rate * t)
    mod = np.sin(2 * np.pi * f * ratio * t)
    car = np.sin(2 * np.pi * f * t + index * lfo * mod)
    car = car + saw_bl(f, dur) * 0.3
    x = drive(car, 0.8)
    f1 = resonant(x, 'bandpass', vowel[0], 3)
    f2 = resonant(x, 'bandpass', vowel[1], 4)
    x = drive((f1 + f2 * 0.7) * 3, 0.6) + np.sin(2 * np.pi * f * t) * 0.5
    return fade(to_stereo(x * ad_env(dur, 0.003, dur * 0.8, 0.08), 0.3, seed), 0.002, 0.05)


def bass_wobble(midi, bpm=140, div=8, dur=None, seed=53):
    """Wobble clásico: sierras por un pasa-bajos resonante que abre y cierra a tempo."""
    beat = 60 / bpm
    dur = dur or beat * 4
    f = midi_hz(midi)
    v = (saw_bl(f, dur, -8) + saw_bl(f, dur, 8, 0.3) + square_bl(f / 2, dur) * 0.4) / 2.4
    t = t_axis(dur)
    rate = div / 4 / beat
    lfo = 0.5 - 0.5 * np.cos(2 * np.pi * rate * t)
    y = np.zeros_like(v)
    from scipy.signal import lfilter
    zi = np.zeros(2)
    for i in range(0, len(v), 64):
        fc = 90 * (40 ** lfo[i])
        w0 = 2 * np.pi * min(fc, 18000) / SR
        al = np.sin(w0) / (2 * 4.0)
        c = np.cos(w0)
        b = np.array([(1 - c) / 2, 1 - c, (1 - c) / 2]) / (1 + al)
        a = np.array([1, -2 * c / (1 + al), (1 - al) / (1 + al)])
        y[i:i + 64], zi = lfilter(b, a, v[i:i + 64], zi=zi)
    x = drive(y * 1.5, 0.5) + np.sin(2 * np.pi * f * t) * 0.45
    return fade(x * ad_env(dur, 0.003, dur - 0.05, 0.02), 0.002, 0.03)


def bass_pluck(midi, seed=54):
    f = midi_hz(midi)
    dur = 0.9
    v = saw_bl(f, dur) * 0.7 + square_bl(f, dur) * 0.3
    x = sweep_lowpass(v, 4000, 160, 0.08, 1.8) * exp_env(dur, 0.35, 0.001)
    x = mix(x, np.sin(2 * np.pi * f * t_axis(dur)) * exp_env(dur, 0.4) * 0.5)
    return fade(drive(x, 0.3), 0.0005, 0.05)


# ---------------------------------------------------------------- Teclas y acordes lofi
def ep_note(f, dur, vel=0.8, seed=60):
    """Piano eléctrico FM (tipo Rhodes): dos operadores + trémolo suave."""
    t = t_axis(dur)
    idx = (1.6 + vel) * np.exp(-t / 0.35) + 0.25
    mod = np.sin(2 * np.pi * f * t)
    car = np.sin(2 * np.pi * f * t + idx * mod)
    tine = np.sin(2 * np.pi * f * 7.02 * t) * np.exp(-t / 0.02) * 0.08 * vel
    trem = 1 + 0.12 * np.sin(2 * np.pi * 4.2 * t)
    return (car + tine) * np.exp(-t / (2.6 - min(1.5, f / 800))) * trem * vel


def chord(intervals, root=48, dur=3.2, kind='ep', seed=61, lofi_amt=0.6):
    notes = [root + i for i in intervals]
    parts = []
    r = rng(seed)
    for k, m in enumerate(notes):
        f = midi_hz(m) * 2 ** (r.uniform(-4, 4) / 1200)
        if kind == 'ep':
            v = ep_note(f, dur, 0.75 + r.uniform(-0.1, 0.1))
        else:  # pad cálido
            v = (saw_bl(f, dur, -7) + saw_bl(f, dur, 7, 0.4)) / 2
            v = butter(v, 'lowpass', 1400) * ad_env(dur, 0.6, dur - 1.2, 0.5)
        pad = np.zeros(int(dur * SR))
        off = int(k * 0.012 * SR) if kind == 'ep' else 0   # rasgueo suave
        pad[off:] = v[: len(pad) - off]
        parts.append(pad)
    x = sum(parts) / len(parts) * 1.6
    x = to_stereo(x, 0.4, seed)
    x = reverb(x, 1.8, 0.5, 0.18, 0.015, 4500, seed)
    if lofi_amt > 0:
        x = lofi(x, 11, 1, 5200, 0.2 * lofi_amt, wobble=lofi_amt)
        x = mix(x, vinyl(x.shape[1] / SR, seed, 0.25 * lofi_amt))
    return fade(x, 0.002, 0.3)


def ep_inst(midi, dur=2.6):
    x = ep_note(midi_hz(midi), dur, 0.8)
    x = to_stereo(x, 0.35, 62)
    return fade(lofi(x, 14, 1, 9000, 0.12, wobble=0.25), 0.001, 0.15)


# ---------------------------------------------------------------- Catálogo
CH = {'m7': [0, 3, 7, 10], 'm9': [0, 3, 7, 10, 14], 'maj7': [0, 4, 7, 11], 'maj9': [0, 4, 7, 11, 14],
      'add9': [0, 4, 7, 14], 'dom9': [0, 4, 10, 14], 'm11': [0, 3, 10, 14, 17], 'sus2': [0, 2, 7, 12]}


def catalog():
    """(pack, id, nombre, categoría, tags, fn, extra)"""
    S = []
    add = lambda pack, sid, name, cat, tags, fn, **kw: S.append(dict(pack=pack, id=sid, name=name, cat=cat, tags=tags, fn=fn, **kw))

    # ---- Pack base (kits por defecto, viene con la app)
    base = [
        ('Chicle 808', [('Bombo 808', lambda: kick_808(1.0)), ('Caja 808', lambda: snare_808()), ('Palmas 808', lambda: clap_808()),
                        ('Hat cerrado', lambda: hat_808(0.045)), ('Hat abierto', lambda: hat_808(0.32)), ('Tom 808', lambda: tom_808(105, 0.45)),
                        ('Cencerro', cowbell_808), ('Conga 808', lambda: conga_808(330))]),
        ('Polvo Lofi', [('Bombo polvo', lambda: kick_boombap(3, 58)), ('Caja polvo', lambda: snare_boombap(12, 0.3)), ('Rim polvo', lambda: lofi(rim(), 9, 2, 6000, 0.3)),
                        ('Hat polvo', lambda: hat_lofi(0.035)), ('Shaker', lambda: lofi(shaker(), 10, 1, 8000)), ('Hat polvo abierto', lambda: hat_lofi(0.22, 7)),
                        ('Acorde m9', lambda: chord(CH['m9'], 50, 2.4, seed=1)), ('Vinilo', lambda: vinyl_loop(4.0))]),
        ('Neón Techno', [('Bombo 909', lambda: kick_909()), ('Caja 909', lambda: snare_909()), ('Palmas XL', lambda: clap_808(18, 0.3, 0.3, 1300)),
                         ('Hat 909', lambda: hat_909(0.04)), ('Hat 909 abierto', lambda: hat_909(0.3, 8)), ('Rim', lambda: rim(15, 2100)),
                         ('Rumble', kick_rumble), ('Zap', lambda: zap())]),
        ('Bajo Tierra', [('Bombo trap', kick_trap), ('Caja trap', snare_trap), ('Snap', snap),
                         ('Hat trap', lambda: hat_trap()), ('Hat trap abierto', lambda: hat_808(0.18, 1.3, 9, 9000)), ('Caja dubstep', snare_dubstep),
                         ('Sub drop', sub_drop), ('808 bajo (C2)', lambda: bass_808(36, 1.5, 0.3))]),
    ]
    for ki, (kit, sounds) in enumerate(base):
        for si, (name, fn) in enumerate(sounds):
            add('base', f'k{ki}-{si}', name, 'kit', [kit], fn, kit=kit)

    # ---- Máquinas Bloop
    P = 'maquinas'
    for i, (d, f0, tau, sat) in enumerate([(0.5, 110, 0.04, 0.05), (0.9, 125, 0.035, 0.1), (1.6, 120, 0.03, 0.15), (2.4, 115, 0.03, 0.2), (0.7, 140, 0.02, 0.5), (1.2, 100, 0.05, 0.35)]):
        add(P, f'kick-808-{i}', f'Bombo 808 {["corto", "medio", "largo", "eterno", "duro", "cálido"][i]}', 'kick', ['808'], lambda d=d, f0=f0, tau=tau, sat=sat: kick_808(d, f0, 46, tau, 0.15, sat, i))
    for i, (d, f0, at, sat) in enumerate([(0.3, 320, 0.5, 0.3), (0.45, 280, 0.4, 0.4), (0.22, 360, 0.7, 0.55), (0.6, 260, 0.3, 0.2)]):
        add(P, f'kick-909-{i}', f'Bombo 909 {i + 1}', 'kick', ['909', 'house', 'techno'], lambda d=d, f0=f0, at=at, sat=sat: kick_909(d, f0, 52, 0.022, at, sat, 20 + i))
    add(P, 'kick-rumble', 'Bombo rumble', 'kick', ['techno'], kick_rumble)
    add(P, 'kick-trap-1', 'Bombo trap', 'kick', ['trap'], kick_trap)
    add(P, 'kick-dub', 'Bombo dubstep', 'kick', ['dubstep'], kick_dubstep)
    for i, (tone, snappy, dec) in enumerate([((238, 476), 0.8, 0.18), ((210, 400), 1.0, 0.25), ((260, 520), 0.6, 0.12)]):
        add(P, f'snare-808-{i}', f'Caja 808 {i + 1}', 'snare', ['808'], lambda tone=tone, snappy=snappy, dec=dec, s=10 + i: snare_808(tone, snappy, dec, s))
    for i, (d, tone) in enumerate([(0.18, 190), (0.28, 175), (0.14, 220)]):
        add(P, f'snare-909-{i}', f'Caja 909 {i + 1}', 'snare', ['909'], lambda d=d, tone=tone: snare_909(30 + i, d, tone))
    add(P, 'snare-trap', 'Caja trap', 'snare', ['trap'], snare_trap)
    add(P, 'snare-dub', 'Caja dubstep', 'snare', ['dubstep'], snare_dubstep)
    add(P, 'rim-808', 'Rim 808', 'perc', ['808'], rim)
    for i, (d, w, bp) in enumerate([(0.2, 0.18, 1100), (0.3, 0.35, 1300), (0.15, 0.1, 900)]):
        add(P, f'clap-{i}', f'Palmas {["808", "grandes", "secas"][i]}', 'clap', ['808'], lambda d=d, w=w, bp=bp: clap_808(40 + i, d, w, bp))
    add(P, 'snap', 'Chasquido', 'clap', [], snap)
    for i, d in enumerate([0.03, 0.05, 0.08]):
        add(P, f'hat-808-c{i}', f'Hat 808 cerrado {i + 1}', 'hat', ['808'], lambda d=d: hat_808(d, 1.0, 50 + i))
    for i, d in enumerate([0.25, 0.45]):
        add(P, f'hat-808-o{i}', f'Hat 808 abierto {i + 1}', 'hat', ['808'], lambda d=d: hat_808(d, 1.0, 60 + i))
    for i, d in enumerate([0.035, 0.07]):
        add(P, f'hat-909-c{i}', f'Hat 909 cerrado {i + 1}', 'hat', ['909'], lambda d=d: hat_909(d, 70 + i))
    add(P, 'hat-909-o', 'Hat 909 abierto', 'hat', ['909'], lambda: hat_909(0.35, 72))
    for i, d in enumerate([0.02, 0.03]):
        add(P, f'hat-trap-{i}', f'Hat trap {i + 1}', 'hat', ['trap'], lambda d=d: hat_trap(d, 80 + i))
    add(P, 'crash', 'Crash', 'cymbal', [], lambda: cymbal(1.8, 'crash', 90))
    add(P, 'ride', 'Ride', 'cymbal', [], lambda: cymbal(2.4, 'ride', 91))
    for i, (f, d) in enumerate([(85, 0.5), (110, 0.4), (150, 0.32), (200, 0.25)]):
        add(P, f'tom-808-{i}', f'Tom 808 {["grave", "medio", "agudo", "más agudo"][i]}', 'tom', ['808'], lambda f=f, d=d: tom_808(f, d, 100 + i))
    for i, f in enumerate([250, 330, 440]):
        add(P, f'conga-808-{i}', f'Conga 808 {i + 1}', 'perc', ['808'], lambda f=f: conga_808(f, 0.18, 110 + i))
    add(P, 'cowbell', 'Cencerro 808', 'perc', ['808'], cowbell_808)
    add(P, 'clave', 'Clave', 'perc', [], clave)
    add(P, 'woodblock', 'Bloque', 'perc', [], woodblock)
    add(P, 'shaker', 'Shaker', 'perc', [], shaker)
    add(P, 'tamb', 'Pandereta', 'perc', [], tambourine)

    # ---- Polvo Lofi (hip-hop / lo-fi)
    P = 'lofi'
    for i, (tone, room, sat) in enumerate([(58, 0.18, 0.45), (52, 0.25, 0.6), (66, 0.12, 0.35), (60, 0.3, 0.7)]):
        add(P, f'kick-bb-{i}', f'Bombo boom bap {i + 1}', 'kick', ['boom bap', 'lofi'], lambda tone=tone, room=room, sat=sat: kick_boombap(200 + i, tone, room, sat))
    for i in range(3):
        add(P, f'kick-lofi-{i}', f'Bombo polvoriento {i + 1}', 'kick', ['lofi'], lambda i=i: lofi(kick_808(0.4 + i * 0.25, 110, 50, 0.04, 0.2, 0.3), 9, 2, 3500 + i * 800, 0.4))
    for i, (room, tone, crack) in enumerate([(0.3, 200, 1.0), (0.45, 180, 0.8), (0.2, 230, 1.2), (0.5, 210, 0.9)]):
        add(P, f'snare-bb-{i}', f'Caja boom bap {i + 1}', 'snare', ['boom bap', 'lofi'], lambda room=room, tone=tone, crack=crack: snare_boombap(220 + i, room, tone, crack))
    for i in range(2):
        add(P, f'rim-lofi-{i}', f'Rim lofi {i + 1}', 'perc', ['lofi'], lambda i=i: lofi(rim(230 + i, 1500 + i * 400), 9, 2, 6000, 0.3))
    for i, d in enumerate([0.03, 0.05, 0.2]):
        add(P, f'hat-lofi-{i}', f'Hat lofi {i + 1}', 'hat', ['lofi'], lambda d=d: hat_lofi(d, 240 + i))
    add(P, 'shaker-lofi', 'Shaker lofi', 'perc', ['lofi'], lambda: lofi(shaker(250, 0.09), 10, 1, 7000))
    add(P, 'snap-lofi', 'Chasquido lofi', 'clap', ['lofi'], lambda: lofi(snap(251), 10, 2, 6000, 0.3))
    for i, (name, ivs, root) in enumerate([('m9', CH['m9'], 50), ('maj7', CH['maj7'], 53), ('m7', CH['m7'], 45), ('maj9', CH['maj9'], 48),
                                            ('add9', CH['add9'], 55), ('dom9', CH['dom9'], 52), ('m11', CH['m11'], 47), ('sus2', CH['sus2'], 50)]):
        add(P, f'chord-ep-{i}', f'Acorde Rhodes {name}', 'chord', ['lofi', 'chill'], lambda ivs=ivs, root=root: chord(ivs, root, 3.2, 'ep', 300 + i), root=root)
    for i, (name, ivs, root) in enumerate([('m9', CH['m9'], 48), ('maj7', CH['maj7'], 50), ('sus2', CH['sus2'], 52)]):
        add(P, f'chord-pad-{i}', f'Pad nostalgia {name}', 'chord', ['chill'], lambda ivs=ivs, root=root: chord(ivs, root, 4.5, 'pad', 320 + i, 0.8), root=root)
    add(P, 'vinyl', 'Vinilo (loop)', 'texture', ['lofi'], lambda: vinyl_loop(8.0), loop=True)
    add(P, 'rain', 'Lluvia (loop)', 'texture', ['chill'], lambda: rain(8.0), loop=True)
    add(P, 'hiss', 'Soplido de cinta', 'texture', ['lofi'], lambda: tape_hiss(6.0), loop=True)
    add(P, 'tapestop', 'Tape stop', 'fx', ['lofi'], tape_stop)

    # ---- Bajos Gordos (instrumentos multisampleados)
    P = 'bajos'
    zones = [24, 30, 36, 42, 48]
    add(P, 'i-808', '808 limpio', 'bass', ['808', 'trap'], None, zones=zones, zfn=lambda m: bass_808(m, 1.6, 0.15))
    add(P, 'i-808-dirty', '808 sucio', 'bass', ['808', 'trap'], None, zones=zones, zfn=bass_808_dirty)
    add(P, 'i-808-long', '808 eterno', 'bass', ['808'], None, zones=zones, zfn=lambda m: bass_808(m, 3.2, 0.25, 3))
    add(P, 'i-sub', 'Sub puro', 'bass', ['sub'], None, zones=zones, zfn=bass_sub)
    add(P, 'i-reese', 'Reese oscuro', 'bass', ['dnb', 'dubstep'], None, zones=zones, zfn=bass_reese)
    add(P, 'i-pluck', 'Bajo pluck', 'bass', ['synth'], None, zones=zones, zfn=bass_pluck)
    add(P, 'i-ep', 'Rhodes lofi', 'keys', ['lofi', 'chill'], None, zones=[36, 42, 48, 54, 60, 66, 72, 78, 84], zfn=lambda m: ep_inst(m))
    growls = [(4, 1.0, 6, (500, 1500)), (8, 2.0, 4, (700, 1100)), (2, 0.5, 8, (400, 2200)), (6, 1.5, 5, (900, 1800)), (3, 1.0, 9, (300, 900)), (12, 1.0, 3, (600, 2600))]
    for i, (rate, ratio, idx, vowel) in enumerate(growls):
        add(P, f'growl-{i}', f'Growl {["yoi", "rasposo", "lento", "gritón", "monstruo", "metralla"][i]}', 'bass', ['dubstep'],
            lambda rate=rate, ratio=ratio, idx=idx, vowel=vowel: bass_growl(29, rate, ratio, idx, 1.6, vowel, 400 + i), root=29)
    for i, div in enumerate([4, 8, 12, 16]):
        add(P, f'wobble-{div}', f'Wobble 140 1/{div}', 'bass', ['dubstep'], lambda div=div: bass_wobble(29, 140, div), root=29, bpm=140)
    add(P, 'sub-drop', 'Sub drop', 'fx', ['dubstep', 'trap'], sub_drop)

    # ---- FX
    P = 'maquinas'
    add(P, 'riser', 'Riser', 'fx', [], riser)
    add(P, 'downlifter', 'Downlifter', 'fx', [], downlifter)
    add(P, 'impact', 'Impacto', 'fx', [], impact)
    add(P, 'revcym', 'Platillo al revés', 'fx', [], reverse_cymbal)
    add(P, 'zap', 'Zap', 'fx', [], zap)
    add(P, 'laser', 'Láser', 'fx', [], lambda: zap(6000, 300, 0.35))
    return S

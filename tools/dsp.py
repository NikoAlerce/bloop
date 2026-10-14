"""Bloques de DSP para generar los sonidos de Bloop (numpy, 48 kHz)."""
import numpy as np
from scipy import signal

SR = 48000


def rng(seed):
    return np.random.default_rng(seed)


def t_axis(dur):
    return np.arange(int(dur * SR)) / SR


def phase_osc(freq, kind='sine'):
    """Oscilador con frecuencia variable (array o escalar)."""
    ph = np.cumsum(np.broadcast_to(freq, freq.shape if hasattr(freq, 'shape') else (1,))) / SR
    if kind == 'sine':
        return np.sin(2 * np.pi * ph)
    if kind == 'tri':
        return 2 * np.abs(2 * (ph % 1) - 1) - 1
    if kind == 'square':
        return np.sign(np.sin(2 * np.pi * ph))
    raise ValueError(kind)


def saw_bl(freq, dur, detune_cents=0.0, phase0=0.0):
    """Sierra con banda limitada (aditiva), sin aliasing audible."""
    t = t_axis(dur)
    f = freq * 2 ** (detune_cents / 1200)
    out = np.zeros_like(t)
    n = int((SR / 2 * 0.9) // f)
    for k in range(1, max(2, n + 1)):
        out += np.sin(2 * np.pi * k * (f * t + phase0)) / k
    return out * (2 / np.pi)


def square_bl(freq, dur):
    t = t_axis(dur)
    out = np.zeros_like(t)
    n = int((SR / 2 * 0.9) // freq)
    for k in range(1, max(2, n + 1), 2):
        out += np.sin(2 * np.pi * k * freq * t) / k
    return out * (4 / np.pi)


def exp_env(dur, tau, attack=0.0005):
    t = t_axis(dur)
    e = np.exp(-t / max(tau, 1e-4))
    a = int(attack * SR)
    if a > 1:
        e[:a] *= np.linspace(0, 1, a)
    return e


def ad_env(dur, attack, hold, decay_tau):
    t = t_axis(dur)
    e = np.where(t < attack, t / max(attack, 1e-5), 1.0)
    e = np.where(t > attack + hold, np.exp(-(t - attack - hold) / decay_tau), e)
    return e


def noise(dur, seed=1):
    return rng(seed).uniform(-1, 1, int(dur * SR))


def butter(x, kind, f, order=2):
    f = np.atleast_1d(f)
    wn = np.clip(f / (SR / 2), 1e-4, 0.999)
    sos = signal.butter(order, wn if len(wn) > 1 else wn[0], btype=kind, output='sos')
    return signal.sosfilt(sos, x, axis=-1)


def resonant(x, kind, f, q):
    """Biquad RBJ con resonancia (lowpass/bandpass/highpass/peak)."""
    w0 = 2 * np.pi * f / SR
    alpha = np.sin(w0) / (2 * q)
    c = np.cos(w0)
    if kind == 'lowpass':
        b = [(1 - c) / 2, 1 - c, (1 - c) / 2]
    elif kind == 'highpass':
        b = [(1 + c) / 2, -(1 + c), (1 + c) / 2]
    elif kind == 'bandpass':
        b = [alpha, 0, -alpha]
    else:
        raise ValueError(kind)
    a = [1 + alpha, -2 * c, 1 - alpha]
    return signal.lfilter(np.array(b) / a[0], np.array(a) / a[0], x, axis=-1)


def sweep_lowpass(x, f_start, f_end, tau, q=0.9, block=64):
    """Pasa-bajos resonante con frecuencia que cae exponencialmente (bloques)."""
    y = np.zeros_like(x)
    zi = np.zeros(2)
    for i in range(0, len(x), block):
        tt = i / SR
        f = f_end + (f_start - f_end) * np.exp(-tt / tau)
        w0 = 2 * np.pi * min(f, SR * 0.45) / SR
        alpha = np.sin(w0) / (2 * q)
        c = np.cos(w0)
        b = np.array([(1 - c) / 2, 1 - c, (1 - c) / 2]) / (1 + alpha)
        a = np.array([1, -2 * c / (1 + alpha), (1 - alpha) / (1 + alpha)])
        y[i:i + block], zi = signal.lfilter(b, a, x[i:i + block], zi=zi)
    return y


def drive(x, amt, kind='tanh'):
    if amt <= 0:
        return x
    k = 1 + amt * 12
    if kind == 'tanh':
        return np.tanh(k * x) / np.tanh(k)
    if kind == 'fold':
        y = k * x
        return np.sin(y) * 0.9
    if kind == 'clip':
        return np.clip(k * x, -1, 1)
    return x


def bitcrush(x, bits=8, down=2):
    q = 2 ** (bits - 1)
    y = np.round(x * q) / q
    if down > 1:
        y = np.repeat(y[..., ::down], down, axis=-1)[..., :x.shape[-1]]
    return y


def to_stereo(x, width=0.0, seed=3):
    """Mono → estéreo, con ensanchado por decorrelación (filtros pasa-todo)."""
    if x.ndim == 2:
        return x
    if width <= 0:
        return np.stack([x, x])
    d = int(0.011 * SR)
    side = np.concatenate([np.zeros(d), x[:-d]]) - np.concatenate([np.zeros(d // 2), x[:-(d // 2)]])
    side = butter(side, 'highpass', 300)
    return np.stack([x + side * width * 0.5, x - side * width * 0.5])


def reverb(x, dur=1.2, decay=0.35, wet=0.25, predelay=0.012, tone=6000, seed=9, stereo=True):
    """Reverb por convolución con IR de ruido decreciente (oscurecida)."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    chans = []
    for c in range(2 if stereo else 1):
        ir = rng(seed + c).uniform(-1, 1, n) * np.exp(-t / decay)
        ir = butter(ir, 'lowpass', tone)
        ir[: int(predelay * SR)] = 0
        ir /= np.sqrt(np.sum(ir ** 2)) + 1e-9
        chans.append(ir)
    xm = x if x.ndim == 1 else x.mean(axis=0)
    wets = [signal.fftconvolve(xm, ir)[: len(xm) + n] for ir in chans]
    L = len(wets[0])
    dry = np.zeros((2, L)) if stereo else np.zeros(L)
    if stereo:
        xs = to_stereo(xm) if x.ndim == 1 else x
        dry[:, : xs.shape[1]] = xs
        return dry + wet * np.stack(wets)
    dry[: len(xm)] = xm
    return dry + wet * wets[0]


def vinyl(dur, seed=5, amount=1.0, stereo=True):
    """Crujido de vinilo + soplido."""
    r = rng(seed)
    n = int(dur * SR)
    out = []
    for c in range(2 if stereo else 1):
        hiss = butter(r.normal(0, 1, n), 'bandpass', [400, 7000]) * 0.012
        pops = np.zeros(n)
        idx = r.integers(0, n, int(dur * 18))
        pops[idx] = r.uniform(-1, 1, len(idx)) * r.uniform(0.1, 0.9, len(idx))
        pops = butter(pops, 'highpass', 900) * 1.5
        crackle = np.zeros(n)
        idx2 = r.integers(0, n, int(dur * 380))
        crackle[idx2] = r.uniform(-1, 1, len(idx2)) * 0.12
        crackle = butter(crackle, 'bandpass', [1500, 9000])
        rumble = butter(r.normal(0, 1, n), 'lowpass', 60) * 0.02
        out.append((hiss + pops + crackle + rumble) * amount)
    return np.stack(out) if stereo else out[0]


def lofi(x, bits=10, down=2, lp=4500, sat=0.25, wobble=0.0, seed=4):
    """Cadena lofi: saturación de cinta, menos agudos, menos bits, algo de wow."""
    y = drive(x, sat)
    if wobble > 0:
        n = y.shape[-1]
        t = np.arange(n) / SR
        dev = wobble * 0.0018 * np.sin(2 * np.pi * 0.7 * t) + wobble * 0.0003 * np.sin(2 * np.pi * 6.1 * t)
        idx = np.clip(np.arange(n) - dev * SR, 0, n - 1)
        if y.ndim == 1:
            y = np.interp(idx, np.arange(n), y)
        else:
            y = np.stack([np.interp(idx, np.arange(n), ch) for ch in y])
    y = bitcrush(y, bits, down)
    y = butter(y, 'lowpass', lp, order=2)
    y = butter(y, 'highpass', 30)
    return y


def fade(x, fin=0.0005, fout=0.01):
    x = np.array(x, dtype=np.float64)
    n = x.shape[-1]
    a, b = int(fin * SR), int(fout * SR)
    if a > 1:
        x[..., :a] *= np.linspace(0, 1, a)
    if b > 1 and b < n:
        x[..., -b:] *= np.linspace(1, 0, b)
    return x


def trim_tail(x, thresh_db=-60):
    """Corta el silencio del final."""
    m = np.abs(x) if x.ndim == 1 else np.abs(x).max(axis=0)
    th = 10 ** (thresh_db / 20) * (m.max() + 1e-12)
    idx = np.where(m > th)[0]
    end = idx[-1] + int(0.01 * SR) if len(idx) else len(m)
    return x[..., :min(end, x.shape[-1])]


def normalize(x, peak_db=-1.0):
    m = np.max(np.abs(x)) + 1e-12
    return x * (10 ** (peak_db / 20) / m)


def mix(*parts):
    n = max(p.shape[-1] for p in parts)
    stereo = any(p.ndim == 2 for p in parts)
    out = np.zeros((2, n)) if stereo else np.zeros(n)
    for p in parts:
        if stereo and p.ndim == 1:
            p = np.stack([p, p])
        out[..., : p.shape[-1]] += p
    return out


def midi_hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)

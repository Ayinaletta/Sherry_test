#!/usr/bin/env python3
"""
voice_to_me.py - 给昀装耳朵

三种用法（原来的两种都保留）:
  python voice_to_me.py                       录音模式（按回车开始，再按回车停止）-> 转录 + 声音特征 -> Telegram
  python voice_to_me.py file.m4a              处理已有音频文件 -> Telegram
  python voice_to_me.py --serve [--port 5050] 起一个 HTTP 服务，新家把莹的语音发过来转录

HTTP 服务:
  POST /transcribe   multipart 音频文件（字段名 file；也接受直接把音频当 body）
                     -> {"text": "...", "desc": "声音亮亮的，语速偏快", "duration": 12.3,
                         "label": "[语音 12.3s|声音亮亮的，语速偏快]", "features": {...}}
  GET  /health       -> {"ok": true, "model": "small", "loaded": true}
  必须带口令: 请求头 `Authorization: Bearer <口令>`（或 `X-Voice-Token`）。
  口令在环境变量 VOICE_TOKEN，或 ~/.voice_to_me_config.json 里的 "service_token"；
  都没有时，第一次 --serve 会随机生成一个、存进配置文件（权限 600）并打印出来。

  对外暴露（新家在 VPS 上，要能访问到这台 Mac）:
      cloudflared tunnel --url http://127.0.0.1:5050        （或 ngrok http 5050）
  然后在 VPS 的 peek_config.json 里写:
      "whisper_url":   "https://<你的隧道地址>/transcribe",
      "whisper_token": "<上面那个口令>"

声音特征和基线（~/.voice_profile.json）只是最近 50 条的统计数字（语速、音高、音量），
不是声纹，认不出人，也不保存音频；每次都拿它们和"你平时"比，所以越用越准。

依赖: pip install faster-whisper librosa soundfile numpy requests ; 系统需要 ffmpeg (brew install ffmpeg)
"""
from __future__ import annotations

import argparse
import hmac
import json
import os
import secrets
import subprocess
import sys
import tempfile
import threading
import time
from email import policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional

CONFIG_FILE = Path.home() / ".voice_to_me_config.json"
PROFILE_FILE = Path.home() / ".voice_profile.json"
MAX_UPLOAD = 25 * 1024 * 1024
FAKE = os.environ.get("VOICE_FAKE") == "1"          # 测试用: 不加载 Whisper，返回固定文字

_profile_lock = threading.Lock()
_model_lock = threading.Lock()                       # 转录吃 CPU，一次只做一个
_model = None
MODEL_NAME = "small"
LANGUAGE = "zh"


# ── 配置 ────────────────────────────────────────────────────────────────────

def read_config() -> dict:
    try:
        return json.loads(CONFIG_FILE.read_text())
    except Exception:
        return {}


def write_config(cfg: dict) -> None:
    CONFIG_FILE.write_text(json.dumps(cfg, indent=2))
    try:
        CONFIG_FILE.chmod(0o600)
    except OSError:
        pass


def load_telegram_config() -> dict:
    """只有 CLI(发 Telegram) 才需要；--serve 不用。"""
    cfg = read_config()
    if cfg.get("token") and cfg.get("chat_id"):
        return cfg
    print("首次配置 Telegram:")
    cfg["token"] = input("  Telegram Bot Token: ").strip()
    cfg["chat_id"] = input("  Chat ID (你的): ").strip()
    write_config(cfg)
    print(f"配置已保存到 {CONFIG_FILE}\n")
    return cfg


def service_token() -> str:
    tok = os.environ.get("VOICE_TOKEN") or read_config().get("service_token")
    if tok:
        return tok
    tok = secrets.token_urlsafe(32)
    cfg = read_config()
    cfg["service_token"] = tok
    write_config(cfg)
    print("\n已生成服务口令（存在 %s，权限 600）:\n  %s\n把它写进 VPS 的 peek_config.json 的 \"whisper_token\"。\n" % (CONFIG_FILE, tok))
    return tok


# ── 录音（CLI） ──────────────────────────────────────────────────────────────

def record_audio(sample_rate: int = 16000) -> str:
    try:
        import sounddevice as sd
    except ImportError:
        print("正在安装 sounddevice...")
        subprocess.run([sys.executable, "-m", "pip", "install", "sounddevice", "soundfile"], check=True)
        import sounddevice as sd
    import numpy as np
    import soundfile as sf

    print("\n按回车开始录音...", end="", flush=True)
    input()
    print("录音中... 按回车停止", end="", flush=True)
    frames = []

    def callback(indata, n_frames, time_info, status):
        frames.append(indata.copy())

    stream = sd.InputStream(samplerate=sample_rate, channels=1, dtype="float32", callback=callback)
    stream.start()
    input()
    stream.stop()
    stream.close()
    if not frames:
        print("没有录到声音。")
        sys.exit(1)
    audio = np.concatenate(frames, axis=0).flatten()
    tmp = tempfile.mktemp(suffix=".wav")
    sf.write(tmp, audio, sample_rate)
    print(f"录音完成 ({len(audio) / sample_rate:.1f}s)\n")
    return tmp


# ── 转录 ────────────────────────────────────────────────────────────────────

class _FakeWord:
    pass


def get_model():
    global _model
    if _model is None:
        try:
            from faster_whisper import WhisperModel
        except ImportError:
            print("正在安装 faster-whisper (首次需要一点时间)...")
            subprocess.run([sys.executable, "-m", "pip", "install", "faster-whisper"], check=True)
            from faster_whisper import WhisperModel
        print(f"加载 Whisper 模型 {MODEL_NAME} ...", flush=True)
        _model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8")
    return _model


def transcribe(audio_path: str, language: Optional[str] = None) -> tuple:
    """返回 (文字, 带时间戳的词列表)"""
    if FAKE:
        return "这是一句测试用的话，今天天气很好。", [_FakeWord() for _ in range(14)]
    with _model_lock:
        model = get_model()
        # initial_prompt 让 Whisper 倾向输出简体中文（不加的话有时会出繁体）
        segments, _info = model.transcribe(
            audio_path, language=language or LANGUAGE, word_timestamps=True,
            initial_prompt="以下是普通话的句子。" if (language or LANGUAGE) == "zh" else None,
        )
        segments = list(segments)
    text = "".join(s.text for s in segments).strip()
    words = []
    for seg in segments:
        if getattr(seg, "words", None):
            words.extend(seg.words)
    return text, words


# ── 声音特征分析 ─────────────────────────────────────────────────────────────

def analyze_audio(audio_path: str, words: list) -> dict:
    try:
        import librosa
    except ImportError:
        print("正在安装 librosa...")
        subprocess.run([sys.executable, "-m", "pip", "install", "librosa"], check=True)
        import librosa
    import numpy as np

    y, sr = librosa.load(audio_path, sr=16000, mono=True, duration=120)
    duration = len(y) / sr

    # 语速（词/秒，基于 word 时间戳）
    speech_rate = len(words) / duration if duration > 0 and words else 0

    # 音调（F0 中位数 Hz，排除无声段）
    f0, voiced_flag, _probs = librosa.pyin(y, fmin=50, fmax=500, sr=sr, frame_length=2048, hop_length=512)
    f0_voiced = f0[voiced_flag == 1] if voiced_flag is not None else np.array([])
    f0_voiced = f0_voiced[~np.isnan(f0_voiced)] if len(f0_voiced) else f0_voiced
    mean_pitch = float(np.median(f0_voiced)) if len(f0_voiced) > 0 else 0
    pitch_std = float(np.std(f0_voiced)) if len(f0_voiced) > 0 else 0

    # 音量（RMS 能量）与停顿比例
    rms = librosa.feature.rms(y=y)[0]
    mean_rms = float(np.mean(rms))
    silence_ratio = float(np.mean(rms < 0.01))

    return {
        "duration": round(duration, 1),
        "speech_rate": round(speech_rate, 2),
        "mean_pitch": round(mean_pitch, 1),
        "pitch_std": round(pitch_std, 1),
        "mean_rms": round(mean_rms, 4),
        "silence_ratio": round(silence_ratio, 2),
    }


# ── 基线（统计数字，不是声纹） ───────────────────────────────────────────────

def load_profile() -> dict:
    if PROFILE_FILE.exists():
        try:
            return json.loads(PROFILE_FILE.read_text())
        except Exception:
            pass
    return {"samples": [], "count": 0}


def update_profile(profile: dict, features: dict) -> dict:
    keys = ["speech_rate", "mean_pitch", "pitch_std", "mean_rms"]
    profile["samples"].append({k: features[k] for k in keys})
    profile["samples"] = profile["samples"][-50:]            # 保留最近 50 条
    profile["count"] = profile.get("count", 0) + 1
    PROFILE_FILE.write_text(json.dumps(profile, indent=2))
    try:
        PROFILE_FILE.chmod(0o600)
    except OSError:
        pass
    return profile


def get_baseline(profile: dict, key: str) -> Optional[float]:
    samples = profile.get("samples", [])
    if len(samples) < 8:
        return None
    vals = [s[key] for s in samples[:-1] if key in s]       # 不含当前这条
    return sum(vals) / len(vals) if vals else None


# ── 描述生成 ─────────────────────────────────────────────────────────────────

def describe(features: dict, profile: dict) -> str:
    parts = []
    count = profile.get("count", 0)

    rate = features["speech_rate"]
    baseline_rate = get_baseline(profile, "speech_rate")
    if baseline_rate is None or count < 8:
        if rate > 4.0:
            parts.append("语速偏快")
        elif rate < 1.5:
            parts.append("语速慢慢的")
        else:
            parts.append("语速平稳")
    else:
        ratio = rate / baseline_rate if baseline_rate > 0 else 1
        if ratio > 1.25:
            parts.append("比你平时说得快")
        elif ratio < 0.75:
            parts.append("比你平时慢")

    pitch = features["mean_pitch"]
    baseline_pitch = get_baseline(profile, "mean_pitch")
    if pitch > 0:
        if baseline_pitch is None or count < 8:
            if pitch > 220:
                parts.append("声音亮亮的")
            elif pitch < 160:
                parts.append("声音低沉")
            else:
                parts.append("声音平和")
        else:
            ratio = pitch / baseline_pitch if baseline_pitch > 0 else 1
            if ratio > 1.1:
                parts.append("声音比平时亮")
            elif ratio < 0.9:
                parts.append("声音比平时低")

    pstd = features["pitch_std"]
    baseline_pstd = get_baseline(profile, "pitch_std")
    if pstd > 0:
        if baseline_pstd is None or count < 8:
            if pstd > 40:
                parts.append("语调起伏挺大")
            elif pstd < 15:
                parts.append("语调平平的")
        else:
            ratio = pstd / baseline_pstd if baseline_pstd > 0 else 1
            if ratio > 1.3:
                parts.append("语调比平时起伏大")
            elif ratio < 0.7:
                parts.append("语调比平时平")

    if features["silence_ratio"] > 0.4:
        parts.append("中间有停顿")

    return "，".join(parts) if parts else "声音平稳"


# ── 一条音频的完整处理（CLI 和 HTTP 共用） ────────────────────────────────────

def to_wav(src: str) -> str:
    """任何格式(webm/m4a/ogg/mp3...) -> 16k 单声道 wav。"""
    out = tempfile.mktemp(suffix=".wav")
    r = subprocess.run(["ffmpeg", "-i", src, "-ar", "16000", "-ac", "1", out, "-y", "-loglevel", "error"],
                       capture_output=True)
    if r.returncode != 0 or not os.path.exists(out):
        raise RuntimeError("ffmpeg 转码失败: " + r.stderr.decode("utf8", "ignore")[:200])
    return out


def process(wav_path: str, language: Optional[str] = None) -> dict:
    text, words = transcribe(wav_path, language)
    features = analyze_audio(wav_path, words)
    desc = ""
    # 基线只用"真的在说话"的样本更新: 一秒钟的噪音或空录音不该把"你平时"带偏
    with _profile_lock:
        profile = load_profile()
        if text and features["duration"] >= 2:
            profile = update_profile(profile, features)
        desc = describe(features, profile)
    label = f"[语音 {features['duration']}s|{desc}]"
    return {"text": text, "desc": desc, "duration": features["duration"], "label": label, "features": features}


# ── Telegram（CLI 模式，保持原样） ────────────────────────────────────────────

def send_to_telegram(text: str, config: dict) -> None:
    import requests
    resp = requests.post(f"https://api.telegram.org/bot{config['token']}/sendMessage",
                         json={"chat_id": config["chat_id"], "text": text})
    print("已发送" if resp.status_code == 200 else f"发送失败: {resp.text}")


def run_cli(argv: list) -> None:
    config = load_telegram_config()
    cleanup = []
    if argv:
        audio = argv[0]
        if not audio.endswith(".wav"):
            audio = to_wav(audio)
            cleanup.append(audio)
    else:
        audio = record_audio()
        cleanup.append(audio)
    try:
        result = process(audio)
    finally:
        for f in cleanup:
            if os.path.exists(f):
                os.unlink(f)
    message = f"{result['label']} {result['text']}"
    print(f"\n消息预览:\n{message}\n")
    send_to_telegram(message, config)


# ── HTTP 服务 ────────────────────────────────────────────────────────────────

def parse_upload(headers, body: bytes) -> tuple:
    """返回 (音频字节, 文件名后缀, language)。接受 multipart(字段 file)，或直接把音频当 body。"""
    ctype = headers.get("Content-Type", "")
    if ctype.lower().startswith("multipart/form-data"):
        msg = BytesParser(policy=policy.default).parsebytes(b"Content-Type: " + ctype.encode() + b"\r\n\r\n" + body)
        audio, ext, language = None, ".bin", None
        for part in msg.iter_parts():
            name = part.get_param("name", header="content-disposition")
            if name == "file" or (audio is None and part.get_filename()):
                audio = part.get_payload(decode=True)
                fn = part.get_filename() or ""
                ext = os.path.splitext(fn)[1] or ".bin"
            elif name == "language":
                language = (part.get_payload(decode=True) or b"").decode("utf8", "ignore").strip() or None
        return audio, ext, language
    ext = {"audio/webm": ".webm", "audio/mp4": ".m4a", "audio/x-m4a": ".m4a", "audio/ogg": ".ogg",
           "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav"}.get(ctype.split(";")[0].strip(), ".bin")
    return body, ext, None


class Handler(BaseHTTPRequestHandler):
    server_version = "voice_to_me"
    token = ""

    def log_message(self, fmt, *args):                       # 不记录内容，只记录发生了一次请求
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))

    def _json(self, code: int, obj: dict) -> None:
        data = json.dumps(obj, ensure_ascii=False).encode("utf8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _authorized(self) -> bool:
        got = self.headers.get("X-Voice-Token") or ""
        auth = self.headers.get("Authorization") or ""
        if auth.lower().startswith("bearer "):
            got = auth[7:].strip()
        return bool(self.token) and hmac.compare_digest(got.encode(), self.token.encode())

    def do_GET(self):
        if self.path == "/health":
            if not self._authorized():
                return self._json(401, {"error": "unauthorized"})
            return self._json(200, {"ok": True, "model": MODEL_NAME, "loaded": FAKE or _model is not None, "fake": FAKE})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path.split("?")[0] != "/transcribe":
            return self._json(404, {"error": "not found"})
        if not self._authorized():
            return self._json(401, {"error": "unauthorized"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n <= 0 or n > MAX_UPLOAD:
            return self._json(413 if n > MAX_UPLOAD else 400, {"error": "bad size"})
        body = self.rfile.read(n)
        src = wav = None
        try:
            audio, ext, language = parse_upload(self.headers, body)
            if not audio or len(audio) < 100:
                return self._json(400, {"error": "no audio in the request"})
            fd, src = tempfile.mkstemp(suffix=ext)
            with os.fdopen(fd, "wb") as f:
                f.write(audio)
            wav = to_wav(src)
            t0 = time.time()
            result = process(wav, language)
            result["took_s"] = round(time.time() - t0, 1)
            self._json(200, result)
        except Exception as e:                               # noqa: BLE001
            self._json(500, {"error": str(e)[:300]})
        finally:
            for f in (src, wav):
                if f and os.path.exists(f):
                    os.unlink(f)


def run_server(host: str, port: int) -> None:
    Handler.token = service_token()
    if not FAKE:
        get_model()                                           # 启动时加载一次，之后每个请求直接用
    srv = ThreadingHTTPServer((host, port), Handler)
    print(f"voice_to_me 服务已启动: http://{host}:{port}/transcribe  （要带口令）", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


def main() -> None:
    global MODEL_NAME, LANGUAGE
    ap = argparse.ArgumentParser(description="给昀装耳朵")
    ap.add_argument("file", nargs="?", help="已有的音频文件（不给就录音）")
    ap.add_argument("--serve", action="store_true", help="起 HTTP 服务")
    ap.add_argument("--host", default="127.0.0.1", help="监听地址（默认只监听本机，用隧道对外）")
    ap.add_argument("--port", type=int, default=5050)
    ap.add_argument("--model", default=MODEL_NAME, help="faster-whisper 模型: tiny/base/small/medium")
    ap.add_argument("--language", default=LANGUAGE, help="默认语言，请求里可以覆盖")
    args = ap.parse_args()
    MODEL_NAME, LANGUAGE = args.model, args.language
    if args.serve:
        run_server(args.host, args.port)
    else:
        run_cli([args.file] if args.file else [])


if __name__ == "__main__":
    main()

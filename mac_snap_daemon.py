#!/usr/bin/env python3
"""
mac_snap_daemon.py
后台监听快照信号，用Mac摄像头拍照上传。
依赖: pip3 install opencv-python requests
用法: python3 mac_snap_daemon.py
开机自启: 加到 Login Items 或用 launchd
"""
import cv2
import requests
import time
import sys
import os

SERVER = "https://home.279415.xyz"


def _load_secret():
    """The shared secret is NOT in this file (this file is downloadable). Put it in the SNAP_SECRET
    environment variable, or in ~/.home_snap_secret (chmod 600). tools/rotate_secret.sh on the server
    prints the exact line to use."""
    s = os.environ.get("SNAP_SECRET", "").strip()
    if not s:
        p = os.path.expanduser("~/.home_snap_secret")
        if os.path.exists(p):
            s = open(p).read().strip()
    if not s:
        sys.exit("缺少口令：设置环境变量 SNAP_SECRET，或把口令写进 ~/.home_snap_secret")
    return s


SECRET = _load_secret()
SSE_URL = f"{SERVER}/api/snap/stream?secret={SECRET}"
UPLOAD_URL = f"{SERVER}/api/snap/upload?secret={SECRET}"


def capture_frame():
    """返回 JPEG bytes，优先用 imagesnap，其次用 opencv"""
    import subprocess, shutil, tempfile, os
    if shutil.which('imagesnap'):
        tmp = tempfile.mktemp(suffix='.jpg')
        try:
            subprocess.run(['imagesnap', '-w', '0.5', tmp], check=True,
                           capture_output=True, timeout=10)
            with open(tmp, 'rb') as f:
                return f.read()
        except Exception as e:
            print(f"[snap] imagesnap失败: {e}", flush=True)
        finally:
            if os.path.exists(tmp): os.remove(tmp)
    # fallback: opencv — try indices 1,2,0 to skip Continuity Camera (iPhone often takes index 0)
    for idx in [1, 2, 0]:
        cap = cv2.VideoCapture(idx)
        if not cap.isOpened():
            cap.release()
            continue
        for _ in range(3):
            cap.read()
        ret, frame = cap.read()
        cap.release()
        if ret:
            _, buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 88])
            print(f"[snap] 用摄像头 index={idx}", flush=True)
            return buf.tobytes()
    print("[snap] 没找到可用摄像头", flush=True)
    return None


def capture_and_upload():
    data = capture_frame()
    if not data:
        return
    try:
        resp = requests.post(
            UPLOAD_URL,
            data=data,
            headers={'Content-Type': 'image/jpeg'},
            timeout=15
        )
        print(f"[snap] 上传完成 {resp.status_code}", flush=True)
    except Exception as e:
        print(f"[snap] 上传失败: {e}", flush=True)


def listen():
    while True:
        try:
            print("[snap] 连接服务器...", flush=True)
            with requests.get(SSE_URL, stream=True, timeout=None) as resp:
                print("[snap] 已连接，等待快照信号", flush=True)
                for raw in resp.iter_lines():
                    if raw and raw.startswith(b'data:'):
                        payload = raw[5:].strip()
                        if payload:
                            print(f"[snap] 收到信号，拍照中...", flush=True)
                            capture_and_upload()
        except KeyboardInterrupt:
            print("\n[snap] 退出", flush=True)
            sys.exit(0)
        except Exception as e:
            print(f"[snap] 连接断开: {e}，5秒后重连...", flush=True)
            time.sleep(5)


if __name__ == '__main__':
    listen()

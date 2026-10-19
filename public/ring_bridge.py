#!/usr/bin/env python3
"""
ring_bridge.py — Colmi R12 BLE bridge
Based on https://github.com/JakobLeander/colmi-ring (R12-specific, MIT)

Usage:
  python3 ring_bridge.py --address <BLE_UUID_OR_MAC>
  python3 ring_bridge.py  # scans for COLMI R12 automatically

HTTP API on :5100
  GET /status       → {connected, battery, heart_rate, steps, last_update}
  GET /battery      → {battery: int}
  GET /heart_rate   → {heart_rate: int, ts: str}  (waits up to 15s)
  GET /vibrate      → {ok: true}  (triggers find-device buzz)
  GET /raw_start    → start accelerometer streaming
  GET /raw_stop     → stop streaming
"""
import asyncio
import json
import struct
import sys
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer

from bleak import BleakClient, BleakScanner

# ── UUIDs (confirmed for Colmi R12, JakobLeander/colmi-ring) ──────────────
RXTX_SERVICE       = "6e40fff0-b5a3-f393-e0a9-e50e24dcca9e"
RXTX_WRITE         = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
RXTX_NOTIFY        = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"

MAIN_SERVICE       = "de5bf728-d711-4e47-af26-65e3012a5dc7"
MAIN_WRITE         = "de5bf72a-d711-4e47-af26-65e3012a5dc7"
MAIN_NOTIFY        = "de5bf729-d711-4e47-af26-65e3012a5dc7"

TARGET_NAME = "COLMI R12"

# ── Command builder ─────────────────────────────────────────────────────────
def cmd(hex_str: str) -> bytes:
    b = [int(hex_str[i:i+2], 16) for i in range(0, len(hex_str), 2)]
    b += [0] * (15 - len(b))
    b.append(sum(b) & 0xFF)
    return bytes(b)

CMD_BATTERY        = cmd("03")
CMD_MANUAL_HR      = cmd("6901")      # request one HR reading
CMD_ENABLE_RAW     = cmd("a104")      # start accelerometer stream (1 Hz)
CMD_DISABLE_RAW    = cmd("a105")
CMD_FIND_DEVICE    = cmd("5001")      # vibrate
CMD_SET_METRICS    = cmd("0a0200")

# ── Shared state ─────────────────────────────────────────────────────────────
state = {
    "connected": False,
    "battery": None,
    "heart_rate": None,
    "steps": None,
    "accel": None,
    "last_update": None,
}
_client = [None]
_loop   = [None]
_hr_event = threading.Event()


# ── Notification handler ─────────────────────────────────────────────────────
def on_notify(_, data: bytearray):
    ptype = data[0]
    psub  = data[1] if len(data) > 1 else 0

    if ptype == 0x03:
        state["battery"] = psub
        print(f"[ring] battery={psub}%")

    elif ptype == 0x69:
        hr = psub
        if hr > 0:
            state["heart_rate"] = hr
            state["last_update"] = datetime.now(timezone.utc).isoformat()
            print(f"[ring] hr={hr}")
            _hr_event.set()

    elif ptype == 0xA1 and psub == 0x03:
        x, y, z = struct.unpack(">hhh", bytes(data[2:8]))
        state["accel"] = {"x": x, "y": y, "z": z}

    elif ptype == 0x43 and len(data) >= 6:
        steps = struct.unpack_from("<I", bytes(data), 2)[0]
        state["steps"] = steps
        print(f"[ring] steps={steps}")


# ── BLE loop ─────────────────────────────────────────────────────────────────
async def _send(b: bytes):
    cl = _client[0]
    if cl and cl.is_connected:
        await cl.write_gatt_char(RXTX_WRITE, b)


async def ble_main(address: str):
    _loop[0] = asyncio.get_event_loop()
    async with BleakClient(address, timeout=30.0) as cl:
        _client[0] = cl
        state["connected"] = True
        print(f"[ring] connected → {address}")

        await cl.start_notify(RXTX_NOTIFY, on_notify)
        await cl.start_notify(MAIN_NOTIFY, on_notify)
        await asyncio.sleep(1)

        await _send(CMD_SET_METRICS)
        await _send(CMD_BATTERY)
        print("[ring] ready")

        while cl.is_connected:
            await asyncio.sleep(5)

    state["connected"] = False
    _client[0] = None
    print("[ring] disconnected")


async def scan_for_ring() -> str:
    print(f"[ring] scanning for '{TARGET_NAME}' (30s)...")
    devs = await BleakScanner.discover(timeout=30.0)
    for d in devs:
        if d.name and TARGET_NAME in d.name:
            print(f"[ring] found: {d.name} @ {d.address}")
            return d.address
    return None


# ── HTTP API ─────────────────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def send_json(self, data, code=200):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", len(body))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        lp = _loop[0]

        if self.path == "/status":
            self.send_json(state)

        elif self.path == "/battery":
            if lp:
                asyncio.run_coroutine_threadsafe(_send(CMD_BATTERY), lp).result(5)
                import time; time.sleep(1)
            self.send_json({"battery": state["battery"]})

        elif self.path == "/heart_rate":
            _hr_event.clear()
            if lp:
                asyncio.run_coroutine_threadsafe(_send(CMD_MANUAL_HR), lp).result(5)
                _hr_event.wait(timeout=15)
            self.send_json({"heart_rate": state["heart_rate"], "ts": state["last_update"]})

        elif self.path == "/vibrate":
            if lp:
                asyncio.run_coroutine_threadsafe(_send(CMD_FIND_DEVICE), lp).result(5)
            self.send_json({"ok": True})

        elif self.path == "/raw_start":
            if lp:
                asyncio.run_coroutine_threadsafe(_send(CMD_ENABLE_RAW), lp).result(5)
            self.send_json({"ok": True})

        elif self.path == "/raw_stop":
            if lp:
                asyncio.run_coroutine_threadsafe(_send(CMD_DISABLE_RAW), lp).result(5)
            self.send_json({"ok": True})

        elif self.path == "/accel":
            self.send_json({"accel": state["accel"]})

        else:
            self.send_json({"error": "not found"}, 404)

    def do_POST(self): self.do_GET()


def run_http(port=5100):
    srv = HTTPServer(("127.0.0.1", port), Handler)
    print(f"[bridge] HTTP on :{port}")
    srv.serve_forever()


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    address = None
    if "--address" in sys.argv:
        address = sys.argv[sys.argv.index("--address") + 1]

    threading.Thread(target=run_http, daemon=True).start()

    async def main():
        addr = address or await scan_for_ring()
        if not addr:
            print("[bridge] ring not found — pass --address <UUID>")
            sys.exit(1)
        while True:
            try:
                await ble_main(addr)
            except Exception as e:
                print(f"[bridge] error: {e} — reconnecting in 5s")
                await asyncio.sleep(5)

    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[bridge] stopped")

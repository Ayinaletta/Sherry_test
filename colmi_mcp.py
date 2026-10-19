#!/usr/bin/env python3
"""COLMI R12 MCP Server — patched for mcp 2.x"""
import asyncio
import os
from mcp.server.mcpserver import MCPServer as FastMCP
from bleak import BleakClient, BleakError

RING_ADDRESS = os.environ.get("COLMI_RING_ADDRESS", "")
RXTX_WRITE   = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
RXTX_NOTIFY  = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"

def _cmd(hex_str: str) -> bytes:
    b = [int(hex_str[i:i+2], 16) for i in range(0, len(hex_str), 2)]
    b += [0] * (15 - len(b))
    b.append(sum(b) & 0xFF)
    return bytes(b)

CMD_BATTERY   = _cmd("03")
CMD_MANUAL_HR = _cmd("6901")
CMD_VIBRATE   = _cmd("5001")

mcp = FastMCP("colmi-ring")

@mcp.tool()
async def ring_battery() -> dict:
    """Get battery level from Sherry's COLMI R12 ring"""
    if not RING_ADDRESS:
        return {"error": "COLMI_RING_ADDRESS not set"}
    result = {}
    event = asyncio.Event()
    def on_notify(_, data):
        if data[0] == 0x03:
            result["battery_pct"] = data[1]
            result["charging"] = bool(data[2]) if len(data) > 2 else None
            event.set()
    try:
        async with BleakClient(RING_ADDRESS, timeout=15) as cl:
            await cl.start_notify(RXTX_NOTIFY, on_notify)
            await cl.write_gatt_char(RXTX_WRITE, CMD_BATTERY)
            try:
                await asyncio.wait_for(event.wait(), 6.0)
            except asyncio.TimeoutError:
                return {"error": "timeout — ring connected but no response. Try again."}
    except BleakError as e:
        return {"error": f"connection failed: {e}. Close COLMI app on phone, bring ring near Mac, wait 30s and retry"}
    return result

@mcp.tool()
async def ring_heart_rate() -> dict:
    """Read current heart rate from Sherry's COLMI R12 ring (must be on wrist)"""
    if not RING_ADDRESS:
        return {"error": "COLMI_RING_ADDRESS not set"}
    result = {}
    event = asyncio.Event()
    def on_notify(_, data):
        if data[0] == 0x69 and len(data) > 1 and data[1] > 0:
            result["heart_rate"] = data[1]
            event.set()
    try:
        async with BleakClient(RING_ADDRESS, timeout=15) as cl:
            await cl.start_notify(RXTX_NOTIFY, on_notify)
            await cl.write_gatt_char(RXTX_WRITE, CMD_MANUAL_HR)
            try:
                await asyncio.wait_for(event.wait(), 20.0)
            except asyncio.TimeoutError:
                return {"error": "timeout — is the ring on your wrist?"}
    except BleakError as e:
        return {"error": f"connection failed: {e}. Close COLMI app on phone, bring ring near Mac, wait 30s and retry"}
    return result

@mcp.tool()
async def ring_vibrate() -> dict:
    """Vibrate Sherry's ring"""
    if not RING_ADDRESS:
        return {"error": "COLMI_RING_ADDRESS not set"}
    try:
        async with BleakClient(RING_ADDRESS, timeout=15) as cl:
            await cl.write_gatt_char(RXTX_WRITE, CMD_VIBRATE)
    except BleakError as e:
        return {"error": f"connection failed: {e}"}
    return {"ok": True}

if __name__ == "__main__":
    mcp.run()

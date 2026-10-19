#!/usr/bin/env python3
"""Write a message into the chat log. Usage: python3 chat_push.py "message text" """
import json, sys, time, pathlib

CHAT_LOG = pathlib.Path(__file__).parent / "chat_messages.jsonl"

def push(text: str, from_: str = "claude"):
    entry = {"id": int(time.time() * 1000), "from": from_, "text": text.strip(), "ts": __import__("datetime").datetime.utcnow().isoformat() + "Z"}
    with open(CHAT_LOG, "a") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    print(f"pushed: {entry['id']}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: chat_push.py <message> [from]")
        sys.exit(1)
    from_ = sys.argv[2] if len(sys.argv) > 2 else "claude"
    push(sys.argv[1], from_=from_)

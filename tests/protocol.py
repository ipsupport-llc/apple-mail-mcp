#!/usr/bin/env python3
"""Protocol tests: run the real server over stdio and check JSON-RPC / MCP behaviour.

Run:  python3 tests/protocol.py
Only protocol paths are exercised; no request here reaches Mail, Calendar or Notes.
"""
import json
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER = os.path.join(ROOT, "server", "apple-mail-mcp.js")
failures = []


def run(lines, env=None, timeout=20):
    """Feed lines (str or dict), close stdin, return (responses, seconds). Fails if the server does not exit."""
    data = "".join((l if isinstance(l, str) else json.dumps(l)) + "\n" for l in lines)
    t = time.time()
    try:
        p = subprocess.run(["/usr/bin/osascript", "-l", "JavaScript", SERVER], input=data.encode(), capture_output=True,
                           timeout=timeout, env=dict(os.environ, **(env or {})))
        stdout = p.stdout
    except subprocess.TimeoutExpired as e:  # the server did not exit after stdin closed
        failures.append(f"server did not exit within {timeout}s after EOF")
        stdout = e.stdout or b""
    out = [json.loads(l) for l in stdout.decode().splitlines() if l.strip()]
    return out, time.time() - t


def by_id(out, i):
    return [r for r in out if r.get("id") == i]


def check(name, cond, detail=""):
    if not cond:
        failures.append(f"{name} {detail}")


INIT = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}}

# initialize negotiates; unknown versions get the newest supported one
out, secs = run([INIT, {"jsonrpc": "2.0", "id": 2, "method": "initialize", "params": {"protocolVersion": "not-a-version"}}])
check("initialize echoes a supported version", by_id(out, 1)[0]["result"]["protocolVersion"] == "2025-06-18")
check("initialize falls back to a supported version", by_id(out, 2)[0]["result"]["protocolVersion"] != "not-a-version")
check("initialize has instructions", "instructions" in by_id(out, 1)[0]["result"])
check("exits on EOF", secs < 15, f"took {secs:.1f}s")

# notifications are never answered; responses are ignored
out, _ = run([INIT, {"jsonrpc": "2.0", "method": "ping"}, {"jsonrpc": "2.0", "method": "notifications/initialized"},
              {"jsonrpc": "2.0", "id": 99, "result": {}}, {"jsonrpc": "2.0", "id": 3, "method": "ping"}])
check("notifications get no response", [r.get("id") for r in out] == [1, 3], str(out))

# malformed input: errors, and the server keeps serving
out, _ = run(["{not json", "null", "[1,2]", '{"jsonrpc":"2.0","id":{"x":1},"method":"ping"}',
              {"jsonrpc": "2.0", "id": "toString", "method": "ping"}, {"jsonrpc": "2.0", "id": 7, "method": "ping"}])
codes = [r.get("error", {}).get("code") for r in out if "error" in r]
check("parse error -32700", -32700 in codes, str(out))
check("invalid request -32600", codes.count(-32600) == 3, str(codes))
check("id 'toString' is served", by_id(out, "toString") and "result" in by_id(out, "toString")[0], str(out))
check("still serving after bad input", by_id(out, 7) and "result" in by_id(out, 7)[0])

# unknown method
out, _ = run([{"jsonrpc": "2.0", "id": 4, "method": "nope"}])
check("unknown method -32601", out and out[0].get("error", {}).get("code") == -32601)

# a request cancelled before it starts is never run or answered; a stale cancel does not hit a later request
out, _ = run([INIT, {"jsonrpc": "2.0", "id": 5, "method": "tools/list"},
              {"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "read", "arguments": {"action": "send_email"}}},
              {"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 6}},
              {"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 8}},
              {"jsonrpc": "2.0", "id": 8, "method": "ping"}])
check("cancelled queued request gets no response", not by_id(out, 6), str(out))
check("stale cancel does not drop a later request", by_id(out, 8), str(out))

# tool errors are isError results with a hint, not JSON-RPC errors
out, _ = run([INIT, {"jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": {"name": "read", "arguments": {"action": "send_email", "args": {}}}}])
r = by_id(out, 9)[0]["result"]
check("write action via read is an isError result", r.get("isError") and "write tool" in r["content"][0]["text"], str(r))

# tools/list: two tools with RIGHT/WRONG examples; read-only mode hides write and refuses it
out, _ = run([INIT, {"jsonrpc": "2.0", "id": 10, "method": "tools/list"}])
tools = by_id(out, 10)[0]["result"]["tools"]
check("two tools", [t["name"] for t in tools] == ["read", "write"])
check("description has RIGHT/WRONG", all("RIGHT:" in t["description"] and "WRONG:" in t["description"] for t in tools))
out, _ = run([INIT, {"jsonrpc": "2.0", "id": 11, "method": "tools/list"},
              {"jsonrpc": "2.0", "id": 12, "method": "tools/call", "params": {"name": "write", "arguments": {"action": "send_email", "args": {}}}}],
             env={"APPLE_MAIL_READ_ONLY": "true"})
check("read-only hides write", [t["name"] for t in by_id(out, 11)[0]["result"]["tools"]] == ["read"])
check("read-only refuses write", "Read-only" in by_id(out, 12)[0]["result"]["content"][0]["text"])

# stdin from a regular file (not a pipe) also ends cleanly
path = os.path.join(os.environ.get("TMPDIR", "/tmp"), "apple-mail-mcp-proto.jsonl")
with open(path, "w") as f:
    f.write(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "ping"}) + "\n")
t = time.time()
with open(path) as f:
    try:
        p = subprocess.run(["/usr/bin/osascript", "-l", "JavaScript", SERVER], stdin=f, capture_output=True, timeout=20)
        check("exits when stdin is a file", b'"id":1' in p.stdout)
    except subprocess.TimeoutExpired:
        check("exits when stdin is a file", False, "timed out")
os.remove(path)

if failures:
    print("FAILED:\n  " + "\n  ".join(failures))
    sys.exit(1)
print("protocol: all checks passed")

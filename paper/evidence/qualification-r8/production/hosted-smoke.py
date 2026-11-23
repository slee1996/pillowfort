"""Production smoke: use one disposable, self-issued participant; never serialize its secrets."""
import json, sys, time
from pathlib import Path
from urllib.request import Request, urlopen

origin = "https://mcp.pillowfort.xyz"
revision = "2026-07-28"
meta = {"io.modelcontextprotocol/protocolVersion": revision, "io.modelcontextprotocol/clientInfo": {"name": "pillowfort-qualification", "version": "8"}, "io.modelcontextprotocol/clientCapabilities": {}}
report = {"scope": "Ordinary private hosted room; no induced failures or third-party participants."}
access = handle = room = None
seq = 0

def request(path, method="GET", body=None, headers=None):
    h = {"Accept": "application/json, text/event-stream", "User-Agent": "Pillowfort-Qualification/8"}
    if body is not None: h["Content-Type"] = "application/json"
    h.update(headers or {})
    with urlopen(Request(origin+path, data=json.dumps(body).encode() if body is not None else None, headers=h, method=method), timeout=20) as response:
        data = response.read()
        return response.status, json.loads(data) if data else None

def rpc(method, params=None, auth=False):
    global seq
    seq += 1
    p = dict(params or {}, _meta=meta)
    headers = {"Mcp-Method": method, "MCP-Protocol-Version": revision}
    if "name" in p: headers["Mcp-Name"] = p["name"]
    if auth: headers["Authorization"] = "Bearer " + access
    _, response = request("/mcp", "POST", {"jsonrpc": "2.0", "id": seq, "method": method, "params": p}, headers)
    if "result" not in response: raise RuntimeError(f"{method}: {response.get('error',{}).get('code')}")
    return response["result"]

def call(name, args):
    res = rpc("tools/call", {"name":name, "arguments":args}, True)["structuredContent"]
    if not res.get("ok"): raise RuntimeError(f"{name}: {res.get('error',{}).get('code')}")
    return res.get("data")

def observe(predicate):
    until=time.monotonic()+20
    s=call("session_observe", {"session": handle})
    while not predicate(s):
        if time.monotonic()>until: raise RuntimeError("hosted state did not reach expected boundary")
        call("session_wait", {"session":handle, "afterRevision":s["revision"], "timeoutMs":1000})
        s=call("session_observe", {"session":handle})

try:
    pre=request("/preflight")[1]
    assert pre["mcp"]["protocolVersion"] == revision
    report["publicDiscovery"] = rpc("server/discover")["_meta"]["io.modelcontextprotocol/serverInfo"]["name"] == "pillowfort"
    tools=rpc("tools/list")["tools"]
    assert {"session_create", "room_setup", "room_end"} <= {t["name"] for t in tools}
    report["publicTools"] = len(tools)
    if not pre["quota"]["canStartFullSession"]: raise RuntimeError("public participant budget unavailable; no allocation attempted")
    code,data=request("/access", "POST", {"acceptManagedCustody":True}); assert code==201
    access=data["access_token"]; del data
    handle=call("session_create", {})["session"]
    room=call("room_setup", {"session":handle, "input":{"displayName":"Protocol verification", "confirm":True}})["roomId"]
    observe(lambda s:s["connection"]["roomId"]==room and s["connection"]["isHost"] and s["legalActions"]["canAct"])
    report["activeHostObserved"]=True
    call("room_end", {"session":handle, "input":{"roomId":room, "confirm":True}})
    observe(lambda s:s["connection"]["roomId"] is None and s["connection"]["terminalPresentation"]=="room-destroyed")
    report["terminalRetirementObserved"]=True
finally:
    try:
        if handle:
            call("session_close", {"session":handle,"confirm":True}); report["participantClosed"]=True
    finally:
        if access:
            status,_=request("/mcp/access", "DELETE", headers={"Authorization":"Bearer "+access}); report["accessRevoked"]=status in (200,204)
        report["passed"]=all(report.get(k) for k in ["publicDiscovery","activeHostObserved","terminalRetirementObserved","participantClosed","accessRevoked"])
        Path(sys.argv[1]).write_text(json.dumps(report,indent=2)+"\n")
        print(json.dumps(report))

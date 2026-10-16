#!/usr/bin/env python3
"""Protocol regression test for the Sync Stream server (run against a local instance)."""
import json, os, sys, threading, time, urllib.request, urllib.error, urllib.parse

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8080"
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36"}  # Cloudflare 403s python-urllib
ROOM = "testroom"
ok = True

def fail(msg):
    global ok
    ok = False
    print("  FAIL " + msg)

def post(path, obj, headers=None):
    data = json.dumps(obj).encode()
    h = {"content-type": "application/json"}
    h.update(UA)
    if headers:
        h.update(headers)
    req = urllib.request.Request(BASE + path, data=data, headers=h, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())

def get(path):
    with urllib.request.urlopen(urllib.request.Request(BASE + path, headers=UA), timeout=30) as r:
        return json.loads(r.read().decode())

frames = []
stop = threading.Event()

def reader():
    req = urllib.request.Request(BASE + "/api/events?room=" + ROOM, headers=dict(UA, **{"accept": "text/event-stream"}))
    with urllib.request.urlopen(req, timeout=30) as r:
        for line in r:
            if stop.is_set():
                break
            line = line.decode().strip()
            if line.startswith("data:"):
                frames.append(json.loads(line[5:]))

# A password-protected deployment: log in first, then every request below carries the session.
PW = os.environ.get("SYNC_PASSWORD", "")
if PW:
    class _NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None
    body = urllib.parse.urlencode({"password": PW}).encode()
    lreq = urllib.request.Request(BASE + "/login", data=body, method="POST",
                                  headers=dict(UA, **{"content-type": "application/x-www-form-urlencoded"}))
    try:
        urllib.request.build_opener(_NoRedirect).open(lreq, timeout=30)
    except urllib.error.HTTPError as e:
        if e.code not in (302, 303):
            sys.exit("login failed: HTTP %s" % e.code)
        cookie = e.headers.get("Set-Cookie", "").split(";")[0]
        if not cookie:
            sys.exit("login returned no session cookie")
        UA["Cookie"] = cookie
        print("0. logged in with the shared password")

t = threading.Thread(target=reader, daemon=True)
t.start()
time.sleep(3.0)
print("1. SSE connect -> initial frame received:", len(frames) >= 1)
if len(frames) >= 1:
    print("   listeners counted:", frames[-1]["listeners"])

media = get("/api/media")["media"]
print("2. media list has", len(media), "files")
if len(media) < 2:
    fail("need >=2 media files")

video = [m for m in media if m["type"] == "video"][0]
audio = [m for m in media if m["type"] == "audio"][0]

c, r = post("/api/control?room=" + ROOM, {"action": "select", "mediaId": video["id"], "actor": "Tester"})
print("3. select:", c, r)
time.sleep(0.4)
n0 = len(frames)
s = get("/api/state?room=" + ROOM)
print("   push on change:", n0 >= 2, "| mediaId:", s["mediaId"] == video["id"], "| playing:", s["playing"])

def shared_now(room):
    """Shared playhead in ms, computed from the server anchor + this host's clock."""
    st = get("/api/state?room=" + room)
    return st["posMs"] + ((time.time() * 1000 - st["anchor"]) if st["playing"] else 0)

a = shared_now(ROOM)
t_a = time.time()
time.sleep(2.0)
b = shared_now(ROOM)
dt = (time.time() - t_a) * 1000
advance = b - a
print("4. the shared playhead advanced %.0f ms over %.0f ms of real time (expect ~1:1)" % (advance, dt))
if abs(advance - dt) > 150:
    fail("playhead advanced at %.2fx real time" % (advance / dt))

c, r = post("/api/control?room=" + ROOM, {"action": "seek", "posMs": 30000, "actor": "Tester"})
s = get("/api/state?room=" + ROOM)
if s["posMs"] != 30000:
    fail("seek did not land on 0:30")
a = shared_now(ROOM)
t_a = time.time()
print("5. seek to 0:30 -> shared playhead reads %.0f ms, playing %s" % (a, s["playing"]))
if not (30000 <= a <= 30000 + 6000):   # generous: a remote observer adds its own latency
    fail("playhead is not at the seeked position")
time.sleep(1.5)
b = shared_now(ROOM)
dt = (time.time() - t_a) * 1000
print("   playhead kept running: +%.0f ms over %.0f ms of real time" % (b - a, dt))
if abs((b - a) - dt) > 150:
    fail("time stopped or ran at the wrong rate after the seek")

c, r = post("/api/control?room=" + ROOM, {"action": "pause", "actor": "Tester"})
s = get("/api/state?room=" + ROOM)
time.sleep(1.0)
s2 = get("/api/state?room=" + ROOM)
print("6. pause freezes position:", s2["playing"] is False and abs(s2["posMs"] - s["posMs"]) < 50)

c, r = post("/api/control?room=" + ROOM, {"action": "play", "actor": "Tester"})
s = get("/api/state?room=" + ROOM)
print("7. play resumes:", s["playing"] is True)

c, r = post("/api/control?room=" + ROOM, {"action": "meta", "mediaId": video["id"], "durationMs": 60000})
media2 = get("/api/media")["media"]
got = [m for m in media2 if m["id"] == video["id"]][0]["durationMs"]
print("8. duration reported back by a client:", got, "ms")
if got != 60000:
    fail("duration not stored")

c, r = post("/api/control?room=" + ROOM, {"action": "ended", "mediaId": video["id"], "actor": "Tester"})
s = get("/api/state?room=" + ROOM)
print("9. track ended -> auto-advanced to:", s["mediaId"], "(expected the other track)")
if s["mediaId"] != audio["id"]:
    fail("auto-advance wrong")

c, r = post("/api/control?room=" + ROOM, {"action": "seek", "posMs": -5000})
s = get("/api/state?room=" + ROOM)
print("10. negative seek clamped to 0:", s["posMs"] == 0)

c, r = post("/api/control?room=" + ROOM, {"action": "nonsense"})
print("11. unknown action rejected:", c == 400)

# upload path (raw body + X-Filename), then clean up
body = b"ID3\x03\x00\x00\x00" + b"\x00" * 2048
req = urllib.request.Request(BASE + "/upload", data=body, method="POST",
                            headers=dict(UA, **{"X-Filename": "test-upload.mp3", "content-type": "application/octet-stream"}))
with urllib.request.urlopen(req, timeout=15) as r:
    up = json.loads(r.read().decode())
print("12. upload:", up)
if not up.get("ok"):
    fail("upload failed")
names = [m["id"] for m in get("/api/media")["media"]]
print("    appears in playlist:", up["id"] in names)
req = urllib.request.Request(BASE + "/upload", data=b"x", method="POST",
                            headers=dict(UA, **{"X-Filename": "evil.txt"}))
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        print("13. non-media upload rejected: FAIL (accepted)")
        ok = False
except urllib.error.HTTPError as e:
    print("13. non-media upload rejected:", e.code == 400)

# traversal guard
try:
    with urllib.request.urlopen(urllib.request.Request(BASE + "/media/" + urllib.parse.quote("../../etc/passwd"), headers=UA), timeout=30) as r:
        print("14. traversal blocked: FAIL (served)")
        ok = False
except urllib.error.HTTPError as e:
    print("14. traversal blocked:", e.code in (400, 403, 404), "(http %s)" % e.code)

# 16. A room is a station, not a record player: skipping past the end of the current track
#     hands over to the next one instead of stalling at the end of the file.
before = get("/api/state?room=" + ROOM)["mediaId"]
post("/api/control?room=" + ROOM, {"action": "seek", "posMs": 9999000, "actor": "Tester"})
time.sleep(5)
after = get("/api/state?room=" + ROOM)
print("16. seek past the end of the track -> now playing:", after["mediaId"])
if after["mediaId"] == before and after["playing"]:
    fail("station stalled at the end of the track instead of moving on")

stop.set()
print("15. SSE frames received in total:", len(frames))
print("RESULT:", "ALL PASS" if ok else "FAILURES PRESENT")
sys.exit(0 if ok else 1)

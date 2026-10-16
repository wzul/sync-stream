#!/usr/bin/env python3
"""
Extra regression tests for the DJ-talk path and the access gate.

    python3 test_talk.py http://127.0.0.1:18080 <password>     # local
    SYNC_PASSWORD=... python3 test_talk.py https://host        # live

Covers what test_protocol.py does not: the password gate itself, room wide volume, and the
push-to-talk relay (PCM batch -> every listener, with the room marked "talking" so devices duck).
"""
import base64, json, os, struct, sys, threading, time, urllib.error, urllib.parse, urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8080"
PW = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("SYNC_PASSWORD", "")
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36"}
ROOM = "_talktest"
ok = True


def fail(msg):
    global ok
    ok = False
    print("  FAIL " + msg)


def req(path, data=None, headers=None, method=None, cookie=None):
    h = dict(UA)
    if headers:
        h.update(headers)
    if cookie:
        h["Cookie"] = cookie
    r = urllib.request.Request(BASE + path, data=data, headers=h, method=method)

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None

    op = urllib.request.build_opener(NoRedirect)
    try:
        with op.open(r, timeout=30) as resp:
            return resp.status, resp.read(), resp.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers   # Message: header lookup is case-insensitive


def get_json(path, cookie=None):
    st, body, _ = req(path, cookie=cookie)
    return json.loads(body.decode())


def post_json(path, obj, cookie=None):
    st, body, _ = req(path, json.dumps(obj).encode(),
                      {"content-type": "application/json"}, "POST", cookie)
    return st, json.loads(body.decode())


def tone(ms, rate=12000, freq=440):
    n = int(rate * ms / 1000)
    return struct.pack("<%dh" % n, *[int(12000 * __import__("math").sin(2 * 3.14159265 * freq * i / rate)) for i in range(n)])


cookie = None
if PW:
    print("gate: POST /login with the shared word")
    st, body, hdrs = req("/login", urllib.parse.urlencode({"password": PW}).encode(),
                          {"content-type": "application/x-www-form-urlencoded"}, "POST")
    sc = hdrs.get("Set-Cookie", "")
    print("   status", st, "| cookie set:", "ss_auth=" in sc)
    if st not in (302, 303) or "ss_auth=" not in sc:
        fail("login did not hand out a session cookie")
    cookie = sc.split(";")[0]

    print("gate: the page and the API need it, media does not")
    for path, want in (("/", 302), ("/r/main", 302), ("/api/media", 401)):
        st, _, _ = req(path)
        if st != want:
            fail("%s unauthenticated -> %s, want %s" % (path, st, want))
    st, _, _ = req("/api/media", cookie=cookie)
    print("   /api/media with the cookie:", st)
    if st != 200:
        fail("/api/media rejected a valid session")
    st, _, _ = req("/login", urllib.parse.urlencode({"password": "definitely-wrong"}).encode(),
                   {"content-type": "application/x-www-form-urlencoded"}, "POST")
    print("   wrong word rejected:", st == 401)
    if st != 401:
        fail("a wrong password was accepted")

media = get_json("/api/media", cookie)["media"]
print("media library:", len(media), "file(s)")

print("room volume is shared, and does not move the playhead")
post_json("/api/control?room=" + ROOM, {"action": "select", "mediaId": media[0]["id"]}, cookie)
before = get_json("/api/state?room=" + ROOM, cookie)
post_json("/api/control?room=" + ROOM, {"action": "volume", "volume": 0.25, "actor": "Tester"}, cookie)
after = get_json("/api/state?room=" + ROOM, cookie)
print("   volume:", after.get("volume"), "| gen unchanged:", after["gen"] == before["gen"])
if abs(float(after.get("volume", 1)) - 0.25) > 0.001:
    fail("volume was not stored on the room")
if after["gen"] != before["gen"]:
    fail("a volume change bumped gen (would force every listener to seek)")

print("push-to-talk relay")
frames = []
stop = threading.Event()


def reader():
    r = urllib.request.Request(BASE + "/api/events?room=" + ROOM,
                               headers=dict(UA, accept="text/event-stream", Cookie=cookie or ""))
    with urllib.request.urlopen(r, timeout=60) as resp:
        cur = None
        for raw in resp:
            if stop.is_set():
                break
            line = raw.decode().strip()
            if line.startswith("event:"):
                cur = line[6:].strip()
            elif line.startswith("data:"):
                try:
                    frames.append((cur or "state", json.loads(line[5:])))
                except ValueError:
                    pass
                cur = None


threading.Thread(target=reader, daemon=True).start()
time.sleep(2.0)

pcm = tone(340)
st, body, _ = req("/api/talk?room=%s&actor=Wan" % ROOM, pcm,
                  {"content-type": "application/octet-stream", "x-talking": "1", "x-seq": "1"}, "POST", cookie)
print("   POST /api/talk:", st, body.decode()[:60])
if st != 200:
    fail("talk batch rejected")
time.sleep(0.6)
talk = [f for f in frames if f[0] == "talk"]
print("   relayed to listeners:", len(talk) == 1, "| rate:", talk[0][1]["rate"] if talk else None)
if len(talk) != 1:
    fail("the PCM batch was not relayed as a talk event")
else:
    got = base64.b64decode(talk[0][1]["pcm"])
    print("   bytes intact:", got == pcm)
    if got != pcm:
        fail("relayed audio was corrupted")

# poll: a slow remote round trip must not be read as "the room never ducked"
st = None
for _ in range(12):
    st = get_json("/api/state?room=" + ROOM, cookie)
    if st["talking"]:
        break
    time.sleep(0.3)
print("   room marked talking:", st["talking"], "| talker:", st["talker"])
if not st["talking"] or st["talker"] != "Wan":
    fail("room did not report the talker (everyone's music would not duck)")

print("   the talker's own device must NOT receive its own audio back")
# two listeners, one of them is the sender (identified by x-cid)
got = {"A": [], "B": []}


def listener(name, cid):
    r = urllib.request.Request(BASE + "/api/events?room=" + ROOM + "&cid=" + cid,
                               headers=dict(UA, accept="text/event-stream", Cookie=cookie or ""))
    with urllib.request.urlopen(r, timeout=40) as resp:
        cur = None
        for raw in resp:
            if stop.is_set():
                break
            line = raw.decode().strip()
            if line.startswith("event:"):
                cur = line[6:].strip()
            elif line.startswith("data:"):
                if cur == "talk":
                    try:
                        payload = json.loads(line[5:])
                    except ValueError:
                        payload = {}
                    # a talk event without `pcm` is the "someone is already talking" marker sent on
                    # connect — it carries no audio and must not be counted as a relayed batch
                    if "pcm" in payload:
                        got[name].append(payload)
                cur = None


threading.Thread(target=listener, args=("A", "cid-A"), daemon=True).start()
threading.Thread(target=listener, args=("B", "cid-B"), daemon=True).start()
time.sleep(2.0)
req("/api/talk?room=%s&actor=Wan" % ROOM, tone(340, freq=300),
    {"content-type": "application/octet-stream", "x-talking": "1", "x-seq": "2", "x-cid": "cid-A"}, "POST", cookie)
time.sleep(1.5)
print("   sender (cid-A) received:", len(got["A"]), "| other listener (cid-B) received:", len(got["B"]))
if got["A"]:
    fail("the talker's own device got its own voice relayed back (echo)")
if not got["B"]:
    fail("the other listener did not receive the batch")

print("   waiting for the session to expire on its own (no more batches)...")
time.sleep(4)
st = get_json("/api/state?room=" + ROOM, cookie)
print("   after silence -> talking:", st["talking"])
if st["talking"]:
    fail("a dead DJ left every listener ducked")

post_json("/api/control?room=" + ROOM, {"action": "pause"}, cookie)
stop.set()
print("RESULT:", "ALL PASS" if ok else "FAILURES PRESENT")
sys.exit(0 if ok else 1)

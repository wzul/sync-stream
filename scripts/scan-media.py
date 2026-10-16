#!/usr/bin/env python3
"""
Fill in exact media durations with ffprobe.

The server needs each file's length to roll the playlist on by itself when nobody is listening
(a closed browser cannot report "track ended"). Clients report durations too, so this is not
required for correctness — but it makes a whole library exact immediately after a bulk copy.

    MEDIA_DIR=/path/to/media python3 scripts/scan-media.py

Rewrites .syncstream-durations.json in the media dir; the server re-reads that file when its mtime
changes, so a restart is not needed.
"""
import json, os, subprocess, sys

MEDIA = os.environ.get("MEDIA_DIR", "./media")
DUR = os.path.join(MEDIA, ".syncstream-durations.json")
EXTS = {".mp3", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".wav", ".flac",
        ".mp4", ".m4v", ".mov", ".mkv", ".ogv", ".webm"}


def probe(path):
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", path],
            capture_output=True, text=True, timeout=60)
        return int(round(float(out.stdout.strip()) * 1000))
    except Exception as e:
        print("  ! %s: %s" % (os.path.basename(path), e))
        return None


def fmt(ms):
    if not ms:
        return "?"
    s = ms // 1000
    return "%d:%02d" % (s // 60, s % 60)


def main():
    if not os.path.isdir(MEDIA):
        sys.exit("media dir not found: " + MEDIA)
    try:
        known = json.load(open(DUR))
    except Exception:
        known = {}
    files = sorted(f for f in os.listdir(MEDIA)
                   if not f.startswith(".") and os.path.splitext(f)[1].lower() in EXTS)
    added = changed = 0
    for f in files:
        ms = probe(os.path.join(MEDIA, f))
        if ms is None or ms <= 0:
            continue
        old = known.get(f)
        if old is None:
            added += 1
        elif abs(old - ms) > 1500:
            changed += 1
        known[f] = ms
    known = {k: v for k, v in known.items() if k in files}   # drop entries for deleted files
    tmp = DUR + ".tmp"
    json.dump(known, open(tmp, "w"), indent=1, sort_keys=True)
    os.replace(tmp, DUR)
    print("%d files, %d new, %d corrected -> %s" % (len(files), added, changed, DUR))
    for f in files:
        print("  %-44s %s" % (f, fmt(known.get(f))))


if __name__ == "__main__":
    main()

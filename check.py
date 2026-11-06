#!/usr/bin/env python3
"""Fail the run (so the last good deploy stays up) if a core source errored."""
import json, sys
from pathlib import Path

d = json.loads((Path(__file__).parent / "site" / "data.json").read_text())
hard = ["snotel", "models", "nws", "resort", "daily_snow"]
bad = [k for k in hard if not d.get(k) or (isinstance(d[k], dict) and "error" in d[k])]
cams = d.get("cams")
if not isinstance(cams, list) or not any(c.get("img") for c in cams):
    print("WARN  no cameras fetched", file=sys.stderr)
if bad:
    sys.exit(f"core sources failed: {', '.join(bad)}")
print("data ok")

#!/usr/bin/env python3
"""Append one record per Mountain-time day to history/daily.jsonl (first run of the day wins).

Keeps the repo active so GitHub doesn't pause the schedule, and builds a record of
what the models predicted versus what the station measured. Idempotent.
"""
import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).parent
OUT = HERE / "history" / "daily.jsonl"

d = json.loads((HERE / "site" / "data.json").read_text())
today = datetime.now(ZoneInfo("America/Denver")).date().isoformat()
OUT.parent.mkdir(exist_ok=True)
lines = OUT.read_text().splitlines() if OUT.exists() else []
if any(json.loads(x)["date"] == today for x in lines):
    print(f"history: {today} already recorded")
    raise SystemExit(0)

cur = d["snotel"]["current"]
yday = next((x for x in d["daily_snow"]["days"] if x["offset"] == -1), None)
rec = {
    "date": today,
    "pulled_at": d["generated"],
    "snotel": {k: cur.get(k) for k in ("t", "depth_in", "swe_in", "temp_f", "water_year_prec_in")},
    "yesterday_measured_in": {"date": yday["date"], "am": yday["am"]["obs"], "pm": yday["pm"]["obs"]} if yday else None,
    "forecast_daily_snow_in": {
        m["label"]: dict(zip(m["daily_dates"], m["daily_snow_in"]))
        for m in d["models"]["models"].values() if "daily_snow_in" in m},
}
with OUT.open("a") as f:
    f.write(json.dumps(rec, separators=(",", ":")) + "\n")
print(f"history: recorded {today}")

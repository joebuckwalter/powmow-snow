#!/usr/bin/env python3
"""Powder Mountain data pull (prototype). Stdlib only. Writes site/data.json and site/cams/*.

Free, unauthenticated sources only:
  snotel   NRCS report generator CSV, site 1300 (Powder Mountain, ~8,500 ft)
  nws      api.weather.gov gridpoint SLC/108,203 + Area Forecast Discussion + alerts
  models   Open-Meteo, one request per weather model (snowfall, precip, temp)
  resort   powdermountain.com/api/conditions (lifts, trails, roads, daily message,
           OpenSnow-supplied 5-day forecast, webcam list)
  avalanche  Utah Avalanche Center Ogden zone, Avalanche.org public API (no key)
  cams     mountain cams (PrismCam) + UDOT SR-158 cam, saved as image files

All arithmetic (unit conversion, totals, spread) happens here, not in the page.
"""
import csv, io, json, re, statistics, sys, time, urllib.parse, urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path

HERE = Path(__file__).parent
SITE = HERE / "site"
UA = "powmow-snow (+https://github.com/joebuckwalter/powmow-snow)"
LAT, LON = 41.3796, -111.7604          # resort forecast point (from resort API)
ELEV_M = 2446                           # 8,025 ft, same point
NWS_GRID = "SLC/108,203"
SNOTEL = "1300:UT:SNTL"
MODELS = {
    "gfs_seamless": "GFS", "ecmwf_ifs025": "ECMWF IFS", "ecmwf_aifs025_single": "ECMWF AIFS",
    "icon_seamless": "ICON", "gem_seamless": "GEM", "ncep_hrrr_conus": "HRRR",
}
CM_PER_IN = 2.54
MM_PER_IN = 25.4


def get(url, *, binary=False, timeout=30, retries=2):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    err = None
    for i in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                b = r.read()
                return (b, r.headers.get("Content-Type", "")) if binary else b.decode("utf-8", "replace")
        except Exception as e:  # noqa: BLE001
            err = e
            time.sleep(1.5 * (i + 1))
    raise err


def safe(name, fn):
    try:
        out = fn()
        print(f"ok    {name}", file=sys.stderr)
        return out
    except Exception as e:  # noqa: BLE001
        print(f"FAIL  {name}: {e}", file=sys.stderr)
        return {"error": str(e)}


# ---------------------------------------------------------------- SNOTEL
def snotel_csv(mode, rng, elements):
    station = urllib.parse.quote(SNOTEL + '|id=""|name', safe="")
    path = (f"https://wcc.sc.egov.usda.gov/reportGenerator/view_csv/customSingleStationReport/"
            f"{mode}/start_of_period/{station}/{rng}/{elements}")
    text = get(path)
    rows = [l for l in text.splitlines() if l and not l.startswith("#")]
    return list(csv.DictReader(io.StringIO("\n".join(rows))))


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def fetch_snotel():
    hourly_raw = snotel_csv("hourly", "-408,0", "WTEQ::value,SNWD::value,TOBS::value,PREC::value")
    hourly_full = []
    for r in hourly_raw:
        k = list(r.keys())
        hourly_full.append({"t": r[k[0]].replace(" ", "T"), "swe": num(r[k[1]]), "depth": num(r[k[2]]),
                            "temp_f": num(r[k[3]]), "prec": num(r[k[4]])})
    hourly = hourly_full[-169:]  # last 7 days for the line charts; the full 17 days feed the daily strip
    water_year_start = f"{datetime.now().year if datetime.now().month >= 10 else datetime.now().year - 1}-10-01"
    today = datetime.now().strftime("%Y-%m-%d")
    daily_raw = snotel_csv("daily", f"{water_year_start},{today}",
                           "WTEQ::value,SNWD::value,PREC::value,TMAX::value,TMIN::value")
    daily = []
    for r in daily_raw:
        k = list(r.keys())
        daily.append({"d": r[k[0]], "swe": num(r[k[1]]), "depth": num(r[k[2]]), "prec": num(r[k[3]]),
                      "tmax_f": num(r[k[4]]), "tmin_f": num(r[k[5]])})

    # windowed liquid-precip and depth changes computed from the hourly series
    last = next((h for h in reversed(hourly) if h["prec"] is not None), None)

    def at_hours_ago(hrs, key):
        idx = len(hourly) - 1 - hrs
        if idx < 0:
            return None
        for j in range(idx, max(idx - 4, -1), -1):  # tolerate a missing hour
            if hourly[j][key] is not None:
                return hourly[j][key]
        return None

    windows = {}
    for label, hrs in (("24h", 24), ("48h", 48), ("72h", 72), ("7d", 168)):
        p0, d0 = at_hours_ago(hrs, "prec"), at_hours_ago(hrs, "depth")
        cur_d = next((h["depth"] for h in reversed(hourly) if h["depth"] is not None), None)
        windows[label] = {
            "liquid_in": round(last["prec"] - p0, 2) if last and p0 is not None else None,
            "depth_change_in": round(cur_d - d0, 1) if cur_d is not None and d0 is not None else None,
        }
    cur = next((h for h in reversed(hourly) if h["temp_f"] is not None), hourly[-1])
    return {
        "station": {"name": "Powder Mountain SNOTEL", "triplet": SNOTEL, "elev_ft": 8490,
                    "note": "Air temperature has a documented sensor bias (NRCS). Times are station local."},
        "current": {"t": cur["t"], "temp_f": cur["temp_f"],
                    "depth_in": next((h["depth"] for h in reversed(hourly) if h["depth"] is not None), None),
                    "swe_in": next((h["swe"] for h in reversed(hourly) if h["swe"] is not None), None),
                    "water_year_prec_in": last["prec"] if last else None},
        "windows": windows, "hourly": hourly, "daily": daily, "water_year_start": water_year_start,
        "_full": hourly_full,
    }


# ------------------------------------------------------------------- NWS
def nws_json(path):
    return json.loads(get("https://api.weather.gov" + path))


def expand_series(values):
    """NWS gridpoint series -> list of (datetime_utc, value). Handles ISO durations like PT3H."""
    out = []
    for v in values:
        start, dur = v["validTime"].split("/")
        t0 = datetime.fromisoformat(start.replace("Z", "+00:00"))
        m = re.match(r"P(?:(\d+)D)?T?(?:(\d+)H)?", dur)
        hrs = int(m.group(1) or 0) * 24 + int(m.group(2) or 0) or 1
        for h in range(hrs):
            out.append((t0 + timedelta(hours=h), v["value"], hrs))
    return out


def fetch_nws():
    grid = nws_json(f"/gridpoints/{NWS_GRID}")["properties"]
    snow_mm = grid["snowfallAmount"]["values"]  # mm per validTime window
    snow_in_hourly = {}
    for v in snow_mm:
        if v["value"] is None:
            continue
        start, dur = v["validTime"].split("/")
        t0 = datetime.fromisoformat(start.replace("Z", "+00:00"))
        m = re.match(r"P(?:(\d+)D)?T?(?:(\d+)H)?", dur)
        hrs = (int(m.group(1) or 0) * 24 + int(m.group(2) or 0)) or 1
        per_hr = v["value"] / MM_PER_IN / hrs
        for h in range(hrs):
            snow_in_hourly[(t0 + timedelta(hours=h)).isoformat()] = per_hr
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)

    def total(hours):
        end = now + timedelta(hours=hours)
        return round(sum(v for k, v in snow_in_hourly.items() if now <= datetime.fromisoformat(k) < end), 1)

    periods = nws_json(f"/gridpoints/{NWS_GRID}/forecast")["properties"]["periods"]
    afd_list = nws_json("/products/types/AFD/locations/SLC")["@graph"]
    afd = nws_json(f"/products/{afd_list[0]['id']}")
    sections = {}
    # headings look like ".KEY MESSAGES, Issued 951 PM MST Mon Nov 2 2026..." or ".AVIATION..."
    for m in re.finditer(r"^\.([A-Z][A-Z /&-]+?)(?:,[^\n]*?)?\.\.\.\n(.*?)(?=^\.[A-Z][A-Z /&-]+?(?:,[^\n]*?)?\.\.\.|\Z)",
                         afd["productText"], re.S | re.M):
        body = re.sub(r"\n&&\s*$", "", m.group(2).strip())
        sections[m.group(1).strip()] = re.sub(r"\n(?!\n)", " ", body).strip()
    alerts = nws_json(f"/alerts/active?point={LAT:.4f},{LON:.4f}")["features"]
    return {
        "grid": NWS_GRID, "grid_elev_ft": round(grid["elevation"]["value"] * 3.28084),
        "updated": grid["updateTime"],
        "snow_totals_in": {"24h": total(24), "48h": total(48), "72h": total(72), "5d": total(120), "7d": total(168)},
        "periods": [{"name": p["name"], "start": p["startTime"], "temp": p["temperature"], "unit": p["temperatureUnit"],
                     "wind": f'{p["windDirection"]} {p["windSpeed"]}', "short": p["shortForecast"],
                     "detail": p["detailedForecast"], "pop": (p.get("probabilityOfPrecipitation") or {}).get("value"),
                     "day": p["isDaytime"]} for p in periods],
        "afd": {"issued": afd["issuanceTime"], "office": afd["issuingOffice"],
                "sections": {k: v for k, v in sections.items() if k in ("SYNOPSIS", "SHORT TERM", "LONG TERM", "KEY MESSAGES", "DISCUSSION")} or sections,
                "url": "https://forecast.weather.gov/product.php?site=SLC&issuedby=SLC&product=AFD"},
        "alerts": [{"event": a["properties"]["event"], "headline": a["properties"]["headline"],
                    "severity": a["properties"]["severity"], "ends": a["properties"].get("ends")} for a in alerts],
        "snow_level_ft_next": [
            {"t": t.isoformat(), "ft": round(v * 3.28084)} for t, v, _ in expand_series(grid["snowLevel"]["values"])[:96:3]
            if v is not None],
    }


# ---------------------------------------------------------------- models
def fetch_models():
    out = {}
    for mid, label in MODELS.items():
        url = ("https://api.open-meteo.com/v1/forecast?" + urllib.parse.urlencode({
            "latitude": LAT, "longitude": LON, "elevation": ELEV_M, "models": mid,
            "hourly": "snowfall,precipitation,temperature_2m,wind_speed_10m,wind_gusts_10m",
            "forecast_days": 16, "timezone": "America/Denver"}))
        try:
            d = json.loads(get(url))
            h = d["hourly"]
            n = len(h["time"])
            snow = [(x or 0) / CM_PER_IN for x in h["snowfall"]]
            prec = [(x or 0) / MM_PER_IN for x in h["precipitation"]]
            # model horizon = last hour with any non-null data
            horizon = max((i for i, x in enumerate(h["snowfall"]) if x is not None), default=-1) + 1
            local_now = datetime.now().strftime("%Y-%m-%dT%H:00")
            i0 = next((i for i, t in enumerate(h["time"]) if t >= local_now), 0)

            def tot(arr, hrs):
                if i0 + hrs > horizon:
                    return None  # model does not reach this far
                return round(sum(arr[i0:i0 + hrs]), 1)

            daily = []
            for day in range(16):
                a, b = i0 + day * 24, i0 + day * 24 + 24
                if b > horizon:
                    break
                daily.append(round(sum(snow[a:b]), 1))
            # AM = local midnight to noon, PM = noon to midnight. A half is valid only if all 12 hours have data.
            valid = [x is not None for x in h["snowfall"]]
            halves = {}
            for di in range(n // 24):
                a, noon, b = di * 24, di * 24 + 12, di * 24 + 24
                halves[h["time"][a][:10]] = [
                    round(sum(snow[a:noon]), 2) if all(valid[a:noon]) else None,
                    round(sum(snow[noon:b]), 2) if all(valid[noon:b]) else None]
            today_rem = [round(sum(snow[i0:12]), 2) if i0 < 12 and all(valid[i0:12]) else (0.0 if i0 >= 12 else None),
                         round(sum(snow[max(i0, 12):24]), 2) if all(valid[max(i0, 12):24]) else None]
            cum, run = [], 0.0
            for x in daily:
                run += x
                cum.append(round(run, 1))
            first_1in = next((h["time"][i0 + d * 24][:10] for d, x in enumerate(daily) if x >= 1.0), None)
            out[mid] = {"label": label, "horizon_days": round((horizon - i0) / 24, 1),
                        "cum_snow_in": cum, "total_in": cum[-1] if cum else None, "first_day_1in": first_1in,
                        "halves": halves, "today_rem": today_rem,
                        "snow_in": {k: tot(snow, hrs) for k, hrs in (("24h", 24), ("48h", 48), ("5d", 120), ("7d", 168), ("10d", 240), ("15d", 360))},
                        "liquid_in": {k: tot(prec, hrs) for k, hrs in (("5d", 120), ("10d", 240))},
                        "daily_snow_in": daily,
                        "daily_dates": [h["time"][i0 + d * 24][:10] for d in range(len(daily))],
                        "peak_gust_mph_48h": round(max((x or 0) for x in h["wind_gusts_10m"][i0:i0 + 48]) / 1.609344, 0) if horizon >= i0 + 48 else None}
        except Exception as e:  # noqa: BLE001
            out[mid] = {"label": label, "error": str(e)}
        time.sleep(0.4)
    ok = [m for m in out.values() if "snow_in" in m]
    spread = {}
    for k in ("24h", "48h", "5d", "7d", "10d", "15d"):
        vals = [m["snow_in"][k] for m in ok if m["snow_in"][k] is not None]
        if vals:
            spread[k] = {"min": min(vals), "max": max(vals), "mean": round(statistics.mean(vals), 1), "n": len(vals)}
    return {"point": {"lat": LAT, "lon": LON, "elev_ft": round(ELEV_M * 3.28084)}, "models": out, "spread": spread,
            "note": "Snowfall from Open-Meteo. ECMWF snowfall is derived from precipitation and temperature, so treat it as an estimate."}


# ---------------------------------------------------------------- resort
def pick(o, path, default=None):
    for p in path.split("."):
        if isinstance(o, dict) and p in o:
            o = o[p]
        else:
            return default
    return o


def strip_html(s):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", s or "")).replace(" ", " ").strip()


def fetch_resort():
    d = json.loads(get("https://powdermountain.com/api/conditions"))
    c, st = d["conditions"], d["status"]
    cs = c["currentSnow"]
    rd = {x["title"]: strip_html(x["data"][0]["data"]) for x in c.get("resortData", [])}
    sn = c["snowDetailImperial"]
    lifts = []
    for sector in st.get("sectorsData", []):
        for t in sector.get("trails", []):
            pass
    return {
        "updated": c.get("resortTimestamp"),
        "snow_report": {k: pick(cs, f"{k}.countryValue") for k in (
            "freshSnowFallDepth12H", "freshSnowFallDepth24H", "freshSnowFallDepth48H", "freshSnowFallDepth72H",
            "freshSnowFallDepth7D", "snowFallDepthCompleteSeason", "snowTotalDepth")},
        "snow_report_modified": cs.get("lastModified"),
        "last_snowfall": {"date": cs.get("lastSnowFallDate"), "in": pick(cs, "lastSnowFallDepth.countryValue")},
        "lifts": st["liftsOverall"], "trails": st["trailsOverall"],
        "daily_message": rd.get("Daily Report"), "hours": rd.get("Hours of Operation"),
        "roads": [{"name": r["name"], "route": r["number"], "open": r["status"], "surface": r["surface"], "equipment": r["equipment"]}
                  for r in c.get("roadsData", [])],
        "parking": [{"name": p["name"], "status": p["openingStatus"], "note": strip_html(pick(p, "messagePoi.data", [{}])[0].get("data", ""))}
                    for p in d.get("parking", {}).get("parkingOverall", [])],
        "opensnow_via_resort": {
            "attribution": "Powered by OpenSnow (supplied through powdermountain.com)",
            "link": pick(sn, "attribution.linkUrl"),
            "next_5d_snow_in": pick(sn, "forecastSnowSummary", [{}])[0],
            "daily": [{"label": x["displayAtLocalLabel"], "period": x["dayPeriod"], "cond": x["conditionsLabel"], "hi": x["tempMax"], "lo": x["tempMin"],
                       "snow": x["precipSnow"], "snow_min": x["precipSnowMin"], "snow_max": x["precipSnowMax"], "snow_level_ft": x["snowLevel"]}
                      for x in sn.get("forecastSemiDaily", [])],
        },
    }


# ------------------------------------------------------------------ cams
def save_cam(b, stem, ext):
    d = SITE / "cams"
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{stem}.{ext}").write_bytes(b)
    return f"cams/{stem}.{ext}"


def fetch_cams():
    cams = [
        ("SR-158 at Powder Mountain, MP 11.6", "https://udottraffic.utah.gov/1_devices/sr-158-mp11.gif", "UDOT"),
        ("Resort road cam (same feed)", "https://www.ixnay.net/cams/pm/s3/current.jpg", "Resort"),
    ]
    out, seen = [], set()
    # Mountain cams: PrismCam widget on powdermountain.com. cam_init lists each camera's latest frame path.
    try:
        init = get("https://php.prismcam.com/public/helpers/cam_init.php?cams=&pages=1762366089"
                   "&url=https%3A%2F%2Fpowdermountain.com%2Fconditions&callback=cb")
        pages = json.loads(init[init.index("(") + 1:init.rindex(")")])["pages"]
        for p in pages:
            cur, cam = p.get("current") or {}, p["cam"]
            if not cur.get("imagePath"):
                continue
            b, ct = get(f"https://storage.googleapis.com/prism-cam-{cur['imagePath']}/720.jpg", binary=True)
            age_min = round((time.time() - int(cur["time"])) / 60)
            out.append({"name": cam["camTitle"], "source": "PrismCam, via powdermountain.com", "bytes": len(b),
                        "taken_local": cur["mysqlTime"], "age_min": age_min, "stale": age_min > 180,
                        "img": save_cam(b, f"mtn{len(out)}", "jpg")})
    except Exception as e:  # noqa: BLE001
        print(f"FAIL  prismcam: {e}", file=sys.stderr)
    for name, url, src in cams:
        try:
            b, ct = get(url, binary=True)
            if hash(b) in seen:  # the resort's road cam URL serves the same UDOT image
                continue
            seen.add(hash(b))
            ct = "image/gif" if b[:3] == b"GIF" else ct
            out.append({"name": name, "source": src, "bytes": len(b),
                        "img": save_cam(b, f"road{len(out)}", "gif" if b[:3] == b"GIF" else "jpg")})
        except Exception as e:  # noqa: BLE001
            out.append({"name": name, "source": src, "error": str(e)})
    return out


# ------------------------------------------------------------ avalanche
AVY = "https://api.avalanche.org/v2/public"
LEVELS = {1: "Low", 2: "Moderate", 3: "Considerable", 4: "High", 5: "Extreme"}


def _lvl(v):
    try:
        v = int(v)
    except (TypeError, ValueError):
        return None
    return v if v in LEVELS else None


def fetch_avy():
    """Utah Avalanche Center, Ogden zone, via the Avalanche.org public API (no key)."""
    ml = json.loads(get(f"{AVY}/products/map-layer"))
    zone = next(f["properties"] for f in ml["features"]
                if f["properties"].get("center_id") == "UAC" and f["properties"].get("name") == "Ogden")
    now = datetime.now(timezone.utc)
    lst = json.loads(get(f"{AVY}/products?avalanche_center_id=UAC&date_start={(now - timedelta(days=7)).date()}"
                         f"&date_end={(now + timedelta(days=1)).date()}"))
    mine = [p for p in lst if p.get("product_type") == "forecast"
            and any(z.get("zone_id") == "ogden" for z in p.get("forecast_zone", []))]
    out = {"zone": "Ogden", "center": "Utah Avalanche Center", "link": zone["link"],
           "level": _lvl(zone.get("danger_level")), "rating": zone.get("danger"),
           "off_season": zone.get("off_season"), "product": None}
    if mine:
        latest = max(mine, key=lambda p: p["published_time"])
        det = json.loads(get(f"{AVY}/product/{latest['id']}"))
        dng = det.get("danger") or []
        cur = next((d for d in dng if d.get("valid_day") == "current"), dng[0] if dng else None)
        bl = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", det.get("bottom_line") or "")).strip()
        out["product"] = {"id": latest["id"], "published": det.get("published_time"), "expires": det.get("expires_time"),
                          "bottom_line": bl or None,
                          "elevation": {k: _lvl(cur.get(k)) for k in ("upper", "middle", "lower")} if cur else None}
    return out


# ----------------------------------------------------- daily strip (OpenSnow-style)
GROUPS = [(-15, -11, "Prev 11–15 days"), (-10, -6, "Prev 6–10 days"), (-5, -1, "Prev 1–5 days"),
          (0, 4, "Next 1–5 days"), (5, 9, "Next 6–10 days"), (10, 14, "Next 11–15 days")]


def build_daily_snow(full, daily, models, now):
    """One record per day, each split into AM (midnight-noon) and PM (noon-midnight), station local time.

    Past halves: measured new snow = sum of positive hour-to-hour gains in median-filtered SNOTEL depth
    (the sensor reports whole inches and throws one-hour spikes; the precip gauge drifts about +-0.2 in
    a day with temperature, so it is not used for amounts). Future halves: mean of the models that cover
    the whole half. The half-day containing 'now' is measured-so-far plus the model mean for the rest.
    """
    def fill(vals):
        out, last = [], None
        for v in vals:
            last = v if v is not None else last
            out.append(last)
        return out

    def med5(vals):
        return [statistics.median([x for x in vals[max(0, i - 2):i + 3] if x is not None] or [0]) for i in range(len(vals))]

    dep, swe = med5(fill([h["depth"] for h in full])), med5(fill([h["swe"] for h in full]))
    obs = {}  # (date, half) -> [depth gain, swe gain, hours with data]
    for i in range(1, len(full)):
        t = full[i]["t"]
        key = (t[:10], 0 if int(t[11:13]) < 12 else 1)
        o = obs.setdefault(key, [0.0, 0.0, 0])
        o[0] += max(0.0, dep[i] - dep[i - 1])
        o[1] += max(0.0, swe[i] - swe[i - 1])
        o[2] += 1
    hilo = {d["d"]: (d["tmax_f"], d["tmin_f"]) for d in daily}
    today = now.date()
    days = []
    for off in range(-15, 15):
        d = today + timedelta(days=off)
        ds = d.isoformat()
        halves = []
        for half in (0, 1):
            start_h, end_h = half * 12, half * 12 + 12
            rec = {"obs": None, "swe": None, "fc": None, "kind": None}
            if off < 0 or (off == 0 and now.hour >= end_h):
                kind = "obs"
            elif off == 0 and now.hour >= start_h:
                kind = "now"
            else:
                kind = "fc"
            rec["kind"] = kind
            if kind in ("obs", "now"):
                o = obs.get((ds, half))
                if o and o[2] > 0:
                    rec["obs"], rec["swe"] = round(o[0], 1), round(o[1], 1)
            if kind in ("fc", "now"):
                per = {}
                for m in models.values():
                    if "halves" not in m:
                        continue
                    v = m["today_rem"][half] if kind == "now" else m["halves"].get(ds, [None, None])[half]
                    if v is not None:
                        per[m["label"]] = round(v, 2)
                if per:
                    vals = list(per.values())
                    rec["fc"] = {"mean": round(statistics.mean(vals), 2), "min": round(min(vals), 2),
                                 "max": round(max(vals), 2), "n": len(vals), "by_model": per}
            parts = [x for x in (rec["obs"], rec["fc"]["mean"] if rec["fc"] else None) if x is not None]
            rec["value"] = round(sum(parts), 1) if parts else None
            halves.append(rec)
        vals = [h["value"] for h in halves if h["value"] is not None]
        hi, lo = hilo.get(ds, (None, None))
        days.append({"date": ds, "offset": off, "am": halves[0], "pm": halves[1],
                     "total": round(sum(vals), 1) if vals else None, "hi_f": hi, "lo_f": lo})
    groups = []
    for a, b, label in GROUPS:
        vals = [x["total"] or 0 for x in days if a <= x["offset"] <= b]
        groups.append({"label": label, "from": a, "to": b, "total": round(sum(vals), 1)})
    return {"now_local": now.isoformat(timespec="minutes"), "days": days, "groups": groups,
            "method": "Measured halves use SNOTEL depth gain; forecast halves use the model average."}


if __name__ == "__main__":
    from zoneinfo import ZoneInfo
    snotel = safe("snotel", fetch_snotel)
    models = safe("models", fetch_models)
    full = snotel.pop("_full", None) if isinstance(snotel, dict) else None
    data = {"generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "snotel": snotel, "nws": safe("nws", fetch_nws),
            "models": models, "resort": safe("resort", fetch_resort),
            "daily_snow": safe("daily_snow", lambda: build_daily_snow(
                full, snotel["daily"], models["models"], datetime.now(ZoneInfo("America/Denver")))),
            "avalanche": safe("avalanche", fetch_avy),
            "cams": safe("cams", fetch_cams)}
    SITE.mkdir(exist_ok=True)
    out = SITE / "data.json"
    out.write_text(json.dumps(data, separators=(",", ":")))
    print(f"wrote {out} ({out.stat().st_size // 1024} KB)", file=sys.stderr)

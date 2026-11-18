// Live data, computed in the Worker on request. A JavaScript port of fetch.py; keep the two in step
// until fetch.py is retired. Each source has its own endpoint (/live/<name>.json) so each request
// stays inside the free plan's 10 ms CPU budget. Upstream responses are cached at Cloudflare's edge
// for about as long as each source takes to change (TTL below), so a refresh is as fresh as the
// source and one viewer's refresh warms it for everyone.
//
// All arithmetic (unit conversion, totals, spread) happens here, not in the page.

const UA = "powmow-snow (+https://github.com/joebuckwalter/powmow-snow)";
const LAT = 41.3796, LON = -111.7604, ELEV_M = 2446;
const NWS_GRID = "SLC/108,203";
const SNOTEL = "1300:UT:SNTL";
const MODELS = {
  gfs_seamless: "GFS", ecmwf_ifs025: "ECMWF IFS", ecmwf_aifs025_single: "ECMWF AIFS",
  icon_seamless: "ICON", gem_seamless: "GEM", ncep_hrrr_conus: "HRRR",
};
const CM_PER_IN = 2.54, MM_PER_IN = 25.4, FT_PER_M = 3.28084;
const TZ = "America/Denver";
// Edge-cache seconds per source: roughly how often each one actually changes.
const TTL = { snotel: 600, nws: 600, models: 1800, resort: 120, avalanche: 600, cams: 60 };

// ------------------------------------------------------------------ helpers
const round = (x, n = 0) => { const f = 10 ** n; return Math.round((x + Number.EPSILON) * f) / f; };
const sum = (a) => a.reduce((s, x) => s + x, 0);
const mean = (a) => sum(a) / a.length;
const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const num = (v) => { if (v == null || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const pick = (o, path, dflt = null) => { for (const p of path.split(".")) { if (o && typeof o === "object" && p in o) o = o[p]; else return dflt; } return o; };
const stripHtml = (s) => (s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/ /g, " ").trim();
const lastOf = (arr, key) => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i][key] != null) return arr[i]; return null; };

async function get(url, ttl, kind = "text") {
  const r = await fetch(url, { headers: { "user-agent": UA, accept: "*/*" }, cf: { cacheTtl: ttl, cacheEverything: true } });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
  return kind === "json" ? r.json() : r.text();
}

// Wall-clock parts in Mountain time. GitHub runners are UTC, and fetch.py used the runner's clock as if
// it were local, so its model "now" index ran 7 h ahead. Everything here is explicitly Mountain time.
function denverNow(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(d).map((x) => [x.type, x.value]));
  const offMin = Math.round((Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(d.getTime() / 60000) * 60000) / 60000);
  const sign = offMin < 0 ? "-" : "+", a = Math.abs(offMin);
  return { date: `${p.year}-${p.month}-${p.day}`, year: +p.year, month: +p.month, hour: +p.hour,
    hourStr: `${p.year}-${p.month}-${p.day}T${p.hour}:00`,
    iso: `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}${sign}${String(a / 60 | 0).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}` };
}
const addDays = (ds, n) => new Date(Date.parse(ds + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);

// ------------------------------------------------------------------ SNOTEL
function parseCsv(text) {
  const rows = text.split(/\r?\n/).filter((l) => l && !l.startsWith("#")).map((l) => l.split(","));
  return rows.slice(1);  // header dropped; columns are positional, as in fetch.py
}
async function snotelCsv(mode, rng, elements) {
  const station = encodeURIComponent(SNOTEL + '|id=""|name');
  return parseCsv(await get(`https://wcc.sc.egov.usda.gov/reportGenerator/view_csv/customSingleStationReport/${mode}/start_of_period/${station}/${rng}/${elements}`, TTL.snotel));
}

async function snotelRaw() {
  const now = denverNow();
  const wys = `${now.month >= 10 ? now.year : now.year - 1}-10-01`;
  const [h, d] = await Promise.all([
    snotelCsv("hourly", "-408,0", "WTEQ::value,SNWD::value,TOBS::value,PREC::value"),
    snotelCsv("daily", `${wys},${now.date}`, "WTEQ::value,SNWD::value,PREC::value,TMAX::value,TMIN::value"),
  ]);
  const full = h.map((r) => ({ t: r[0].replace(" ", "T"), swe: num(r[1]), depth: num(r[2]), temp_f: num(r[3]), prec: num(r[4]) }));
  const daily = d.map((r) => ({ d: r[0], swe: num(r[1]), depth: num(r[2]), prec: num(r[3]), tmax_f: num(r[4]), tmin_f: num(r[5]) }));
  return { full, daily, wys };
}

export async function snotel() {
  const { full, daily, wys } = await snotelRaw();
  const hourly = full.slice(-169);
  const last = lastOf(hourly, "prec");
  const atHoursAgo = (hrs, key) => {
    const idx = hourly.length - 1 - hrs;
    if (idx < 0) return null;
    for (let j = idx; j > Math.max(idx - 4, -1); j--) if (hourly[j][key] != null) return hourly[j][key];
    return null;
  };
  const curD = lastOf(hourly, "depth")?.depth ?? null;
  const windows = {};
  for (const [label, hrs] of [["24h", 24], ["48h", 48], ["72h", 72], ["7d", 168]]) {
    const p0 = atHoursAgo(hrs, "prec"), d0 = atHoursAgo(hrs, "depth");
    windows[label] = { liquid_in: last && p0 != null ? round(last.prec - p0, 2) : null,
      depth_change_in: curD != null && d0 != null ? round(curD - d0, 1) : null };
  }
  const cur = lastOf(hourly, "temp_f") || hourly[hourly.length - 1];
  return {
    station: { name: "Powder Mountain SNOTEL", triplet: SNOTEL, elev_ft: 8490,
      note: "Air temperature has a documented sensor bias (NRCS). Times are station local." },
    current: { t: cur.t, temp_f: cur.temp_f, depth_in: curD, swe_in: lastOf(hourly, "swe")?.swe ?? null,
      water_year_prec_in: last ? last.prec : null },
    windows, hourly, daily, water_year_start: wys,
  };
}

// --------------------------------------------------------------------- NWS
const nws = (path) => get("https://api.weather.gov" + path, TTL.nws, "json");
function durHours(dur) {
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?/.exec(dur);
  return (Number(m[1] || 0) * 24 + Number(m[2] || 0)) || 1;
}

export async function nwsData() {
  const [gridR, fcR, afdList, alertsR] = await Promise.all([
    nws(`/gridpoints/${NWS_GRID}`), nws(`/gridpoints/${NWS_GRID}/forecast`),
    nws("/products/types/AFD/locations/SLC"), nws(`/alerts/active?point=${LAT.toFixed(4)},${LON.toFixed(4)}`),
  ]);
  const grid = gridR.properties;
  const afd = await nws(`/products/${afdList["@graph"][0].id}`);
  const snowHr = new Map();  // epoch ms -> inches in that hour
  for (const v of grid.snowfallAmount.values) {
    if (v.value == null) continue;
    const [start, dur] = v.validTime.split("/"), hrs = durHours(dur), t0 = Date.parse(start);
    for (let h = 0; h < hrs; h++) snowHr.set(t0 + h * 36e5, v.value / MM_PER_IN / hrs);
  }
  const now = Math.floor(Date.now() / 36e5) * 36e5;
  const total = (hours) => { let s = 0; for (const [t, v] of snowHr) if (t >= now && t < now + hours * 36e5) s += v; return round(s, 1); };
  const sections = {};
  const re = /^\.([A-Z][A-Z /&-]+?)(?:,[^\n]*?)?\.\.\.\n([\s\S]*?)(?=^\.[A-Z][A-Z /&-]+?(?:,[^\n]*?)?\.\.\.|(?![\s\S]))/gm;
  for (const m of afd.productText.matchAll(re)) {
    const body = m[2].trim().replace(/\n&&\s*$/, "");
    sections[m[1].trim()] = body.replace(/\n(?!\n)/g, " ").trim();
  }
  const keep = Object.fromEntries(Object.entries(sections).filter(([k]) => ["SYNOPSIS", "SHORT TERM", "LONG TERM", "KEY MESSAGES", "DISCUSSION"].includes(k)));
  const snowLevel = [];
  for (const v of grid.snowLevel.values) {
    const [start, dur] = v.validTime.split("/"), hrs = durHours(dur), t0 = Date.parse(start);
    for (let h = 0; h < hrs; h++) snowLevel.push([t0 + h * 36e5, v.value]);
  }
  return {
    grid: NWS_GRID, grid_elev_ft: Math.round(grid.elevation.value * FT_PER_M), updated: grid.updateTime,
    snow_totals_in: { "24h": total(24), "48h": total(48), "72h": total(72), "5d": total(120), "7d": total(168) },
    periods: fcR.properties.periods.map((p) => ({ name: p.name, start: p.startTime, temp: p.temperature, unit: p.temperatureUnit,
      wind: `${p.windDirection} ${p.windSpeed}`, short: p.shortForecast, detail: p.detailedForecast,
      pop: p.probabilityOfPrecipitation?.value ?? null, day: p.isDaytime })),
    afd: { issued: afd.issuanceTime, office: afd.issuingOffice, sections: Object.keys(keep).length ? keep : sections,
      url: "https://forecast.weather.gov/product.php?site=SLC&issuedby=SLC&product=AFD" },
    alerts: alertsR.features.map((a) => ({ event: a.properties.event, headline: a.properties.headline,
      severity: a.properties.severity, ends: a.properties.ends ?? null })),
    snow_level_ft_next: snowLevel.slice(0, 96).filter((_, i) => i % 3 === 0).filter(([, v]) => v != null)
      .map(([t, v]) => ({ t: new Date(t).toISOString().replace(".000Z", "+00:00"), ft: Math.round(v * FT_PER_M) })),
  };
}

// ------------------------------------------------------------------ models
// One Open-Meteo request for all six models (keys come back suffixed, e.g. snowfall_gfs_seamless).
// Six parallel requests drew HTTP 429s.
const VARS = ["snowfall", "precipitation", "temperature_2m", "wind_speed_10m", "wind_gusts_10m"];
function oneModel(mid, label, all, now) {
  try {
    const h = { time: all.time };
    for (const v of VARS) {
      h[v] = all[`${v}_${mid}`];
      if (!h[v]) throw new Error(`no ${v} for ${mid} in response`);
    }
    const n = h.time.length;
    const snow = h.snowfall.map((x) => (x || 0) / CM_PER_IN), prec = h.precipitation.map((x) => (x || 0) / MM_PER_IN);
    const valid = h.snowfall.map((x) => x != null);
    const horizon = valid.lastIndexOf(true) + 1;
    let i0 = h.time.findIndex((t) => t >= now.hourStr); if (i0 < 0) i0 = 0;
    const s = (arr, a, b) => sum(arr.slice(a, b));
    const covered = (a, b) => valid.slice(a, b).every(Boolean);
    const tot = (arr, hrs) => (i0 + hrs > horizon ? null : round(s(arr, i0, i0 + hrs), 1));
    const daily = [];
    for (let day = 0; day < 16; day++) { const a = i0 + day * 24, b = a + 24; if (b > horizon) break; daily.push(round(s(snow, a, b), 1)); }
    // AM = local midnight to noon, PM = noon to midnight. A half is valid only if all 12 hours have data.
    const halves = {};
    for (let di = 0; di < Math.floor(n / 24); di++) {
      const a = di * 24, noon = a + 12, b = a + 24;
      halves[h.time[a].slice(0, 10)] = [covered(a, noon) ? round(s(snow, a, noon), 2) : null, covered(noon, b) ? round(s(snow, noon, b), 2) : null];
    }
    const todayRem = [i0 < 12 ? (covered(i0, 12) ? round(s(snow, i0, 12), 2) : null) : 0,
      covered(Math.max(i0, 12), 24) ? round(s(snow, Math.max(i0, 12), 24), 2) : null];
    let run = 0; const cum = daily.map((x) => round(run += x, 1));
    const d1 = daily.findIndex((x) => x >= 1);
    return { label, horizon_days: round((horizon - i0) / 24, 1), cum_snow_in: cum, total_in: cum.length ? cum[cum.length - 1] : null,
      first_day_1in: d1 >= 0 ? h.time[i0 + d1 * 24].slice(0, 10) : null, halves, today_rem: todayRem,
      snow_in: Object.fromEntries([["24h", 24], ["48h", 48], ["5d", 120], ["7d", 168], ["10d", 240], ["15d", 360]].map(([k, hr]) => [k, tot(snow, hr)])),
      liquid_in: Object.fromEntries([["5d", 120], ["10d", 240]].map(([k, hr]) => [k, tot(prec, hr)])),
      daily_snow_in: daily, daily_dates: daily.map((_, d) => h.time[i0 + d * 24].slice(0, 10)),
      peak_gust_mph_48h: horizon >= i0 + 48 ? Math.round(Math.max(...h.wind_gusts_10m.slice(i0, i0 + 48).map((x) => x || 0)) / 1.609344) : null };
  } catch (e) {
    return { label, error: String(e.message || e) };
  }
}

export async function models() {
  const now = denverNow();
  const q = new URLSearchParams({ latitude: LAT, longitude: LON, elevation: ELEV_M, models: Object.keys(MODELS).join(","),
    hourly: VARS.join(","), forecast_days: 16, timezone: TZ });
  const all = (await get("https://api.open-meteo.com/v1/forecast?" + q, TTL.models, "json")).hourly;
  const out = Object.fromEntries(Object.entries(MODELS).map(([mid, label]) => [mid, oneModel(mid, label, all, now)]));
  const ok = Object.values(out).filter((m) => m.snow_in);
  if (!ok.length) throw new Error("all models failed: " + Object.values(out).map((m) => m.error).join("; "));
  const spread = {};
  for (const k of ["24h", "48h", "5d", "7d", "10d", "15d"]) {
    const v = ok.map((m) => m.snow_in[k]).filter((x) => x != null);
    if (v.length) spread[k] = { min: Math.min(...v), max: Math.max(...v), mean: round(mean(v), 1), n: v.length };
  }
  return { point: { lat: LAT, lon: LON, elev_ft: Math.round(ELEV_M * FT_PER_M) }, models: out, spread,
    note: "Snowfall from Open-Meteo. ECMWF snowfall is derived from precipitation and temperature, so treat it as an estimate." };
}

// ------------------------------------------------------------------ resort
export async function resort() {
  const d = await get("https://powdermountain.com/api/conditions", TTL.resort, "json");
  const c = d.conditions, st = d.status, cs = c.currentSnow, sn = c.snowDetailImperial;
  const rd = Object.fromEntries((c.resortData || []).map((x) => [x.title, stripHtml(x.data[0].data)]));
  return {
    updated: c.resortTimestamp ?? null,
    snow_report: Object.fromEntries(["freshSnowFallDepth12H", "freshSnowFallDepth24H", "freshSnowFallDepth48H", "freshSnowFallDepth72H",
      "freshSnowFallDepth7D", "snowFallDepthCompleteSeason", "snowTotalDepth"].map((k) => [k, pick(cs, `${k}.countryValue`)])),
    snow_report_modified: cs.lastModified ?? null,
    last_snowfall: { date: cs.lastSnowFallDate ?? null, in: pick(cs, "lastSnowFallDepth.countryValue") },
    lifts: st.liftsOverall, trails: st.trailsOverall,
    daily_message: rd["Daily Report"] ?? null, hours: rd["Hours of Operation"] ?? null,
    roads: (c.roadsData || []).map((r) => ({ name: r.name, route: r.number, open: r.status, surface: r.surface, equipment: r.equipment })),
    parking: (d.parking?.parkingOverall || []).map((p) => ({ name: p.name, status: p.openingStatus,
      note: stripHtml((pick(p, "messagePoi.data", [{}])[0] || {}).data || "") })),
    opensnow_via_resort: {
      attribution: "Powered by OpenSnow (supplied through powdermountain.com)",
      link: pick(sn, "attribution.linkUrl"),
      next_5d_snow_in: (pick(sn, "forecastSnowSummary", [{}]) || [{}])[0],
      daily: (sn.forecastSemiDaily || []).map((x) => ({ label: x.displayAtLocalLabel, period: x.dayPeriod, cond: x.conditionsLabel,
        hi: x.tempMax, lo: x.tempMin, snow: x.precipSnow, snow_min: x.precipSnowMin, snow_max: x.precipSnowMax, snow_level_ft: x.snowLevel })),
    },
  };
}

// --------------------------------------------------------------- avalanche
const AVY = "https://api.avalanche.org/v2/public";
const lvl = (v) => { const n = parseInt(v, 10); return n >= 1 && n <= 5 ? n : null; };
export async function avalanche() {
  const now = Date.now(), day = (ms) => new Date(ms).toISOString().slice(0, 10);
  const [ml, lst] = await Promise.all([
    get(`${AVY}/products/map-layer`, TTL.avalanche, "json"),
    get(`${AVY}/products?avalanche_center_id=UAC&date_start=${day(now - 7 * 864e5)}&date_end=${day(now + 864e5)}`, TTL.avalanche, "json"),
  ]);
  const zone = ml.features.map((f) => f.properties).find((p) => p.center_id === "UAC" && p.name === "Ogden");
  if (!zone) throw new Error("Ogden zone not in map layer");
  const mine = lst.filter((p) => p.product_type === "forecast" && (p.forecast_zone || []).some((z) => z.zone_id === "ogden"));
  const out = { zone: "Ogden", center: "Utah Avalanche Center", link: zone.link, level: lvl(zone.danger_level),
    rating: zone.danger ?? null, off_season: zone.off_season ?? null, product: null };
  if (mine.length) {
    const latest = mine.reduce((a, b) => (b.published_time > a.published_time ? b : a));
    const det = await get(`${AVY}/product/${latest.id}`, TTL.avalanche, "json");
    const dng = det.danger || [];
    const cur = dng.find((d) => d.valid_day === "current") || dng[0] || null;
    const bl = stripHtml(det.bottom_line || "");
    out.product = { id: latest.id, published: det.published_time ?? null, expires: det.expires_time ?? null, bottom_line: bl || null,
      elevation: cur ? { upper: lvl(cur.upper), middle: lvl(cur.middle), lower: lvl(cur.lower) } : null };
  }
  return out;
}

// --------------------------------------------- daily strip (OpenSnow-style)
const GROUPS = [[-15, -11, "Prev 11–15 days"], [-10, -6, "Prev 6–10 days"], [-5, -1, "Prev 1–5 days"],
  [0, 4, "Next 1–5 days"], [5, 9, "Next 6–10 days"], [10, 14, "Next 11–15 days"]];

// One record per day, split AM (midnight-noon) / PM (noon-midnight), station local time. Past halves:
// sum of positive hour-to-hour gains in median-filtered SNOTEL depth (whole-inch sensor with one-hour
// spikes; the precip gauge drifts with temperature, so it isn't used for amounts). Future halves: mean
// of the models covering the whole half. The current half is measured-so-far plus the model mean for the rest.
export async function dailySnow() {
  const [{ full, daily }, m] = await Promise.all([snotelRaw(), models()]);
  const now = denverNow();
  const fill = (vals) => { let last = null; return vals.map((v) => (last = v != null ? v : last)); };
  const med5 = (vals) => vals.map((_, i) => { const w = vals.slice(Math.max(0, i - 2), i + 3).filter((x) => x != null); return median(w.length ? w : [0]); });
  const dep = med5(fill(full.map((h) => h.depth))), swe = med5(fill(full.map((h) => h.swe)));
  const obs = new Map();
  for (let i = 1; i < full.length; i++) {
    const t = full[i].t, key = `${t.slice(0, 10)}|${Number(t.slice(11, 13)) < 12 ? 0 : 1}`;
    const o = obs.get(key) || [0, 0, 0];
    o[0] += Math.max(0, dep[i] - dep[i - 1]); o[1] += Math.max(0, swe[i] - swe[i - 1]); o[2] += 1;
    obs.set(key, o);
  }
  const hilo = Object.fromEntries(daily.map((d) => [d.d, [d.tmax_f, d.tmin_f]]));
  const days = [];
  for (let off = -15; off < 15; off++) {
    const ds = addDays(now.date, off), halves = [];
    for (const half of [0, 1]) {
      const startH = half * 12, endH = startH + 12;
      const kind = off < 0 || (off === 0 && now.hour >= endH) ? "obs" : off === 0 && now.hour >= startH ? "now" : "fc";
      const rec = { obs: null, swe: null, fc: null, kind };
      if (kind !== "fc") { const o = obs.get(`${ds}|${half}`); if (o && o[2] > 0) { rec.obs = round(o[0], 1); rec.swe = round(o[1], 1); } }
      if (kind !== "obs") {
        const per = {};
        for (const md of Object.values(m.models)) {
          if (!md.halves) continue;
          const v = kind === "now" ? md.today_rem[half] : (md.halves[ds] || [null, null])[half];
          if (v != null) per[md.label] = round(v, 2);
        }
        const v = Object.values(per);
        if (v.length) rec.fc = { mean: round(mean(v), 2), min: round(Math.min(...v), 2), max: round(Math.max(...v), 2), n: v.length, by_model: per };
      }
      const parts = [rec.obs, rec.fc ? rec.fc.mean : null].filter((x) => x != null);
      rec.value = parts.length ? round(sum(parts), 1) : null;
      halves.push(rec);
    }
    const vals = halves.map((h) => h.value).filter((x) => x != null);
    const [hi, lo] = hilo[ds] || [null, null];
    days.push({ date: ds, offset: off, am: halves[0], pm: halves[1], total: vals.length ? round(sum(vals), 1) : null, hi_f: hi, lo_f: lo });
  }
  const groups = GROUPS.map(([a, b, label]) => ({ label, from: a, to: b,
    total: round(sum(days.filter((x) => x.offset >= a && x.offset <= b).map((x) => x.total || 0)), 1) }));
  return { now_local: now.iso, days, groups, method: "Measured halves use SNOTEL depth gain; forecast halves use the model average." };
}

// -------------------------------------------------------------------- cams
const PRISM = "https://php.prismcam.com/public/helpers/cam_init.php?cams=&pages=1762366089" +
  "&url=https%3A%2F%2Fpowdermountain.com%2Fconditions&callback=cb";
export async function cams() {
  const t = await get(PRISM, TTL.cams);
  const pages = JSON.parse(t.slice(t.indexOf("(") + 1, t.lastIndexOf(")"))).pages || [];
  const now = Date.now() / 1000;
  const out = pages.filter((p) => p.current && p.current.imagePath).map((p) => {
    const age = Math.round((now - Number(p.current.time)) / 60);
    return { name: p.cam.camTitle, source: "PrismCam, via powdermountain.com",
      img: `https://storage.googleapis.com/prism-cam-${p.current.imagePath}/720.jpg`,
      taken_local: p.current.mysqlTime, age_min: age, stale: age > 180 };
  });
  out.push({ name: "SR-158 at Powder Mountain, MP 11.6", source: "UDOT", img: "live/udot.gif?t=" + Math.floor(now / 60) });
  return out;
}

export const SOURCES = { snotel, nws: nwsData, models, resort, daily_snow: dailySnow, avalanche, cams };

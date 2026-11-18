// Static site + live data. /live/<source>.json computes one source on request (see live.js), so a page
// refresh is as fresh as the source itself. If a source fails, the last good copy from the build's
// data.json is served instead, marked carried_from. /live/udot.gif proxies the UDOT road cam.
import { SOURCES } from "./live.js";

const UDOT = "https://udottraffic.utah.gov/1_devices/sr-158-mp11.gif";
const json = (body, status = 200, maxAge = 30) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": `public, max-age=${maxAge}` } });

export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url);
    const m = /^\/live\/([a-z_]+)\.json$/.exec(pathname);
    if (m && SOURCES[m[1]]) {
      const name = m[1];
      try {
        return json({ at: new Date().toISOString(), data: await SOURCES[name]() });
      } catch (e) {
        const reason = String(e.message || e);
        try {
          const prev = await (await env.ASSETS.fetch(new URL("/data.json", req.url))).json();
          const p = prev[name];
          if (p && !(typeof p === "object" && !Array.isArray(p) && p.error)) {
            const data = Array.isArray(p) ? p : { ...p, carried_from: p.carried_from || prev.generated, carry_reason: reason };
            return json({ at: prev.generated, carried: true, reason, data });
          }
        } catch { /* fall through */ }
        return json({ error: reason }, 502, 0);
      }
    }
    if (pathname === "/live/udot.gif") {
      const r = await fetch(UDOT, { cf: { cacheTtl: 60, cacheEverything: true } });
      return new Response(r.body, { status: r.status, headers: { "content-type": "image/gif", "cache-control": "public, max-age=60" } });
    }
    return env.ASSETS.fetch(req);
  },
};

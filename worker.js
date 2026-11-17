// Static site + two live routes + a reliable schedule.
// - /live/cams.json: newest frame for each mountain cam (PrismCam) plus the UDOT road cam, edge-cached 60 s.
// - /live/udot.gif: UDOT SR-158 frame, proxied and edge-cached 60 s.
// - scheduled(): GitHub's own cron fired only 3-4 times a day, so a Cloudflare cron trigger
//   calls workflow_dispatch instead. Needs GH_TOKEN (fine-grained, Actions: write on this repo).
const PRISM = "https://php.prismcam.com/public/helpers/cam_init.php?cams=&pages=1762366089" +
  "&url=https%3A%2F%2Fpowdermountain.com%2Fconditions&callback=cb";
const UDOT = "https://udottraffic.utah.gov/1_devices/sr-158-mp11.gif";
const REPO = "joebuckwalter/powmow-snow";

async function liveCams() {
  const r = await fetch(PRISM, { cf: { cacheTtl: 60, cacheEverything: true } });
  if (!r.ok) throw new Error("prismcam " + r.status);
  const t = await r.text();
  const pages = JSON.parse(t.slice(t.indexOf("(") + 1, t.lastIndexOf(")"))).pages || [];
  const now = Date.now() / 1000;
  const out = pages.filter((p) => p.current && p.current.imagePath).map((p) => {
    const age = Math.round((now - Number(p.current.time)) / 60);
    return { name: p.cam.camTitle, source: "PrismCam, via powdermountain.com",
      img: `https://storage.googleapis.com/prism-cam-${p.current.imagePath}/720.jpg`,
      taken_local: p.current.mysqlTime, age_min: age, stale: age > 180 };
  });
  out.push({ name: "SR-158 at Powder Mountain, MP 11.6", source: "UDOT",
    img: "live/udot.gif?t=" + Math.floor(now / 60) });
  return out;
}

export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url);
    if (pathname === "/live/cams.json") {
      try {
        return Response.json(await liveCams(), { headers: { "cache-control": "public, max-age=60" } });
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 502 });
      }
    }
    if (pathname === "/live/udot.gif") {
      const r = await fetch(UDOT, { cf: { cacheTtl: 60, cacheEverything: true } });
      return new Response(r.body, { status: r.status,
        headers: { "content-type": "image/gif", "cache-control": "public, max-age=60" } });
    }
    return env.ASSETS.fetch(req);
  },

  async scheduled(_evt, env) {
    if (!env.GH_TOKEN) { console.log("GH_TOKEN not set; skipping dispatch"); return; }
    const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/update.yml/dispatches`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.GH_TOKEN}`, accept: "application/vnd.github+json",
        "user-agent": "powmow-snow-cron", "x-github-api-version": "2022-11-28" },
      body: JSON.stringify({ ref: "main" }),
    });
    console.log("dispatch", r.status, r.status === 204 ? "" : await r.text());
  },
};

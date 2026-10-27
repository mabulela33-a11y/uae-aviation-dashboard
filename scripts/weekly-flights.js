// Counts last week's tracked arrivals and departures at UAE airports using the
// OpenSky Network API (free account), estimates passengers from each airport's
// official passengers-per-flight ratio, and saves one row per airport/week to
// Supabase (table tracked_weekly). Runs from the "Weekly UAE flight counts"
// GitHub Action. Node 20+ (built-in fetch).
//
// Secrets: OPENSKY_CLIENT_ID, OPENSKY_CLIENT_SECRET, SUPABASE_SERVICE_KEY
// Optional: WEEKS_BACK (default 1 = the last complete Monday–Sunday week, UTC)

const SUPABASE_URL = process.env.SUPABASE_URL || "https://stdxueftoewwnhbqncbo.supabase.co";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const CLIENT_ID = process.env.OPENSKY_CLIENT_ID;
const CLIENT_SECRET = process.env.OPENSKY_CLIENT_SECRET;
const TOKEN_URL = process.env.OPENSKY_TOKEN_URL ||
  "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
const API = "https://opensky-network.org/api";
// Show errors and warnings as GitHub Actions annotations (visible on the run summary)
const _err = console.error.bind(console), _warn = console.warn.bind(console);
console.error = (...a) => _err(`::error::${a.join(" ")}`);
console.warn = (...a) => _warn(`::warning::${a.join(" ")}`);
const WEEKS_BACK = Math.min(Math.max(parseInt(process.env.WEEKS_BACK || "1", 10) || 1, 1), 8);

// Passengers per flight (movement) from official figures; null = no official basis
const AIRPORTS = [
  { code: "DXB", icao: "OMDB", ratio: 31500000 / 150600, basis: "DXB official Jan–Jun 2026: 31.5m passengers ÷ 150,600 flights" },
  { code: "AUH", icao: "OMAA", ratio: 93000 / 500, basis: "AUH operator, late June 2026: ~93,000 passengers ÷ ~500 flights a day" },
  { code: "SHJ", icao: "OMSJ", ratio: 19480000 / 116657, basis: "SHJ official 2025: 19.48m passengers ÷ 116,657 flights" },
  { code: "RAK", icao: "OMRK", ratio: null, basis: "RAK publishes no flight total, so no passenger estimate" },
];

for (const [name, value] of Object.entries({ OPENSKY_CLIENT_ID: CLIENT_ID, OPENSKY_CLIENT_SECRET: CLIENT_SECRET, SUPABASE_SERVICE_KEY })) {
  if (!value) {
    console.error(`Missing secret ${name}. Add it under the repo's Settings → Secrets and variables → Actions.`);
    process.exit(1);
  }
}

let token = null;
let tokenExpires = 0;
async function getToken() {
  if (token && Date.now() < tokenExpires - 60000) return token;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`OpenSky sign-in failed (HTTP ${res.status}${body.error_description ? `: ${body.error_description}` : ""}). Check OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET.`);
  }
  token = body.access_token;
  tokenExpires = Date.now() + (body.expires_in || 1800) * 1000;
  return token;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One day of arrivals or departures. Returns an array, or null if the day couldn't be fetched.
async function fetchDay(kind, icao, begin, end) {
  const url = `${API}/flights/${kind}?airport=${icao}&begin=${begin}&end=${end}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${await getToken()}` } });
    if (res.ok) return res.json();
    if (res.status === 404) return null; // OpenSky has no processed data for this day (yet)
    if (res.status === 401) { token = null; continue; }
    if (res.status === 429 || res.status >= 500) {
      const wait = parseInt(res.headers.get("x-rate-limit-retry-after-seconds") || "0", 10) * 1000 || 5000 * attempt;
      console.warn(`${kind} ${icao}: HTTP ${res.status}, retrying in ${Math.round(wait / 1000)}s`);
      await sleep(Math.min(wait, 60000));
      continue;
    }
    console.warn(`${kind} ${icao}: HTTP ${res.status} ${await res.text().catch(() => "")}`);
    return null;
  }
  return null;
}

function lastCompleteWeekStart(weeksAgo) {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const sinceMonday = (d.getUTCDay() + 6) % 7; // 0 = Monday
  d.setUTCDate(d.getUTCDate() - sinceMonday - 7 * weeksAgo);
  return d;
}

async function countWeek(ap, weekStart) {
  const arrivals = new Set();
  const departures = new Set();
  let daysOk = 0;
  for (let day = 0; day < 7; day++) {
    const begin = Math.floor(weekStart.getTime() / 1000) + day * 86400;
    const end = begin + 86400 - 1;
    const arr = await fetchDay("arrival", ap.icao, begin, end);
    const dep = await fetchDay("departure", ap.icao, begin, end);
    if (arr && dep) daysOk++;
    (arr || []).forEach((f) => arrivals.add(`${f.icao24}|${f.lastSeen}`));
    (dep || []).forEach((f) => departures.add(`${f.icao24}|${f.firstSeen}`));
    await sleep(300);
  }
  const movements = arrivals.size + departures.size;
  return {
    week_start: weekStart.toISOString().slice(0, 10),
    airport: ap.code,
    arrivals: arrivals.size,
    departures: departures.size,
    movements,
    est_passengers: ap.ratio ? Math.round(movements * ap.ratio) : null,
    pax_per_flight: ap.ratio ? Math.round(ap.ratio * 10) / 10 : null,
    ratio_basis: ap.basis,
    days_ok: daysOk,
    fetched_at: new Date().toISOString(),
  };
}

async function main() {
  const rows = [];
  for (let w = WEEKS_BACK; w >= 1; w--) {
    const weekStart = lastCompleteWeekStart(w);
    for (const ap of AIRPORTS) {
      const row = await countWeek(ap, weekStart);
      console.log(`${row.week_start} ${row.airport}: ${row.arrivals} arrivals + ${row.departures} departures = ${row.movements} flights` +
        `${row.est_passengers != null ? `, ~${row.est_passengers.toLocaleString("en-US")} passengers` : ""} (${row.days_ok}/7 days complete)`);
      rows.push(row);
    }
  }

  const usable = rows.filter((r) => r.days_ok > 0);
  if (!usable.length) {
    console.error("OpenSky returned no data for any airport/day; nothing saved. It may not have processed these days yet — try again later.");
    process.exit(1);
  }

  const res = await fetch(`${SUPABASE_URL}/rest/v1/tracked_weekly?on_conflict=week_start,airport`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      ...(SUPABASE_SERVICE_KEY.startsWith("eyJ") ? { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } : {}),
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify(usable),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`Supabase save failed: HTTP ${res.status} ${text}`);
    process.exit(1);
  }
  console.log(`Saved ${JSON.parse(text).length} airport-weeks to Supabase.`);
  if (usable.some((r) => r.days_ok < 7)) console.warn("Some weeks are partial (fewer than 7 complete days); the dashboard marks them.");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

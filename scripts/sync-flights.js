// Pulls the number of inbound flights currently airborne to each UAE hub from
// AviationStack and saves it to Supabase (dashboard_config, row id = 1).
// Runs from the "Sync UAE Aviation Data" GitHub Action. Node 20+ (built-in fetch).

const SUPABASE_URL = process.env.SUPABASE_URL || "https://stdxueftoewwnhbqncbo.supabase.co";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const AVIATIONSTACK_KEY = process.env.AVIATIONSTACK_KEY;
const HUBS = ["DXB", "AUH", "SHJ", "DWC"];

if (!SUPABASE_SERVICE_KEY || !AVIATIONSTACK_KEY) {
  console.error("Missing secret: SUPABASE_SERVICE_KEY and AVIATIONSTACK_KEY must both be set in the repo's Actions secrets.");
  process.exit(1);
}

async function fetchHub(iata) {
  const url = new URL("https://api.aviationstack.com/v1/flights");
  url.searchParams.set("access_key", AVIATIONSTACK_KEY);
  url.searchParams.set("arr_iata", iata);
  url.searchParams.set("flight_status", "active");
  url.searchParams.set("limit", "1"); // only the total count is needed

  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error || !body.pagination) {
    const reason = body.error ? `${body.error.code}: ${body.error.message || body.error.info}` : `HTTP ${res.status}`;
    throw new Error(`AviationStack ${iata} failed (${reason})`);
  }
  return body.pagination.total;
}

async function main() {
  const counts = {};
  const failures = [];
  for (const hub of HUBS) {
    try {
      counts[hub] = await fetchHub(hub);
    } catch (err) {
      failures.push(err.message);
      counts[hub] = null;
    }
  }
  failures.forEach((f) => console.warn(f));
  if (failures.length === HUBS.length) {
    console.error("Every AviationStack request failed; Supabase not updated.");
    process.exit(1);
  }

  const total = HUBS.reduce((sum, h) => sum + (counts[h] || 0), 0);
  console.log(`Airborne inbound — DXB: ${counts.DXB}, AUH: ${counts.AUH}, SHJ: ${counts.SHJ}, DWC: ${counts.DWC}, total: ${total}`);

  const res = await fetch(`${SUPABASE_URL}/rest/v1/dashboard_config?id=eq.1`, {
    method: "PATCH",
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      live_active_flights: total,
      live_dxb: counts.DXB,
      live_auh: counts.AUH,
      live_shj: counts.SHJ,
      live_dwc: counts.DWC,
      live_updated_at: new Date().toISOString(),
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error(`Supabase update failed: HTTP ${res.status} ${text}`);
    process.exit(1);
  }
  const rows = JSON.parse(text || "[]");
  if (!rows.length) {
    console.error("Supabase update matched no rows (expected dashboard_config id = 1).");
    process.exit(1);
  }
  console.log("Supabase updated.");
  if (failures.length) process.exit(1); // partial data saved, but flag the run
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

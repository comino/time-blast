#!/usr/bin/env node
// Fetch and convert the public datasets used by the generality evals (docs/batch-3/generality.md).
//
//   node scripts/fetch-datasets.mjs [weather|flights|cities|all] [--force]
//
// Downloads raw files into .cache/datasets/ (ignored by git), converts them with DuckDB-Wasm's
// node-blocking bundle (the same engine build as the browser; no new dependencies) and writes
// public/data/<dataset>/<table>.parquet. Rows are sorted and the Parquet settings fixed, so a
// rerun over the same raw files gives the same tables. The raw sources can change upstream
// (e.g. BTS revises a month); the committed Parquet files are the reference for the evals.
//
// Sources and licenses (also in public/data/datasets.json):
//   weather  Open-Meteo historical weather API (ERA5 reanalysis), CC BY 4.0
//   flights  US DOT BTS "Reporting Carrier On-Time Performance" (public domain, US government work);
//            airports from OurAirports (public domain); carrier names from BTS's carrier code list
//   cities   GeoNames cities15000 + countryInfo, CC BY 4.0
import { createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readSync, chmodSync, closeSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createInflateRaw } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cache = resolve(root, '.cache/datasets');
const args = process.argv.slice(2);
const force = args.includes('--force');
const which = args.find(a => !a.startsWith('--')) ?? 'all';
mkdirSync(cache, { recursive: true });

// ───────────────────────── helpers ─────────────────────────

async function download(url, name) {
  const file = resolve(cache, name);
  if (existsSync(file) && !force) return file;
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, { headers: { 'user-agent': 'time-blast dataset fetch (research; github.com/comino/time-blast)' } });
    if (response.ok) {
      const tmp = `${file}.part`;
      await pipeline(response.body, createWriteStream(tmp));
      renameSync(tmp, file);
      console.error(`fetched ${name} (${(statSync(file).size / 1e6).toFixed(1)} MB)`);
      return file;
    }
    if (attempt >= 4 || (response.status !== 429 && response.status < 500)) throw new Error(`${url}: HTTP ${response.status}`);
    await new Promise(r => setTimeout(r, 5000 * attempt));
  }
}

/** Extract one member of a zip file (stored or deflated), streaming. Minimal: reads the central directory. */
async function unzip(zipPath, match, outName) {
  const out = resolve(cache, outName);
  if (existsSync(out) && !force) return out;
  const fd = openSync(zipPath, 'r');
  const size = statSync(zipPath).size;
  const tailLength = Math.min(size, 65_557);
  const tail = Buffer.alloc(tailLength);
  readSync(fd, tail, 0, tailLength, size - tailLength);
  const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error(`${zipPath}: not a zip file`);
  const entries = tail.readUInt16LE(eocd + 10), cdSize = tail.readUInt32LE(eocd + 12), cdOffset = tail.readUInt32LE(eocd + 16);
  const cd = Buffer.alloc(cdSize);
  readSync(fd, cd, 0, cdSize, cdOffset);
  let p = 0, found;
  for (let i = 0; i < entries; i++) {
    const method = cd.readUInt16LE(p + 10), compressed = cd.readUInt32LE(p + 20);
    const nameLength = cd.readUInt16LE(p + 28), extra = cd.readUInt16LE(p + 30), comment = cd.readUInt16LE(p + 32);
    const local = cd.readUInt32LE(p + 42);
    const name = cd.toString('utf8', p + 46, p + 46 + nameLength);
    if (match.test(name)) { found = { name, method, compressed, local }; break; }
    p += 46 + nameLength + extra + comment;
  }
  if (!found) throw new Error(`${zipPath}: no member matches ${match}`);
  const header = Buffer.alloc(30);
  readSync(fd, header, 0, 30, found.local);
  closeSync(fd);
  const start = found.local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  const input = createReadStream(zipPath, { start, end: start + found.compressed - 1 });
  const tmp = `${out}.part`;
  if (found.method === 0) await pipeline(input, createWriteStream(tmp));
  else if (found.method === 8) await pipeline(input, createInflateRaw(), createWriteStream(tmp));
  else throw new Error(`${zipPath}: compression method ${found.method} not supported`);
  renameSync(tmp, out);
  console.error(`extracted ${found.name} → ${outName} (${(statSync(out).size / 1e6).toFixed(1)} MB)`);
  return out;
}

let duck;
async function duckdb() {
  if (duck) return duck;
  const require = createRequire(import.meta.url);
  const bundle = require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs');
  const dist = bundle.replace(/[^/]+$/, '');
  const lib = require(bundle);
  const db = await lib.createDuckDB({
    mvp: { mainModule: `${dist}duckdb-mvp.wasm`, mainWorker: '' },
    eh: { mainModule: `${dist}duckdb-eh.wasm`, mainWorker: '' },
  }, new lib.VoidLogger(), lib.NODE_RUNTIME);
  await db.instantiate();
  db.open({});
  const conn = db.connect();
  conn.query("SET memory_limit = '1GB'");
  conn.query('LOAD parquet'); // fetched from extensions.duckdb.org, like in the browser
  duck = {
    query: sql => conn.query(sql),
    rows: sql => conn.query(sql).toArray().map(r => r.toJSON()),
  };
  return duck;
}

const q = s => `'${String(s).replaceAll("'", "''")}'`;

/** Write `select` (must be sorted) as Parquet: zstd, 122,880-row groups (DuckDB's default). */
async function writeParquet(dataset, table, select) {
  const db = await duckdb();
  const dir = resolve(root, 'public/data', dataset);
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `${table}.parquet`);
  // DuckDB-Wasm's node runtime does not truncate an existing file: a shorter new Parquet file would
  // keep the old footer (and read back as the old data). Remove it first.
  rmSync(file, { force: true });
  db.query(`COPY (${select}) TO ${q(file)} (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 122880)`);
  chmodSync(file, 0o644); // the node runtime creates files 0600
  const [{ n }] = db.rows(`SELECT count(*)::INTEGER AS n FROM read_parquet(${q(file)})`);
  console.error(`wrote public/data/${dataset}/${table}.parquet: ${n} rows, ${(statSync(file).size / 1e6).toFixed(2)} MB`);
  return { name: table, url: `data/${dataset}/${table}.parquet`, rows: n };
}

// ───────────────────────── weather (Open-Meteo, CC BY 4.0) ─────────────────────────

const WEATHER_CITIES = [
  ['Berlin', 'Germany', 52.52, 13.41], ['Hamburg', 'Germany', 53.55, 9.99], ['Munich', 'Germany', 48.14, 11.58],
  ['Copenhagen', 'Denmark', 55.68, 12.57], ['Oslo', 'Norway', 59.91, 10.75], ['Stockholm', 'Sweden', 59.33, 18.07],
  ['London', 'United Kingdom', 51.51, -0.13], ['Paris', 'France', 48.85, 2.35], ['Madrid', 'Spain', 40.42, -3.70],
  ['Rome', 'Italy', 41.89, 12.48], ['Vienna', 'Austria', 48.21, 16.37], ['Warsaw', 'Poland', 52.23, 21.01],
];
const WEATHER_VARS = ['temperature_2m', 'relative_humidity_2m', 'precipitation', 'wind_speed_10m', 'cloud_cover', 'pressure_msl'];

async function weather() {
  const parts = [];
  for (const [city, country, la, lo] of WEATHER_CITIES) {
    const url = 'https://archive-api.open-meteo.com/v1/archive?' + new URLSearchParams({
      latitude: String(la), longitude: String(lo), start_date: '2023-01-01', end_date: '2024-12-31',
      hourly: WEATHER_VARS.join(','), timezone: 'GMT', wind_speed_unit: 'kmh',
    });
    const file = await download(url, `weather-${city.toLowerCase()}.json`);
    parts.push({ city, country, file });
  }
  // JSON column arrays → rows, in JS (cold path, ~210k rows), then CSV for DuckDB.
  const lines = ['time,city,country,temperature,humidity,precipitation,wind_speed,cloud_cover,pressure'];
  for (const { city, country, file } of parts) {
    const h = JSON.parse(readFileSync(file, 'utf8')).hourly;
    for (let i = 0; i < h.time.length; i++) {
      const v = WEATHER_VARS.map(k => h[k][i] ?? '');
      lines.push(`${h.time[i].replace('T', ' ')}:00,${city},${country},${v.join(',')}`);
    }
  }
  const csv = resolve(cache, 'weather.csv');
  writeFileSync(csv, lines.join('\n') + '\n');
  const table = await writeParquet('weather', 'weather', `SELECT time::TIMESTAMP AS time, city, country,
      temperature::DOUBLE AS temperature, humidity::DOUBLE AS humidity, precipitation::DOUBLE AS precipitation,
      wind_speed::DOUBLE AS wind_speed, cloud_cover::DOUBLE AS cloud_cover, pressure::DOUBLE AS pressure
    FROM read_csv(${q(csv)}, header = true, all_varchar = true) ORDER BY time, city`);
  return {
    name: 'weather',
    title: 'Hourly weather in 12 European cities, 2023–2024',
    description: 'Hourly weather (ERA5 reanalysis via Open-Meteo) for 12 European cities, 2023-01-01 to 2024-12-31 UTC. '
      + 'temperature °C at 2 m, humidity % relative, precipitation mm in the preceding hour, wind_speed km/h at 10 m, '
      + 'cloud_cover % of sky, pressure hPa at mean sea level.',
    tables: [table],
    license: 'CC BY 4.0 (Open-Meteo; ERA5 data: Copernicus Climate Change Service)',
    source: 'https://open-meteo.com/en/docs/historical-weather-api (fetched by scripts/fetch-datasets.mjs)',
  };
}

// ───────────────────────── flights (BTS on-time performance, public domain) ─────────────────────────

const FLIGHTS_MONTH = [2024, 6];
/** BTS carrier codes in the month (names from BTS's L_UNIQUE_CARRIERS list). */
const CARRIERS = [
  ['9E', 'Endeavor Air Inc.'], ['AA', 'American Airlines Inc.'], ['AS', 'Alaska Airlines Inc.'], ['B6', 'JetBlue Airways'],
  ['DL', 'Delta Air Lines Inc.'], ['F9', 'Frontier Airlines Inc.'], ['G4', 'Allegiant Air'], ['HA', 'Hawaiian Airlines Inc.'],
  ['MQ', 'Envoy Air'], ['NK', 'Spirit Air Lines'], ['OH', 'PSA Airlines Inc.'], ['OO', 'SkyWest Airlines Inc.'],
  ['UA', 'United Air Lines Inc.'], ['WN', 'Southwest Airlines Co.'], ['YX', 'Republic Airline'],
];

async function flights() {
  const [year, month] = FLIGHTS_MONTH;
  const zip = await download(`https://transtats.bts.gov/PREZIP/On_Time_Reporting_Carrier_On_Time_Performance_1987_present_${year}_${month}.zip`, `bts-${year}-${month}.zip`);
  const csv = await unzip(zip, /\.csv$/i, `bts-${year}-${month}.csv`);
  const airportsCsv = await download('https://davidmegginson.github.io/ourairports-data/airports.csv', 'ourairports-airports.csv');
  const db = await duckdb();
  // HHMM local clock times ('2400' = midnight at the end of the day) → TIMESTAMP on the flight date.
  const clock = col => `(FlightDate::DATE + to_minutes((${col}::INTEGER // 100) * 60 + ${col}::INTEGER % 100))`;
  db.query(`CREATE OR REPLACE TABLE bts AS SELECT * FROM read_csv(${q(csv)}, header = true, all_varchar = true)`);
  const codes = db.rows('SELECT DISTINCT Reporting_Airline AS c FROM bts ORDER BY 1').map(r => r.c);
  const missing = codes.filter(c => !CARRIERS.some(([code]) => code === c));
  if (missing.length) throw new Error(`carrier names missing for ${missing.join(', ')}`);
  const num = col => `TRY_CAST(${col} AS DOUBLE)`;
  const flightsTable = await writeParquet('flights', 'flights', `SELECT
      FlightDate::DATE AS flight_date,
      ${clock('CRSDepTime')} AS scheduled_departure,
      Reporting_Airline AS carrier,
      Flight_Number_Reporting_Airline::INTEGER AS flight_number,
      NULLIF(Tail_Number, '') AS tail_number,
      Origin AS origin, Dest AS dest,
      ${num('DepDelay')} AS dep_delay, ${num('ArrDelay')} AS arr_delay,
      ${num('TaxiOut')} AS taxi_out, ${num('TaxiIn')} AS taxi_in,
      ${num('AirTime')} AS air_time, ${num('Distance')} AS distance,
      Cancelled::DOUBLE::INTEGER = 1 AS cancelled,
      CASE CancellationCode WHEN 'A' THEN 'carrier' WHEN 'B' THEN 'weather' WHEN 'C' THEN 'national air system' WHEN 'D' THEN 'security' END AS cancellation_reason,
      Diverted::DOUBLE::INTEGER = 1 AS diverted,
      ${num('CarrierDelay')} AS carrier_delay, ${num('WeatherDelay')} AS weather_delay, ${num('NASDelay')} AS nas_delay,
      ${num('SecurityDelay')} AS security_delay, ${num('LateAircraftDelay')} AS late_aircraft_delay
    FROM bts ORDER BY scheduled_departure, carrier, flight_number, origin`);
  const carriersTable = await writeParquet('flights', 'carriers',
    `SELECT * FROM (VALUES ${CARRIERS.map(([c, n]) => `(${q(c)}, ${q(n)})`).join(', ')}) AS t(code, name) WHERE code IN (${codes.map(q).join(', ')}) ORDER BY code`);
  // Airports by IATA code; else by ICAO ident 'K' + code (US airports whose IATA code changed later, e.g. PBI).
  db.query('CREATE OR REPLACE TABLE used AS SELECT Origin AS code FROM bts UNION SELECT Dest FROM bts');
  db.query('DROP TABLE bts');
  db.query(`CREATE OR REPLACE TABLE raw AS SELECT * FROM read_csv(${q(airportsCsv)}, header = true, all_varchar = true)`);
  const airportsTable = await writeParquet('flights', 'airports', `WITH
    cand AS (SELECT u.code, raw.*, 0 AS via FROM used u JOIN raw ON raw.iata_code = u.code
             UNION ALL SELECT u.code, raw.*, 1 AS via FROM used u JOIN raw ON raw.ident = 'K' || u.code),
    oa AS (SELECT code, arg_min(name, k) AS name, arg_min(municipality, k) AS city, arg_min(iso_region, k) AS region, arg_min(latitude_deg, k) AS lat, arg_min(longitude_deg, k) AS lon, arg_min(elevation_ft, k) AS elevation
           FROM (SELECT *, (via, CASE type WHEN 'large_airport' THEN 0 WHEN 'medium_airport' THEN 1 ELSE 2 END, ident) AS k FROM cand) GROUP BY code)
    SELECT u.code, oa.name, oa.city, regexp_replace(oa.region, '^[A-Z]+-', '') AS state,
           oa.lat::DOUBLE AS lat, oa.lon::DOUBLE AS lon, TRY_CAST(oa.elevation AS INTEGER) AS elevation_ft
    FROM used u LEFT JOIN oa ON oa.code = u.code ORDER BY u.code`);
  const [{ unmatched }] = db.rows(`SELECT count(*)::INTEGER AS unmatched FROM read_parquet(${q(resolve(root, 'public/data/flights/airports.parquet'))}) WHERE name IS NULL`);
  if (unmatched) console.error(`warning: ${unmatched} airport codes without an OurAirports match`);
  db.query('DROP TABLE used; DROP TABLE raw');
  return {
    name: 'flights',
    title: `US domestic flights, ${year}-${String(month).padStart(2, '0')}`,
    description: `Every domestic flight of the reporting US carriers in ${new Date(Date.UTC(year, month - 1)).toLocaleString('en', { month: 'long', timeZone: 'UTC' })} ${year} (BTS on-time data). `
      + 'scheduled_departure is local time at the origin; delays, taxi and air times in minutes (negative delay = early); distance in miles. '
      + 'flights.carrier = carriers.code; flights.origin and flights.dest = airports.code.',
    tables: [flightsTable, carriersTable, airportsTable],
    license: 'Public domain (US DOT Bureau of Transportation Statistics; OurAirports data is public domain)',
    source: 'https://www.transtats.bts.gov/Fields.asp?gnoyr_VQ=FGJ and https://ourairports.com/data/ (fetched by scripts/fetch-datasets.mjs)',
  };
}

// ───────────────────────── cities (GeoNames, CC BY 4.0) ─────────────────────────

const CONTINENTS = { AF: 'Africa', AN: 'Antarctica', AS: 'Asia', EU: 'Europe', NA: 'North America', OC: 'Oceania', SA: 'South America' };

async function cities() {
  const zip = await download('https://download.geonames.org/export/dump/cities15000.zip', 'cities15000.zip');
  const txt = await unzip(zip, /cities15000\.txt$/, 'cities15000.txt');
  const info = await download('https://download.geonames.org/export/dump/countryInfo.txt', 'countryInfo.txt');
  const countryLines = readFileSync(info, 'utf8').split('\n').filter(l => l && !l.startsWith('#'));
  const countriesCsv = resolve(cache, 'countries.tsv');
  writeFileSync(countriesCsv, countryLines.map(l => l.split('\t').slice(0, 11).join('\t')).join('\n') + '\n');
  const citiesTable = await writeParquet('cities', 'cities', `SELECT column01 AS name, column08 AS country_code, column07 AS feature_code,
      column14::BIGINT AS population, TRY_CAST(column16 AS INTEGER) AS elevation, column17 AS timezone,
      column04::DOUBLE AS lat, column05::DOUBLE AS lon
    FROM read_csv(${q(txt)}, delim = '\t', header = false, quote = '', escape = '', all_varchar = true,
                  columns = {${Array.from({ length: 19 }, (_, i) => `'column${String(i).padStart(2, '0')}': 'VARCHAR'`).join(', ')}})
    ORDER BY country_code, name, column00::BIGINT`);
  const continent = `CASE column08 ${Object.entries(CONTINENTS).map(([k, v]) => `WHEN ${q(k)} THEN ${q(v)}`).join(' ')} END`;
  const countriesTable = await writeParquet('cities', 'countries', `SELECT column00 AS code, column04 AS name, ${continent} AS continent,
      NULLIF(column05, '') AS capital, TRY_CAST(column06 AS DOUBLE) AS area_km2, TRY_CAST(column07 AS BIGINT) AS population,
      NULLIF(column10, '') AS currency
    FROM read_csv(${q(countriesCsv)}, delim = '\t', header = false, quote = '', escape = '', all_varchar = true,
                  columns = {${Array.from({ length: 11 }, (_, i) => `'column${String(i).padStart(2, '0')}': 'VARCHAR'`).join(', ')}})
    ORDER BY code`);
  return {
    name: 'cities',
    title: 'World cities over 15,000 inhabitants',
    description: 'Every populated place with at least 15,000 inhabitants (GeoNames cities15000) and every country. '
      + 'cities.country_code = countries.code. feature_code: PPLC capital, PPLA first-order admin seat, PPLA2..4 lower seats, PPL other place. '
      + 'elevation in metres (digital elevation model), area_km2 in km², population in people.',
    tables: [citiesTable, countriesTable],
    license: 'CC BY 4.0 (GeoNames, https://www.geonames.org)',
    source: 'https://download.geonames.org/export/dump/ cities15000.zip and countryInfo.txt (fetched by scripts/fetch-datasets.mjs)',
  };
}

// ───────────────────────── main ─────────────────────────

const builders = { weather, flights, cities };
const names = which === 'all' ? Object.keys(builders) : [which];
const manifestPath = resolve(root, 'public/data/datasets.json');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : [];
for (const name of names) {
  if (!builders[name]) { console.error(`unknown dataset ${name}; one of ${Object.keys(builders).join(', ')}, all`); process.exit(2); }
  const entry = await builders[name]();
  const i = manifest.findIndex(e => e.name === name);
  if (i >= 0) manifest[i] = { ...manifest[i], ...entry }; else manifest.push(entry);
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.error(`updated public/data/datasets.json (${manifest.map(e => e.name).join(', ')})`);
process.exit(0);

#!/usr/bin/env node
// Fetch and convert the public datasets (docs/batch-3/generality.md).
//
//   node scripts/fetch-datasets.mjs [weather|flights|cities|flights-2024|nyc-taxi|all] [--force] [--keep-raw]
//   node scripts/fetch-datasets.mjs nyc-taxi-server [--out ../time-blast-data/nyc-taxi.duckdb]
//       [--from 2022-01] [--to 2024-12] [--taxi yellow,green] [--raw <dir for the TLC files>] [--meta-only]
//
// Downloads raw files into .cache/datasets/ (ignored by git), converts them with DuckDB-Wasm's
// node-blocking bundle (the same engine build as the browser; no new dependencies) and writes
// public/data/<dataset>/<table>.parquet. The large datasets (flights-2024, nyc-taxi) are converted
// by the DuckDB CLI of the engine's version (v1.4.3; PATH, $DUCKDB_CLI, --duckdb, or
// --fetch-duckdb, as in scripts/build-datasets.mjs), are not committed, and open in the browser
// from a prebuilt DuckDB file: run `node scripts/build-datasets.mjs --only <name>` afterwards.
// `all` is the committed small datasets; the large ones are built by name. nyc-taxi-server writes a
// DuckDB database for a server-side DuckDB outside the repo and does not touch the manifest. Rows are sorted and the Parquet settings fixed, so a
// rerun over the same raw files gives the same tables. The raw sources can change upstream
// (e.g. BTS revises a month); the committed Parquet files are the reference for the evals.
//
// Sources and licenses (also in public/data/datasets.json):
//   weather  Open-Meteo historical weather API (ERA5 reanalysis), CC BY 4.0
//   flights  US DOT BTS "Reporting Carrier On-Time Performance" (public domain, US government work);
//            airports from OurAirports (public domain); carrier names from BTS's carrier code list
//   cities   GeoNames cities15000 + countryInfo, CC BY 4.0
//   nyc-taxi NYC TLC Trip Record Data (NYC Open Data) and the TLC taxi zone lookup/shapefile
import { spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readSync, chmodSync, closeSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createInflateRaw } from 'node:zlib';
import { runnerImport } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cache = resolve(root, '.cache/datasets');
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const force = args.includes('--force');
const keepRaw = args.includes('--keep-raw');
const which = args.find((a, i) => !a.startsWith('--') && !(i > 0 && /^--(out|from|to|taxi|raw|duckdb)$/.test(args[i - 1]))) ?? 'all';
mkdirSync(cache, { recursive: true });

// ───────────────────────── helpers ─────────────────────────

async function download(url, name, dir = cache) {
  const file = resolve(dir, name);
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

// The DuckDB CLI for the large datasets: native, multi-threaded, spills to disk.
const CLI_VERSION = 'v1.4.3';
let cliPath;
async function findCli() {
  const { module: lib } = await runnerImport(resolve(root, 'scripts/build-datasets-lib.ts'), { root, configFile: false, logLevel: 'error' });
  if (lib.CLI_VERSION !== CLI_VERSION) throw new Error(`build-datasets-lib CLI ${lib.CLI_VERSION} != ${CLI_VERSION}`);
  cliPath = await lib.duckdbCli(resolve(root, '.cache'), { explicit: option('--duckdb'), fetch: args.includes('--fetch-duckdb') });
}
const CLI_SETTINGS = [
  `SET threads = ${Math.min(4, cpus().length)};`, "SET memory_limit = '2GB';", 'SET preserve_insertion_order = true;',
  `SET temp_directory = ${q(resolve(cache, 'duckdb-tmp'))};`,
].join(' ');
/** Run a script in the CLI (in memory, or on `database`); stdout as text. */
function cli(sql, database = ':memory:', mode = []) {
  if (!cliPath) throw new Error('findCli() first');
  const run = spawnSync(cliPath, ['-bail', '-batch', ...mode, database], { input: `${CLI_SETTINGS}\n${sql}`, encoding: 'utf8', maxBuffer: 256 << 20 });
  if (run.status !== 0) throw new Error(`duckdb CLI failed (${run.status}): ${(run.stderr || run.stdout).slice(0, 2000)}`);
  return run.stdout;
}
/** Rows of the script's last statement, as objects (CLI JSON mode). */
function cliRows(sql, database) {
  const out = cli(sql, database, ['-json']).trim();
  if (!out) return [];
  const last = out.lastIndexOf('\n[');
  return JSON.parse(last >= 0 ? out.slice(last + 1) : out);
}
/** writeParquet with the CLI; `setup` statements run first in the same session. */
function cliParquet(dataset, table, select, setup = []) {
  const dir = resolve(root, 'public/data', dataset);
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `${table}.parquet`);
  const tmp = `${file}.tmp`;
  const t0 = performance.now();
  cli([...setup, `COPY (${select}) TO ${q(tmp)} (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 122880);`].join('\n'));
  renameSync(tmp, file);
  chmodSync(file, 0o644);
  const [{ n }] = cliRows(`SELECT count(*)::BIGINT AS n FROM read_parquet(${q(file)})`);
  console.error(`wrote public/data/${dataset}/${table}.parquet: ${n} rows, ${(statSync(file).size / 1e6).toFixed(2)} MB, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  return { name: table, url: `data/${dataset}/${table}.parquet`, rows: Number(n) };
}

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

/** The cleaned `flights` columns from BTS's CSV columns (all VARCHAR) in `source`. */
function flightsSelect(source) {
  // HHMM local clock times ('2400' = midnight at the end of the day) → TIMESTAMP on the flight date.
  const clock = col => `(FlightDate::DATE + to_minutes((${col}::INTEGER // 100) * 60 + ${col}::INTEGER % 100))`;
  const num = col => `TRY_CAST(${col} AS DOUBLE)`;
  return `SELECT
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
    FROM ${source} ORDER BY scheduled_departure, carrier, flight_number, origin`;
}

/** The `carriers` table for the carrier codes in use. */
function carriersSelect(codes) {
  const missing = codes.filter(c => !CARRIERS.some(([code]) => code === c));
  if (missing.length) throw new Error(`carrier names missing for ${missing.join(', ')}`);
  return `SELECT * FROM (VALUES ${CARRIERS.map(([c, n]) => `(${q(c)}, ${q(n)})`).join(', ')}) AS t(code, name) WHERE code IN (${codes.map(q).join(', ')}) ORDER BY code`;
}

/** The `airports` table for the codes in table `used` (column code), from OurAirports table `raw`:
 * by IATA code; else by ICAO ident 'K' + code (US airports whose IATA code changed later, e.g. PBI). */
const AIRPORTS_SELECT = `WITH
    cand AS (SELECT u.code, raw.*, 0 AS via FROM used u JOIN raw ON raw.iata_code = u.code
             UNION ALL SELECT u.code, raw.*, 1 AS via FROM used u JOIN raw ON raw.ident = 'K' || u.code),
    oa AS (SELECT code, arg_min(name, k) AS name, arg_min(municipality, k) AS city, arg_min(iso_region, k) AS region, arg_min(latitude_deg, k) AS lat, arg_min(longitude_deg, k) AS lon, arg_min(elevation_ft, k) AS elevation
           FROM (SELECT *, (via, CASE type WHEN 'large_airport' THEN 0 WHEN 'medium_airport' THEN 1 ELSE 2 END, ident) AS k FROM cand) GROUP BY code)
    SELECT u.code, oa.name, oa.city, regexp_replace(oa.region, '^[A-Z]+-', '') AS state,
           oa.lat::DOUBLE AS lat, oa.lon::DOUBLE AS lon, TRY_CAST(oa.elevation AS INTEGER) AS elevation_ft
    FROM used u LEFT JOIN oa ON oa.code = u.code ORDER BY u.code`;

const FLIGHTS_DESCRIPTION = 'scheduled_departure is local time at the origin; delays, taxi and air times in minutes (negative delay = early); distance in miles. '
  + 'flights.carrier = carriers.code; flights.origin and flights.dest = airports.code.';
const FLIGHTS_LICENSE = 'Public domain (US DOT Bureau of Transportation Statistics; OurAirports data is public domain)';
const FLIGHTS_SOURCE = 'https://www.transtats.bts.gov/Fields.asp?gnoyr_VQ=FGJ and https://ourairports.com/data/ (fetched by scripts/fetch-datasets.mjs)';
const btsZip = (year, month) => download(`https://transtats.bts.gov/PREZIP/On_Time_Reporting_Carrier_On_Time_Performance_1987_present_${year}_${month}.zip`, `bts-${year}-${month}.zip`);

async function flights() {
  const [year, month] = FLIGHTS_MONTH;
  const zip = await btsZip(year, month);
  const csv = await unzip(zip, /\.csv$/i, `bts-${year}-${month}.csv`);
  const airportsCsv = await download('https://davidmegginson.github.io/ourairports-data/airports.csv', 'ourairports-airports.csv');
  const db = await duckdb();
  db.query(`CREATE OR REPLACE TABLE bts AS SELECT * FROM read_csv(${q(csv)}, header = true, all_varchar = true)`);
  const codes = db.rows('SELECT DISTINCT Reporting_Airline AS c FROM bts ORDER BY 1').map(r => r.c);
  const carriers = carriersSelect(codes);
  const flightsTable = await writeParquet('flights', 'flights', flightsSelect('bts'));
  const carriersTable = await writeParquet('flights', 'carriers', carriers);
  db.query('CREATE OR REPLACE TABLE used AS SELECT Origin AS code FROM bts UNION SELECT Dest FROM bts');
  db.query('DROP TABLE bts');
  db.query(`CREATE OR REPLACE TABLE raw AS SELECT * FROM read_csv(${q(airportsCsv)}, header = true, all_varchar = true)`);
  const airportsTable = await writeParquet('flights', 'airports', AIRPORTS_SELECT);
  const [{ unmatched }] = db.rows(`SELECT count(*)::INTEGER AS unmatched FROM read_parquet(${q(resolve(root, 'public/data/flights/airports.parquet'))}) WHERE name IS NULL`);
  if (unmatched) console.error(`warning: ${unmatched} airport codes without an OurAirports match`);
  db.query('DROP TABLE used; DROP TABLE raw');
  return {
    name: 'flights',
    title: `US domestic flights, ${year}-${String(month).padStart(2, '0')}`,
    description: `Every domestic flight of the reporting US carriers in ${new Date(Date.UTC(year, month - 1)).toLocaleString('en', { month: 'long', timeZone: 'UTC' })} ${year} (BTS on-time data). `
      + FLIGHTS_DESCRIPTION,
    tables: [flightsTable, carriersTable, airportsTable],
    license: FLIGHTS_LICENSE,
    source: FLIGHTS_SOURCE,
  };
}

// ───────────────────────── flights-2024 (the whole year; DuckDB CLI) ─────────────────────────

/** Same schema, tables and SQL as `flights`, all twelve months of 2024 (≈7 M rows). Converted by
 * the native DuckDB CLI (v1.4.3, the engine's version): DuckDB-Wasm would hold 7 M rows of 110
 * VARCHAR columns in memory and cannot spill. Browsers open it from the prebuilt DuckDB file
 * (scripts/build-datasets.mjs); its Parquet tables are the build input. */
async function flights2024() {
  const year = 2024;
  const csvs = [];
  for (let month = 1; month <= 12; month++) csvs.push(await unzip(await btsZip(year, month), /\.csv$/i, `bts-${year}-${month}.csv`));
  const airportsCsv = await download('https://davidmegginson.github.io/ourairports-data/airports.csv', 'ourairports-airports.csv');
  const name = 'flights-2024';
  const dir = resolve(root, 'public/data', name);
  const out = table => resolve(dir, `${table}.parquet`);
  const columns = ['FlightDate', 'CRSDepTime', 'Reporting_Airline', 'Flight_Number_Reporting_Airline', 'Tail_Number', 'Origin', 'Dest',
    'DepDelay', 'ArrDelay', 'TaxiOut', 'TaxiIn', 'AirTime', 'Distance', 'Cancelled', 'CancellationCode', 'Diverted',
    'CarrierDelay', 'WeatherDelay', 'NASDelay', 'SecurityDelay', 'LateAircraftDelay'];
  const bts = `(SELECT ${columns.join(', ')} FROM read_csv([${csvs.map(q).join(', ')}], header = true, all_varchar = true, union_by_name = true))`;
  const flightsTable = cliParquet(name, 'flights', flightsSelect(bts));
  const codes = cliRows(`SELECT DISTINCT carrier AS c FROM read_parquet(${q(out('flights'))}) ORDER BY 1`).map(r => r.c);
  const carriersTable = cliParquet(name, 'carriers', carriersSelect(codes));
  const airportsTable = cliParquet(name, 'airports', AIRPORTS_SELECT, [
    `CREATE TABLE used AS SELECT origin AS code FROM read_parquet(${q(out('flights'))}) UNION SELECT dest FROM read_parquet(${q(out('flights'))});`,
    `CREATE TABLE raw AS SELECT * FROM read_csv(${q(airportsCsv)}, header = true, all_varchar = true);`,
  ]);
  const [{ unmatched }] = cliRows(`SELECT count(*)::INTEGER AS unmatched FROM read_parquet(${q(out('airports'))}) WHERE name IS NULL`);
  if (unmatched) console.error(`warning: ${unmatched} airport codes without an OurAirports match`);
  if (!keepRaw) for (const csv of csvs) rmSync(csv, { force: true }); // 3 GB; the zips stay cached
  return {
    name,
    title: `US domestic flights, ${year}`,
    description: `Every domestic flight of the reporting US carriers in ${year}, January to December (BTS on-time data). ` + FLIGHTS_DESCRIPTION,
    tables: [flightsTable, carriersTable, airportsTable],
    prebuilt: `data/${name}/${name}.duckdb`,
    license: FLIGHTS_LICENSE,
    source: FLIGHTS_SOURCE,
  };
}

// ───────────────────────── nyc-taxi (NYC TLC trip records; DuckDB CLI) ─────────────────────────

const TLC = 'https://d37ci6vzurychx.cloudfront.net';
/** Months of yellow-cab trips in the browser dataset (≈9.4 M trips after cleaning). */
const TAXI_MONTHS = ['2024-01', '2024-02', '2024-03'];
const months = (from, to) => {
  const out = [];
  for (let [y, m] = from.split('-').map(Number); `${y}-${String(m).padStart(2, '0')}` <= to; m === 12 ? (y++, m = 1) : m++) out.push(`${y}-${String(m).padStart(2, '0')}`);
  return out;
};
const PAYMENT_TYPES = [[0, 'flex fare'], [1, 'credit card'], [2, 'cash'], [3, 'no charge'], [4, 'dispute'], [5, 'unknown'], [6, 'voided']];
const RATE_CODES = [[1, 'standard'], [2, 'JFK'], [3, 'Newark'], [4, 'Nassau or Westchester'], [5, 'negotiated'], [6, 'group ride']];
const decode = (col, pairs) => `CASE ${col} ${pairs.map(([k, v]) => `WHEN ${k} THEN ${q(v)}`).join(' ')} END`;

/** Cleaned trips from TLC monthly files [{taxi: 'yellow'|'green', month: 'YYYY-MM', file}], sorted
 * by pickup time. Dropped as broken: pickup outside the file's month (or NULL), dropoff before
 * pickup or more than 24 h after it, trip_distance < 0 or > 500 miles, fare_amount or total_amount
 * negative (refunds and voided records) or above $5,000. */
function taxiTripsSelect(files) {
  const part = (taxi, list) => {
    if (!list.length) return [];
    const p = taxi === 'yellow' ? 'tpep' : 'lpep';
    const airport = taxi === 'yellow' ? 'airport_fee' : 'NULL';
    return [`SELECT ${q(taxi)} AS taxi_type,
        VendorID::SMALLINT AS vendor_id,
        ${p}_pickup_datetime::TIMESTAMP AS pickup_time,
        ${p}_dropoff_datetime::TIMESTAMP AS dropoff_time,
        PULocationID::SMALLINT AS pickup_zone_id,
        DOLocationID::SMALLINT AS dropoff_zone_id,
        passenger_count::SMALLINT AS passenger_count,
        trip_distance::DOUBLE AS trip_distance,
        ${decode('RatecodeID::INTEGER', RATE_CODES)} AS rate_code,
        ${decode('payment_type::INTEGER', PAYMENT_TYPES)} AS payment_type,
        fare_amount::DOUBLE AS fare_amount, extra::DOUBLE AS extra, mta_tax::DOUBLE AS mta_tax,
        tip_amount::DOUBLE AS tip_amount, tolls_amount::DOUBLE AS tolls_amount,
        improvement_surcharge::DOUBLE AS improvement_surcharge, congestion_surcharge::DOUBLE AS congestion_surcharge,
        ${airport}::DOUBLE AS airport_fee, total_amount::DOUBLE AS total_amount,
        (regexp_extract(filename, '(\\d{4}-\\d{2})\\.parquet$', 1) || '-01')::TIMESTAMP AS __month
      FROM read_parquet([${list.map(f => q(f.file)).join(', ')}], filename = true, union_by_name = true)`];
  };
  const union = [...part('yellow', files.filter(f => f.taxi === 'yellow')), ...part('green', files.filter(f => f.taxi === 'green'))].join('\n    UNION ALL ');
  return `SELECT * EXCLUDE (__month) FROM (${union})
    WHERE pickup_time >= __month AND pickup_time < __month + INTERVAL 1 MONTH
      AND dropoff_time >= pickup_time AND dropoff_time <= pickup_time + INTERVAL 1 DAY
      AND trip_distance BETWEEN 0 AND 500
      AND fare_amount BETWEEN 0 AND 5000 AND total_amount BETWEEN 0 AND 5000
    ORDER BY pickup_time, dropoff_time, pickup_zone_id, dropoff_zone_id, total_amount`;
}

/** The zone lookup with zone centroids (WGS84) computed from the TLC zone shapefile (EPSG:2263,
 * NY Long Island ft) with DuckDB spatial; zones 264/265 (unknown, outside NYC) have no shape.
 * Without the spatial extension lat/lon are NULL. Returns [setup statements, select]. */
async function taxiZones(dir) {
  const lookup = await download(`${TLC}/misc/taxi_zone_lookup.csv`, 'taxi_zone_lookup.csv', dir);
  const shapes = await download(`${TLC}/misc/taxi_zones.zip`, 'taxi_zones.zip', dir);
  let spatial = true;
  try { cliRows("INSTALL spatial; LOAD spatial; SELECT 1 AS ok"); } catch (e) { spatial = false; console.error(`warning: DuckDB spatial unavailable, zones without lat/lon: ${e.message.slice(0, 200)}`); }
  const setup = [
    `CREATE TABLE zone_lookup AS SELECT LocationID::SMALLINT AS zone_id, Borough AS borough, Zone AS zone, service_zone FROM read_csv(${q(lookup)}, header = true, all_varchar = true);`,
    spatial
      ? `LOAD spatial; CREATE TABLE zone_centroids AS SELECT zone_id, ST_Transform(ST_Centroid(g), 'EPSG:2263', 'EPSG:4326', always_xy := true) AS p
           FROM (SELECT LocationID::SMALLINT AS zone_id, ST_Union_Agg(geom) AS g FROM ST_Read(${q(`/vsizip/${shapes}/taxi_zones/taxi_zones.shp`)}) GROUP BY 1);`
      : 'CREATE TABLE zone_centroids AS SELECT NULL::SMALLINT AS zone_id, NULL AS p WHERE false;',
  ];
  const select = `SELECT z.zone_id, NULLIF(z.borough, 'N/A') AS borough, NULLIF(z.zone, 'N/A') AS zone, NULLIF(z.service_zone, 'N/A') AS service_zone,
      ${spatial ? 'round(ST_Y(c.p), 6)' : 'NULL::DOUBLE'} AS lat, ${spatial ? 'round(ST_X(c.p), 6)' : 'NULL::DOUBLE'} AS lon
    FROM zone_lookup z LEFT JOIN zone_centroids c USING (zone_id) ORDER BY z.zone_id`;
  return { setup, select, spatial };
}

const taxiDescription = (period, types) => `NYC TLC ${types} taxi trip records, ${period} (pickup times are local New York time). `
  + 'One row per trip. Money columns are US dollars: total_amount = fare_amount + extra + mta_tax + tip_amount + tolls_amount + improvement_surcharge '
  + '+ congestion_surcharge + airport_fee (tips are recorded for card payments only; cash tips are missing). trip_distance in miles. '
  + 'Trip duration: date_diff(\'minute\', pickup_time, dropoff_time). trips.pickup_zone_id and trips.dropoff_zone_id = zones.zone_id; '
  + 'zones has borough, zone name, service_zone and the zone centroid lat/lon (NULL for zones 264/265: unknown / outside NYC). '
  + 'Removed as broken: pickups outside the period, dropoff before pickup or over 24 h later, trip_distance over 500 miles, '
  + 'negative fares or totals (refunds, voided records) and totals over $5,000.';
const TAXI_LICENSE = 'NYC TLC Trip Record Data, NYC Open Data (public, free to use; https://www.nyc.gov/site/tlc/about/tlc-trip-record-data.page)';

async function nycTaxi() {
  const name = 'nyc-taxi';
  const files = [];
  for (const month of TAXI_MONTHS) files.push({ taxi: 'yellow', month, file: await download(`${TLC}/trip-data/yellow_tripdata_${month}.parquet`, `yellow_tripdata_${month}.parquet`) });
  const zones = await taxiZones();
  const tripsTable = cliParquet(name, 'trips', taxiTripsSelect(files));
  const zonesTable = cliParquet(name, 'zones', zones.select, zones.setup);
  const raw = cliRows(`SELECT count(*)::BIGINT AS n FROM read_parquet([${files.map(f => q(f.file)).join(', ')}])`)[0].n;
  console.error(`nyc-taxi: ${raw} raw trips, ${tripsTable.rows} kept (${raw - tripsTable.rows} dropped as broken)`);
  return {
    name,
    title: 'NYC yellow taxi trips, January–March 2024',
    description: taxiDescription('January to March 2024', 'yellow'),
    tables: [tripsTable, zonesTable],
    prebuilt: `data/${name}/${name}.duckdb`,
    license: TAXI_LICENSE,
    source: `${TLC}/trip-data/yellow_tripdata_YYYY-MM.parquet and ${TLC}/misc/taxi_zone_lookup.csv, taxi_zones.zip (fetched by scripts/fetch-datasets.mjs)`,
  };
}

/** Server database (not in public/, not in the manifest): native DuckDB tables `trips` (sorted by
 * pickup time) and `zones`, plus the dataset context the browser's prebuilt files carry
 * (`__tb_rollup.__tb_meta`, PrebuiltMeta without rollups or catalog), computed with the engine's
 * own statistics SQL (src/engine/dataset.ts). */
async function nycTaxiServer() {
  const outFile = resolve(option('--out') ?? resolve(root, '../time-blast-data/nyc-taxi.duckdb'));
  const from = option('--from') ?? '2022-01', to = option('--to') ?? '2024-12';
  const types = (option('--taxi') ?? 'yellow,green').split(',');
  const rawDir = resolve(option('--raw') ?? resolve(dirname(outFile), 'raw/tlc'));
  mkdirSync(rawDir, { recursive: true });
  const files = [];
  for (const month of months(from, to)) for (const taxi of types) {
    files.push({ taxi, month, file: await download(`${TLC}/trip-data/${taxi}_tripdata_${month}.parquet`, `${taxi}_tripdata_${month}.parquet`, rawDir) });
  }
  const zones = await taxiZones(rawDir);
  const tmp = `${outFile}.tmp`;
  const metaOnly = args.includes('--meta-only'); // recompute the context of an existing file
  if (metaOnly) renameSync(outFile, tmp);
  else {
    rmSync(tmp, { force: true }); rmSync(`${tmp}.wal`, { force: true });
  }
  const t0 = performance.now();
  if (!metaOnly) cli([...zones.setup,
    `CREATE TABLE zones AS ${zones.select};`, 'DROP TABLE zone_lookup; DROP TABLE zone_centroids;',
    `CREATE TABLE trips AS ${taxiTripsSelect(files)};`, 'CHECKPOINT;'].join('\n'), tmp);
  const buildMs = performance.now() - t0;
  // The CLI's JSON mode prints lists as text: wrap each row in to_json to keep the engine's types.
  const jsonRow = (sql, database) => cliRows(`SELECT to_json(r)::VARCHAR AS j FROM (${sql}) r`, database).map(row => JSON.parse(row.j));
  const { module: ds } = await runnerImport(resolve(root, 'src/engine/dataset.ts'), { root, configFile: false, logLevel: 'error' });
  const tables = [];
  const s0 = performance.now();
  for (const table of ['trips', 'zones']) {
    const info = cliRows(`SELECT column_name AS name, data_type AS type FROM duckdb_columns() WHERE table_name = ${q(table)} ORDER BY column_index`, tmp);
    const values = Object.values(jsonRow(ds.statisticsSql(table, info), tmp)[0]);
    const { rows, columns } = ds.applyStatistics(info, values);
    tables.push({ name: table, rows, columns, sample: jsonRow(ds.sampleSql(table, info, 3), tmp).map(Object.values) });
  }
  const statisticsMs = performance.now() - s0;
  const period = `${from} to ${to}`;
  const meta = {
    format: 1, duckdb: CLI_VERSION,
    context: { name: 'nyc-taxi', dialect: 'duckdb', description: taxiDescription(period, types.join(' and ')), tables },
    rollups: [], built: new Date().toISOString(),
  };
  cli(`${metaOnly ? 'DROP SCHEMA IF EXISTS __tb_rollup CASCADE; ' : ''}CREATE SCHEMA __tb_rollup; CREATE TABLE __tb_rollup.__tb_meta AS SELECT ${q(JSON.stringify(meta))} AS meta; CHECKPOINT;`, tmp);
  renameSync(tmp, outFile);
  console.error(`wrote ${outFile}: ${tables.map(t => `${t.name} ${t.rows} rows`).join(', ')}, ${(statSync(outFile).size / 2 ** 30).toFixed(2)} GiB, `
    + `tables ${(buildMs / 1000).toFixed(0)} s, statistics ${(statisticsMs / 1000).toFixed(0)} s`);
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

const builders = { weather, flights, cities, 'flights-2024': flights2024, 'nyc-taxi': nycTaxi };
const LARGE = new Set(['flights-2024', 'nyc-taxi']);
if (which === 'nyc-taxi-server' || [...LARGE].includes(which)) await findCli();
if (which === 'nyc-taxi-server') { await nycTaxiServer(); process.exit(0); }
const names = which === 'all' ? Object.keys(builders).filter(n => !LARGE.has(n)) : [which];
const manifestPath = resolve(root, 'public/data/datasets.json');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : [];
for (const name of names) {
  if (!builders[name]) { console.error(`unknown dataset ${name}; one of ${Object.keys(builders).join(', ')}, all`); process.exit(2); }
  const entry = await builders[name]();
  const i = manifest.findIndex(e => e.name === name);
  if (i >= 0) manifest[i] = { ...manifest[i], ...entry }; else manifest.push(entry);
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 1) + '\n');
console.error(`updated public/data/datasets.json (${manifest.map(e => e.name).join(', ')})`);
process.exit(0);

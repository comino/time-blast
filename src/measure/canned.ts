/** Canned NL→SQL answers of the in-page fake inference node (/measure.html). Same table and
 * echo rule as tests/fake_inference.py, so page and harness numbers mean the same thing. */

const CANNED: ReadonlyArray<readonly [readonly string[], string]> = [
  [['season', 'wheel'], "-- view: seasons\nSELECT time_bucket(INTERVAL 1 MINUTE, ts) AS minute, avg(speed) AS speed\nFROM telemetry GROUP BY 1 ORDER BY 1"],
  [['wind'], 'SELECT time_bucket(INTERVAL 10 MINUTE, ts) AS t, avg(wind) AS wind FROM telemetry GROUP BY 1 ORDER BY 1'],
  [['per vessel', 'max'], 'SELECT vessel, max(speed) AS max_speed FROM telemetry GROUP BY 1 ORDER BY 1'],
  [[], "SELECT date_trunc('hour', ts) AS hour, vessel, avg(speed) AS speed FROM telemetry GROUP BY 1, 2 ORDER BY 1"],
];

/** The fixed question set the page types (the harness's e2e questions). */
export const QUESTIONS = ['average speed per hour by vessel', 'wind every ten minutes', 'max speed per vessel'] as const;

/**
 * How the answer depends on the typed text:
 * - `plain`: keyword match only (prefixes of a question often already give its final SQL).
 * - `echo`: plus the question as a trailing SQL comment. Every keystroke yields new SQL bytes (no
 *   coordinator dedup, no result-cache hit: the cache key keeps trailing comments), so the final
 *   keystroke runs the whole pipeline. The data equals the previous keystroke's, so the renderer
 *   keeps the image on screen (a steady adoption, no new frame). Same as tests/fake_inference.py.
 * - `vary`: the time window starts 7 minutes later per typed character (and the per-vessel bar
 *   uses avg instead of max), so every keystroke changes the data and the final one puts a new
 *   image on screen. Rollups still apply (whole cells from the rollup, raw edge cells).
 */
export type AnswerMode = 'plain' | 'echo' | 'vary';

export function sqlFor(question: string, mode: AnswerMode): string {
  const q = question.toLowerCase();
  let sql = CANNED[CANNED.length - 1][1];
  for (const [keys, answer] of CANNED) if (!keys.length || keys.some(k => q.includes(k))) { sql = answer; break; }
  if (mode === 'echo') return `${sql}\n-- ${question.split(/\s+/).filter(Boolean).join(' ')}`;
  if (mode === 'vary') {
    const from = new Date(Date.UTC(2026, 8, 1) + question.length * 7 * 60_000).toISOString().slice(0, 19).replace('T', ' ');
    return sql.replace('max(speed) AS max_speed', 'avg(speed) AS avg_speed').replace(/\bGROUP BY\b/, `WHERE ts >= TIMESTAMP '${from}' GROUP BY`);
  }
  return sql;
}

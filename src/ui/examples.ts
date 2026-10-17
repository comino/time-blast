/** Suggested prompts per built-in dataset. Each one was run through the live loop (real
 * inference + DuckDB, 2026-10-17, two passes) and its SQL checked by hand; the detail line
 * names the SQL technique the model has to produce. User-supplied data gets none. */
export interface Example { title: string; prompt: string; detail: string }

export const EXAMPLES: Record<string, Example[]> = {
  vessels: [
    { title: 'How far did each vessel sail per day?', prompt: 'Distance each vessel sailed per day in nautical miles, from consecutive GPS fixes (haversine)', detail: 'LAG window · haversine trig' },
    { title: 'How does speed spread over the day?', prompt: 'Speed percentiles p10, median and p90 by hour of day', detail: 'percentile_cont · 1.2 M rows' },
    { title: 'Replay every voyage', prompt: 'Voyage tracks of every vessel, one averaged position per 30 minutes', detail: 'time buckets · track map' },
  ],
  flights: [
    { title: 'Do delays snowball through the day?', prompt: "Average departure delay grouped by the same aircraft's previous arrival delay, rounded to 15 minutes", detail: 'LAG per tail number · 611 k flights' },
    { title: 'What causes the delay minutes?', prompt: 'Share of delay minutes by cause (carrier, weather, NAS, security, late aircraft) per day', detail: 'unpivot · ratio of sums' },
    { title: 'Where are the slow airports?', prompt: 'Airports on a map with their number of flights and average departure delay', detail: 'join · geo map' },
    { title: 'Who makes up time in the air?', prompt: 'Which carriers make up time in the air? Average departure delay minus arrival delay by carrier name', detail: 'join · carrier names' },
  ],
  weather: [
    { title: 'Longest dry spell in each city', prompt: 'Longest run of consecutive dry hours per city', detail: 'gaps and islands · running SUM' },
    { title: 'When do storms roll in?', prompt: 'Storms: hours where pressure fell more than 5 hPa within 6 hours, counted per city and month', detail: 'LEAD over 6 hours · 211 k rows' },
    { title: 'Madrid vs Oslo, smoothed', prompt: 'Daily average temperature in Madrid and Oslo in 2024 with its 7-day rolling mean', detail: 'window over an aggregate' },
  ],
  cities: [
    { title: 'Which countries have one dominant city?', prompt: "How many times bigger is each country's largest city than its second largest? Top 20", detail: 'ROW_NUMBER · FILTER · join' },
    { title: 'Who lives in the capital?', prompt: "Share of each country's population living in its capital, top 20 countries", detail: 'join · capital feature code' },
    { title: 'The world’s cities by elevation', prompt: 'The 5000 most populous cities on a map, colored by elevation', detail: 'top-N · world map' },
  ],
};

export function examplesFor(dataset: string): Example[] {
  return EXAMPLES[dataset.trim().toLowerCase()] ?? [];
}

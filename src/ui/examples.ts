/** Suggested prompts per built-in dataset. Each one was run through the live loop (real
 * inference + DuckDB, 2026-10-17) with the deployed prompt and its SQL and chart checked by
 * hand; the detail line names the SQL technique the model has to produce. The wording is the
 * tested one: at temperature 0 the same text gives the same SQL, so do not rephrase casually.
 * User-supplied data gets none. */
export interface Example { title: string; prompt: string; detail: string }

export const EXAMPLES: Record<string, Example[]> = {
  vessels: [
    { title: 'How far did each vessel sail per day?', prompt: 'Distance each vessel sailed per day in nautical miles, from consecutive GPS fixes (haversine)', detail: 'LAG window · haversine trig' },
    { title: 'How does speed spread over the day?', prompt: 'Speed percentiles p10, median and p90 by hour of day', detail: 'percentile_cont · 1.2 M rows' },
    { title: 'Replay every voyage', prompt: 'Voyage tracks of every vessel, one averaged position per 30 minutes', detail: 'time buckets · track map' },
  ],
  flights: [
    { title: 'Do delays snowball through the day?', prompt: "Average departure delay grouped by the same aircraft's previous arrival delay, rounded to 15 minutes", detail: 'LAG per tail number · 611 k flights' },
    { title: 'What causes the delay minutes?', prompt: 'Share of delay minutes by cause (carrier, weather, NAS, security, late aircraft) for each day', detail: 'unpivot · ratio of sums' },
    { title: 'Where are the slow airports?', prompt: 'Airports on a map with their number of flights and average departure delay', detail: 'join · geo map' },
    { title: 'Who makes up time in the air?', prompt: 'Which carriers make up time in the air? Average departure delay minus arrival delay by carrier name', detail: 'join · carrier names' },
  ],
  weather: [
    { title: 'Longest dry spell in each city', prompt: 'Longest run of consecutive dry hours for each city', detail: 'gaps and islands · running SUM' },
    { title: 'When do storms roll in?', prompt: 'Storms: hours where pressure fell more than 5 hPa within 6 hours, counted per city and month', detail: 'LEAD over 6 hours · 211 k rows' },
    { title: 'Madrid vs Oslo, smoothed', prompt: 'Daily average temperature in Madrid and Oslo in 2024 with its 7-day rolling mean', detail: 'window over an aggregate' },
  ],
  'flights-2024': [
    { title: 'When do whole days fall apart?', prompt: 'Share of flights cancelled per day in 2024 with its 7-day rolling average', detail: 'rolling window over daily ratios · 7.1 M flights' },
    { title: 'The delay week, hour by hour', prompt: 'Heatmap of average departure delay by hour of day and day of week', detail: 'hour × weekday grid · 7.1 M flights' },
    { title: 'Where are the slow airports?', prompt: 'Airports on a map with their number of flights and average departure delay', detail: 'join · geo map · full year' },
  ],
  'nyc-taxi': [
    { title: 'When do New Yorkers tip most?', prompt: 'Average tip percentage of the fare for card payments with a positive fare, by hour of day and day of week, as a heatmap', detail: 'hour × weekday grid · 9.4 M trips' },
    { title: 'The busiest rides in the city', prompt: 'Top 15 pickup to dropoff zone pairs by trips, with zone names', detail: 'two joins on one zone table' },
    { title: 'How long does a ride take?', prompt: 'Median trip duration in minutes by hour of day', detail: 'percentile_cont · date_diff' },
    { title: 'What does the airport cost you?', prompt: 'Average total fare from JFK and LaGuardia to each dropoff borough', detail: 'two joins · zone filter' },
  ],
  'nyc-taxi-big': [
    { title: 'Three years of New York taxis', prompt: 'Trips per day across 2022 to 2024 with the 28-day rolling average', detail: 'server DuckDB · 120 M trips · rolling window' },
    { title: 'Tipping by hour, year over year', prompt: 'Average tip as a share of the fare for card payments, by year and hour of day', detail: 'year × hour grid · 120 M trips' },
    { title: 'Where 2024’s rides start', prompt: 'Pickup zones on a map with their number of trips in 2024', detail: 'join · zone centroids · map' },
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

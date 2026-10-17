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
    { title: 'Does the sea follow the wind?', prompt: 'How does wave height respond to wind? Average wave height per 2-knot wind band', detail: 'binning · 1.2 M readings' },
    { title: 'Water temperature, smoothed', prompt: 'Hourly water temperature per vessel with its 6-hour rolling mean', detail: 'time-range window over an aggregate' },
    { title: 'Who ran fast, and for how long?', prompt: 'Minutes each vessel spent above 15 knots per day', detail: 'conditional sum · 6 s readings' },
    { title: 'Find the storm', prompt: 'Highest wind reading per vessel each day', detail: 'daily maxima per vessel' },
    { title: 'Total distance of every voyage', prompt: 'Total distance per vessel over the whole period in nautical miles (haversine between consecutive fixes)', detail: 'LAG in a subquery · haversine' },
  ],
  flights: [
    { title: 'Do delays snowball through the day?', prompt: "Average departure delay grouped by the same aircraft's previous arrival delay, rounded to 15 minutes", detail: 'LAG per tail number · 611 k flights' },
    { title: 'What causes the delay minutes?', prompt: 'Share of delay minutes by cause (carrier, weather, NAS, security, late aircraft) for each day', detail: 'unpivot · ratio of sums' },
    { title: 'Where are the slow airports?', prompt: 'Airports on a map with their number of flights and average departure delay', detail: 'join · geo map' },
    { title: 'Who makes up time in the air?', prompt: 'Which carriers make up time in the air? Average departure delay minus arrival delay by carrier name', detail: 'join · carrier names' },
    { title: 'Which airline cancels most?', prompt: 'Cancellation rate by carrier name', detail: 'join · conditional average' },
    { title: 'Do long flights arrive later?', prompt: 'Average arrival delay by flight distance in 250-mile bands', detail: 'binning · 611 k flights' },
    { title: 'The delay week, hour by hour', prompt: 'Heatmap of average departure delay by hour of day and day of week', detail: 'hour × weekday grid' },
  ],
  weather: [
    { title: 'Longest dry spell in each city', prompt: 'Longest run of consecutive dry hours for each city', detail: 'gaps and islands · running SUM' },
    { title: 'When do storms roll in?', prompt: 'Storms: hours where pressure fell more than 5 hPa within 6 hours, counted per city and month', detail: 'LEAD over 6 hours · 211 k rows' },
    { title: 'Madrid vs Oslo, smoothed', prompt: 'Daily average temperature in Madrid and Oslo in 2024 with its 7-day rolling mean', detail: 'window over an aggregate' },
    { title: 'The coldest night in each city', prompt: 'Coldest night in each city: the lowest temperature and when it happened', detail: 'ROW_NUMBER per city' },
    { title: "Madrid's day, month by month", prompt: 'Average temperature by hour of day and month for Madrid as a heatmap', detail: 'hour × month grid' },
    { title: 'Where summer gets hot', prompt: 'Days per month with a daily maximum above 30 °C, per city', detail: 'daily max in a subquery · count' },
    { title: 'How windy is each city?', prompt: 'Median and 95th percentile wind speed per city', detail: 'percentile_cont · 211 k hours' },
    { title: 'Grey skies by season', prompt: 'Average cloud cover per city by season', detail: 'CASE seasons · grouped average' },
  ],
  'flights-2024': [
    { title: 'When do whole days fall apart?', prompt: 'Share of flights cancelled per day in 2024 with its 7-day rolling average', detail: 'rolling window over daily ratios · 7.1 M flights' },
    { title: 'The delay week, hour by hour', prompt: 'Heatmap of average departure delay by hour of day and day of week', detail: 'hour × weekday grid · 7.1 M flights' },
    { title: 'Where are the slow airports?', prompt: 'Airports on a map with their number of flights and average departure delay', detail: 'join · geo map · full year' },
    { title: 'Who stays on time all year?', prompt: 'Monthly share of flights arriving within 15 minutes for the 5 carriers with the most flights, by carrier name', detail: 'CTE top-5 · join · monthly share' },
    { title: 'Every day of US flying', prompt: 'Flights per day in 2024', detail: '366 days · 7.1 M flights' },
    { title: 'Bad months, bad weekdays', prompt: 'Average arrival delay by month and day of week as a heatmap', detail: 'month × weekday grid' },
    { title: "What caused each month's delays?", prompt: 'Share of delay minutes by cause (carrier, weather, NAS, security, late aircraft) for each month', detail: 'unpivot with LATERAL VALUES' },
    { title: 'Who makes up time in the air?', prompt: 'Which carriers make up time in the air? Average departure delay minus arrival delay by carrier name', detail: 'join · carrier names' },
    { title: 'Hurricane season in Florida', prompt: 'Cancelled flights per day at Florida airports from August to October 2024', detail: 'join on airports · date range' },
    { title: 'Waiting on the taxiway', prompt: 'Average taxi-out minutes by month at the 5 busiest airports, with airport names', detail: 'top-5 subquery · join' },
  ],
  'nyc-taxi': [
    { title: 'When do New Yorkers tip most?', prompt: 'Average tip percentage of the fare for card payments with a positive fare, by hour of day and day of week, as a heatmap', detail: 'hour × weekday grid · 9.4 M trips' },
    { title: 'The busiest rides in the city', prompt: 'Top 15 pickup to dropoff zone pairs by trips, with zone names', detail: 'two joins on one zone table' },
    { title: 'How long does a ride take?', prompt: 'Median trip duration in minutes by hour of day', detail: 'percentile_cont · date_diff' },
    { title: 'What does the airport cost you?', prompt: 'Average total fare from JFK and LaGuardia to each dropoff borough', detail: 'two joins · zone filter' },
    { title: 'Three months, hour by hour', prompt: 'Trips per hour across January to March 2024', detail: '2,183 hourly buckets · 9.4 M trips' },
    { title: 'Card or cash?', prompt: 'Share of card and cash payments per day', detail: 'window over an aggregate' },
    { title: 'The rhythm of the city', prompt: 'Trips per day with the 7-day rolling average', detail: 'rolling window' },
    { title: 'Where the long rides start', prompt: 'Top 15 pickup zones by average trip distance, with zone names', detail: 'join · top-N' },
    { title: 'How fast is a taxi?', prompt: 'Average speed in mph by hour of day, for trips longer than one minute', detail: 'derived speed · date_diff' },
  ],
  'nyc-taxi-big': [
    { title: 'Three years of New York taxis', prompt: 'Trips per day across 2022 to 2024 with the 28-day rolling average', detail: 'server DuckDB · 120 M trips · rolling window' },
    { title: 'Tipping by hour, year over year', prompt: 'Average tip as a share of the fare for card payments, by year and hour of day', detail: 'year × hour grid · 120 M trips' },
    { title: 'Where 2024’s rides start', prompt: 'Pickup zones on a map with their number of trips in 2024', detail: 'join · zone centroids · map' },
    { title: 'When does New York ride?', prompt: 'Heatmap of trips by hour of day and day of week in 2024', detail: 'hour × weekday grid · server DuckDB' },
    { title: 'The busiest corners of 2024', prompt: 'Busiest 15 pickup zones in 2024, with zone and borough names', detail: 'aggregate then join · 120 M trips' },
    { title: 'Airport runs, month by month', prompt: 'Trips per month starting at JFK or LaGuardia airport', detail: 'join · ILIKE · three years' },
    { title: 'Tips by borough', prompt: 'Median tip in dollars for card payments by pickup borough in 2024', detail: 'percentile_cont · join' },
  ],
  cities: [
    { title: 'Which countries have one dominant city?', prompt: "How many times bigger is each country's largest city than its second largest? Top 20", detail: 'ROW_NUMBER · FILTER · join' },
    { title: 'Who lives in the capital?', prompt: "Share of each country's population living in its capital, top 20 countries", detail: 'join · capital feature code' },
    { title: 'The world’s cities by elevation', prompt: 'The 5000 most populous cities on a map, colored by elevation', detail: 'top-N · world map' },
    { title: 'The biggest city on each continent', prompt: 'Largest city of each continent with its country name', detail: 'QUALIFY ROW_NUMBER · join' },
    { title: 'Where the big cities are', prompt: 'Countries with the most cities over 100,000 people, top 15', detail: 'join · filter · top-N' },
    { title: 'Life at altitude', prompt: 'Average city elevation by continent', detail: 'join · grouped average' },
    { title: 'Where people really live', prompt: 'Population-weighted average latitude per continent', detail: 'weighted average · join' },
    { title: 'Million-people cities', prompt: 'Number of cities over one million people per continent', detail: 'join · count' },
    { title: 'The most crowded countries', prompt: 'Population density of countries with over a million people, top 20, in people per km²', detail: 'derived ratio · top-N' },
  ],
};

export function examplesFor(dataset: string): Example[] {
  return EXAMPLES[dataset.trim().toLowerCase()] ?? [];
}

/** How many suggestions show at once. */
export const SHOWN = 3;

/** A shuffled deck of one dataset's prompts: `SHOWN` random ones first; each used prompt is
 * replaced by the next one not yet shown, cycling once every prompt has been offered. */
export class ExampleDeck {
  private readonly order: Example[];
  private cursor: number;
  constructor(list: readonly Example[], random: () => number = Math.random) {
    this.order = [...list];
    for (let i = this.order.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [this.order[i], this.order[j]] = [this.order[j], this.order[i]];
    }
    this.cursor = Math.min(SHOWN, this.order.length);
  }
  initial(): Example[] { return this.order.slice(0, SHOWN); }
  /** The replacement for `used`, never one of `showing`; undefined if the pool has no other. */
  next(showing: readonly string[]): Example | undefined {
    for (let n = 0; n < this.order.length; n++) {
      const candidate = this.order[this.cursor % this.order.length];
      this.cursor++;
      if (!showing.includes(candidate.prompt)) return candidate;
    }
    return undefined;
  }
}

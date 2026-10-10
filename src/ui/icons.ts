export const icon = (path: string): string => `<svg class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
export const icons = {
  bolt: icon('<path d="M13 2 4 14h7l-1 8 10-13h-7l1-7Z"/>'),
  arrow: icon('<path d="m7 17 10-10M7 7h10v10"/>'),
  close: icon('<path d="m6 6 12 12M18 6 6 18"/>'),
  chart: icon('<path d="M4 17 9 10l4 3 7-9M4 4v16h16"/>'),
  download: icon('<path d="M12 3v12m-5-5 5 5 5-5M5 16v4h14v-4"/>'),
  code: icon('<path d="m8 7-5 5 5 5m8-10 5 5-5 5"/>'),
  settings: icon('<path d="M4 7h16M4 17h16M8 4v6M16 14v6"/>'),
  database: icon('<ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v7c0 4 14 4 14 0V5M5 12v7c0 4 14 4 14 0v-7"/>'),
  grid: icon('<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>'),
  up: icon('<path d="m5 12 7-7 7 7M12 5v15"/>'),
  plus: icon('<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M12 8v8M8 12h8"/>'),
  target: icon('<circle cx="12" cy="12" r="7"/><path d="M9 12h6M12 9v6"/>'),
  trend: icon('<path d="m4 16 5-5 4 3 7-9"/><path d="M15 5h5v5"/>'),
  file: icon('<path d="M14 3H6v18h12V7l-4-4Z"/><path d="M14 3v4h4"/>'),
};

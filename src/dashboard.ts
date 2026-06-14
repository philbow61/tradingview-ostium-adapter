/** Loads the self-contained dashboard page (T-111). Kept as a sibling .html file so the markup/JS
 *  stays readable (no template-literal escaping). Read once, cached. Served at GET / by the server. */
import { readFileSync } from 'node:fs';

let cached: string | undefined;

export function dashboardHtml(): string {
  if (cached != null) return cached;
  try {
    cached = readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8');
  } catch {
    cached =
      '<!doctype html><meta charset="utf-8"><title>Ostium Adapter</title>' +
      '<body style="font:14px/1.5 sans-serif;background:#141414;color:#f5f5f5;padding:24px">' +
      'Dashboard template (src/dashboard.html) not found.</body>';
  }
  return cached;
}

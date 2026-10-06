// Small inline SVG icons (no icon fonts, no CDN). Stroke icons inherit currentColor.
import { html } from "/vendor/preact-htm.js";

const PATHS = {
  phone: html`<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" />`,
  message: html`<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.6A8 8 0 1 1 21 12z" />`,
  plus: html`<path d="M12 5v14M5 12h14" />`,
  list: html`<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />`,
  check: html`<path d="M5 12.5l4.5 4.5L19 7.5" />`,
  gear: html`<circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />`,
  chevron: html`<path d="M9 6l6 6-6 6" />`,
  back: html`<path d="M15 6l-6 6 6 6" />`,
  clock: html`<circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />`,
  today: html`<rect x="4" y="5" width="16" height="15" rx="2" /><path d="M4 10h16M9 3v4M15 3v4" />`,
  search: html`<circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />`,
  close: html`<path d="M6 6l12 12M18 6L6 18" />`,
  map: html`<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z" /><circle cx="12" cy="9.5" r="2.5" />`,
  mail: html`<rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3.5 6.5l8.5 6.5 8.5-6.5" />`,
  truck: html`<path d="M3 6h11v10H3zM14 9h4l3 3.5V16h-7" /><circle cx="7" cy="17.5" r="1.8" /><circle cx="17.5" cy="17.5" r="1.8" />`,
  copy: html`<rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />`,
  undo: html`<path d="M9 14L4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" />`,
  backspace: html`<path d="M21 5H9l-6 7 6 7h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1z" /><path d="M17 9l-6 6M11 9l6 6" />`,
  alert: html`<path d="M12 3l9.5 17H2.5z" /><path d="M12 10v4M12 17.5h.01" />`,
  flask: html`<path d="M9 3h6M10 3v6L4.5 19a1.5 1.5 0 0 0 1.3 2h12.4a1.5 1.5 0 0 0 1.3-2L14 9V3" /><path d="M7.5 14h9" />`,
  chart: html`<path d="M5 20V10M12 20V4M19 20v-7" />`,
};

/** <${Icon} name="phone" /> renders a 24px stroke icon hidden from screen readers. */
export function Icon({ name, size = 22, className = "" }) {
  return html`<svg class=${`icon ${className}`} width=${size} height=${size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
    focusable="false">${PATHS[name] || null}</svg>`;
}

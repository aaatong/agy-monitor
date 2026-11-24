/** Formatting and theme utilities for the AGY Monitor sidebar UI. */

export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

export function fmtExact(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return Math.round(n).toLocaleString('en-US');
}

export function fmtPct(n: number): string {
  if (!Number.isFinite(n)) return '0.0%';
  return `${n.toFixed(1)}%`;
}

export function fmtTurnTime(ts?: string, now: Date = new Date()): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;

  const pad2 = (v: number) => String(v).padStart(2, '0');
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();

  if (sameDay) return time;
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${time}`;
}

export function parseColorLuminance(color: string): number | null {
  const c = color.trim();
  const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  if (hexMatch) {
    const hex = hexMatch[1];
    const r =
      hex.length === 3 ? parseInt(hex[0] + hex[0], 16) : parseInt(hex.slice(0, 2), 16);
    const g =
      hex.length === 3 ? parseInt(hex[1] + hex[1], 16) : parseInt(hex.slice(2, 4), 16);
    const b =
      hex.length === 3 ? parseInt(hex[2] + hex[2], 16) : parseInt(hex.slice(4, 6), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }

  const rgbMatch = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(c);
  if (rgbMatch) {
    const r = Number(rgbMatch[1]);
    const g = Number(rgbMatch[2]);
    const b = Number(rgbMatch[3]);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }

  return null;
}

export function syncThemeAttribute(): void {
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--background');
  const lum = parseColorLuminance(bg);
  if (lum !== null) {
    document.documentElement.dataset.theme = lum > 0.5 ? 'light' : 'dark';
  }
}

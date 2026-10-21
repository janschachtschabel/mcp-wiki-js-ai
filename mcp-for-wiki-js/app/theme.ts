/**
 * Shared inline styles for the server-rendered pages (landing, /me,
 * /oauth/authorize). One dark theme, one source of truth — the pages must look
 * consistent and none of them warrants a CSS pipeline. Every colour lives in
 * `color`; pages use these tokens, never literals (R-59).
 *
 * Contrast (WCAG 2.2 AA, R-51), measured against page #0b1020 / card #141b33:
 * text ≥ 4.5:1, borders of controls (inputs, buttons) ≥ 3:1. Card and table
 * borders are decoration (not a UI component), so they may stay subtle.
 */

export const color = {
  page: '#0b1020',
  surface: '#141b33',
  text: '#e7ecff', // 13.8:1 on surface
  muted: '#9fb0db', // 7.9:1 on surface, 8.8:1 on page
  code: '#bcd0ff', // 12.3:1 on page
  link: '#7ab3ff', // 7.9:1 on surface
  divider: '#25304f', // decoration only
  controlBorder: '#64749f', // 3.7:1 on surface, 4.1:1 on page
  accent: '#2563eb', // white text 5.2:1; edge 3.3:1 on surface
  onAccent: '#ffffff',
  danger: '#fca5a5', // 9.0:1 on surface
  dangerBorder: '#d14b4b', // 3.9:1 on surface
  dangerSurface: '#2a1420',
  warning: '#fcd34d',
  warningBorder: '#a07a2c', // 4.3:1 on surface
  successSurface: '#12241a',
  successBorder: '#2f4a2f', // decoration only
} as const;

export const card: React.CSSProperties = {
  background: color.surface,
  border: `1px solid ${color.divider}`,
  borderRadius: 12,
  padding: '18px 22px',
  margin: '14px 0',
};

/** Highlighted card variants (recommendation on /, admin sections on /me). */
export const successCard: React.CSSProperties = { ...card, border: `1px solid ${color.successBorder}`, background: color.successSurface };
export const adminCard: React.CSSProperties = { ...card, border: `1px solid ${color.warningBorder}` };

export const code: React.CSSProperties = {
  background: color.page,
  border: `1px solid ${color.divider}`,
  borderRadius: 8,
  padding: '12px 14px',
  display: 'block',
  whiteSpace: 'pre-wrap',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 13,
  color: color.code,
  overflowX: 'auto',
  margin: '8px 0',
};

export const mono: React.CSSProperties = {
  color: color.code,
  fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
};

export const h2: React.CSSProperties = { fontSize: 18, margin: '4px 0 2px' };

export const muted: React.CSSProperties = { color: color.muted };

export const emphasis: React.CSSProperties = { color: color.text };

export const link: React.CSSProperties = { color: color.link };

export const ol: React.CSSProperties = { color: color.muted, lineHeight: 1.7, margin: '6px 0', paddingLeft: 20 };

export const label: React.CSSProperties = { display: 'block', margin: '12px 0 4px', color: color.muted, fontSize: 14 };

export const input: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  background: color.page,
  border: `1px solid ${color.controlBorder}`,
  borderRadius: 8,
  padding: '10px 12px',
  color: color.text,
  fontSize: 15,
};

export const primaryBtn: React.CSSProperties = {
  background: color.accent,
  color: color.onAccent,
  border: 'none',
  borderRadius: 8,
  padding: '10px 18px',
  fontSize: 15,
  cursor: 'pointer',
  marginTop: 16,
};

export const secondaryBtn: React.CSSProperties = {
  background: 'transparent',
  color: color.muted,
  border: `1px solid ${color.controlBorder}`,
  borderRadius: 8,
  padding: '10px 18px',
  fontSize: 15,
  cursor: 'pointer',
  marginTop: 16,
  marginLeft: 10,
};

export const dangerBtn: React.CSSProperties = {
  background: 'transparent',
  color: color.danger,
  border: `1px solid ${color.dangerBorder}`,
  borderRadius: 8,
  padding: '6px 12px',
  fontSize: 13,
  cursor: 'pointer',
};

/** Quiet button (logout): muted text, control border. */
export const quietBtn: React.CSSProperties = { ...dangerBtn, color: color.muted, border: `1px solid ${color.controlBorder}` };

export const errorBox: React.CSSProperties = { ...card, border: `1px solid ${color.dangerBorder}`, background: color.dangerSurface, color: color.danger };

export const warningBox: React.CSSProperties = { ...card, border: `1px solid ${color.warningBorder}`, color: color.warning, fontSize: 14 };

export const th: React.CSSProperties = {
  textAlign: 'left',
  padding: '6px 10px',
  color: color.muted,
  fontWeight: 500,
  fontSize: 13,
};

export const td: React.CSSProperties = { padding: '6px 10px', borderTop: `1px solid ${color.divider}`, fontSize: 14 };

/** Visually hidden, still read by screen readers (e.g. header of an action column). */
export const srOnly: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

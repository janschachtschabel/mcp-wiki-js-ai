/**
 * Shared inline styles for the server-rendered pages (landing, /me,
 * /oauth/authorize). One dark theme, one source of truth — the pages must look
 * consistent and none of them warrants a CSS pipeline.
 */

export const card: React.CSSProperties = {
  background: '#141b33',
  border: '1px solid #25304f',
  borderRadius: 12,
  padding: '18px 22px',
  margin: '14px 0',
};

export const code: React.CSSProperties = {
  background: '#0b1020',
  border: '1px solid #25304f',
  borderRadius: 8,
  padding: '12px 14px',
  display: 'block',
  whiteSpace: 'pre-wrap',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 13,
  color: '#bcd0ff',
  overflowX: 'auto',
  margin: '8px 0',
};

export const mono: React.CSSProperties = {
  color: '#bcd0ff',
  fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
};

export const h2: React.CSSProperties = { fontSize: 18, margin: '4px 0 2px' };

export const muted: React.CSSProperties = { color: '#9fb0db' };

export const ol: React.CSSProperties = { color: '#9fb0db', lineHeight: 1.7, margin: '6px 0', paddingLeft: 20 };

export const label: React.CSSProperties = { display: 'block', margin: '12px 0 4px', color: '#9fb0db', fontSize: 14 };

export const input: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  background: '#0b1020',
  border: '1px solid #25304f',
  borderRadius: 8,
  padding: '10px 12px',
  color: '#e7ecff',
  fontSize: 15,
};

export const primaryBtn: React.CSSProperties = {
  background: '#3b82f6',
  color: '#fff',
  border: 'none',
  borderRadius: 8,
  padding: '10px 18px',
  fontSize: 15,
  cursor: 'pointer',
  marginTop: 16,
};

export const secondaryBtn: React.CSSProperties = {
  background: 'transparent',
  color: '#9fb0db',
  border: '1px solid #25304f',
  borderRadius: 8,
  padding: '10px 18px',
  fontSize: 15,
  cursor: 'pointer',
  marginTop: 16,
  marginLeft: 10,
};

export const dangerBtn: React.CSSProperties = {
  background: 'transparent',
  color: '#fca5a5',
  border: '1px solid #7f1d1d',
  borderRadius: 8,
  padding: '6px 12px',
  fontSize: 13,
  cursor: 'pointer',
};

export const th: React.CSSProperties = {
  textAlign: 'left',
  padding: '6px 10px',
  color: '#9fb0db',
  fontWeight: 500,
  fontSize: 13,
};

export const td: React.CSSProperties = { padding: '6px 10px', borderTop: '1px solid #25304f', fontSize: 14 };

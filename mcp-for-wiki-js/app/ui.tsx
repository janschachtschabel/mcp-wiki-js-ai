import { errorBox } from './theme';

/** Login/validation error, announced by screen readers when the page loads (R-52). */
export function ErrorBox({ text }: { text: string }) {
  return (
    <div role="alert" style={errorBox}>
      <p style={{ margin: 0 }}>{text}</p>
    </div>
  );
}

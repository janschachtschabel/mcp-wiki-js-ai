// Show the EFFECTIVE roles (built-ins ← config/roles.json ← WIKIJS_ROLES env), incl. per-tool overrides.
// Run: npm run roles
import { ROLES, DEFAULT_PRESET, CATEGORIES } from '../lib/permissions';

const pad = (s: string, n: number) => (s + ' '.repeat(n)).slice(0, n);
const cols = CATEGORIES as readonly string[];

console.log(`default / ceiling role: ${DEFAULT_PRESET}\n`);
console.log(pad('role', 14) + cols.map((c) => pad(c, 14)).join(''));
console.log('-'.repeat(14 + cols.length * 14));
for (const [name, r] of Object.entries(ROLES)) {
  console.log(pad(name, 14) + cols.map((c) => pad((r.categories as Record<string, string>)[c], 14)).join(''));
  const tools = Object.entries(r.tools);
  if (tools.length) {
    console.log(pad('', 14) + 'tools: ' + tools.map(([t, m]) => `${t}=${m}`).join(', '));
  }
}

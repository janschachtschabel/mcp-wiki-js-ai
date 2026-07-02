// Generate secure, unguessable WIKIJS_PROFILES entries (one per person).
//
// The map KEY of each profile is a high-entropy SECRET handle (the token the user
// connects with). It must NOT be a guessable name. The human name goes into "label".
// Each person is assigned a ROLE (a name from config/roles.json), e.g. leser, autor,
// redakteur, betreuer, admin, systemadmin. The wiki URL is set ONCE via WIKIJS_URL
// (not per profile), since usually all users share one wiki.
//
// Usage:
//   node scripts/gen-profile.mjs "Alice:leser" "Bob:redakteur"
//   (label:role  — role optional, defaults to leser)
import { randomBytes } from 'node:crypto';

const PREFIX = 'wzp_';
const genHandle = () => PREFIX + randomBytes(24).toString('base64url'); // ~192 bits

const specs = process.argv.slice(2);
if (specs.length === 0) specs.push('User1:leser');

const profiles = {};
const handouts = [];
for (const spec of specs) {
  const [label, role] = spec.split(':');
  const handle = genHandle();
  profiles[handle] = {
    label: label || 'User',
    token: `REPLACE_WITH_${(label || 'USER').toUpperCase()}_WIKIJS_API_KEY`,
    role: role || 'leser',
  };
  handouts.push({ label: label || 'User', handle, role: role || 'leser' });
}

console.log('# 1) Set the wiki URL ONCE:');
console.log(`#    WIKIJS_URL=${process.env.WIKI_URL || 'https://wiki-js.openeduhub.de'}`);
console.log('#    WIKIJS_PERMISSION_PRESET=<ceiling, e.g. the most-privileged role you use>\n');
console.log('# 2) Paste this (replace REPLACE_WITH_… with the real, scoped Wiki.js keys):\n');
console.log('WIKIJS_PROFILES=' + JSON.stringify(profiles) + '\n');
console.log('# 3) Hand each user their SECRET handle token (treat like a password):');
for (const h of handouts) {
  console.log(`#   ${h.label} [role: ${h.role}] → ${h.handle}`);
  console.log(`#       URL param : <deploy>/mcp?token=${h.handle}`);
  console.log(`#       header     : X-Wikijs-Token: ${h.handle}`);
}

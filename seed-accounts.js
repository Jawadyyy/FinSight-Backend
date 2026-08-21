/**
 * Seeds the two demo accounts.
 *
 *   node seed-accounts.js
 *
 * Requires Postgres and the backend to be running.
 *
 * Registration goes through the API rather than SQL on purpose: the password
 * must be bcrypt-hashed by the app itself. Inserting a row directly would
 * store an unusable password and the account could never log in.
 *
 * The plan is then set with SQL, because upgrading is Stripe's job in the
 * running app and there is deliberately no "make me Pro" endpoint.
 */
const { Client } = require('pg');
require('dotenv').config({ quiet: true });

const API = 'http://127.0.0.1:3000';

const ACCOUNTS = [
  { email: 'jawad@gmail.com', password: '12345678', name: 'Jawad', tier: 'free' },
  { email: 'admin@gmail.com', password: 'admin123', name: 'Admin', tier: 'pro' },
];

async function ensureRegistered({ email, password, name }) {
  const res = await fetch(`${API}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name }),
  });

  if (res.ok) return 'created';
  if (res.status === 409) return 'already existed';

  const body = await res.text();
  throw new Error(`register failed for ${email}: ${res.status} ${body.slice(0, 200)}`);
}

(async () => {
  // Fail early with a clear message rather than a stack trace.
  try {
    await fetch(`${API}/subscription`);
  } catch {
    console.error('Backend is not reachable on :3000. Start it with "npm run start:dev" first.');
    process.exit(1);
  }

  const client = new Client({
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: Number(process.env.DATABASE_PORT || 5432),
    user: process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
  });
  await client.connect();

  for (const account of ACCOUNTS) {
    const state = await ensureRegistered(account);

    const { rowCount } = await client.query(
      'UPDATE users SET tier = $1 WHERE email = $2',
      [account.tier, account.email],
    );
    if (!rowCount) throw new Error(`no user row for ${account.email}`);

    console.log(`${account.email.padEnd(20)} ${state.padEnd(15)} tier -> ${account.tier}`);
  }

  const { rows } = await client.query(
    'SELECT email, tier, "uploadsUsed", "uploadsPeriod" FROM users WHERE email = ANY($1)',
    [ACCOUNTS.map((a) => a.email)],
  );
  console.log('\nverified in the database:');
  for (const r of rows) {
    console.log(`  ${r.email.padEnd(20)} tier=${r.tier.padEnd(5)} uploads=${r.uploadsUsed}/${r.uploadsPeriod ?? '-'}`);
  }

  await client.end();
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

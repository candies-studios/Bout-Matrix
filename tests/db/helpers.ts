import pg from 'pg';
import { randomUUID } from 'node:crypto';

export const ORG = '00000000-0000-4000-8000-000000000001';
export const DEMO_EVENT = '00000000-0000-4000-8000-0000000000e1';

export const pool = new pg.Pool({
  host: process.env.PGHOST ?? '/tmp',
  port: Number(process.env.PGPORT ?? 54329),
  user: process.env.PGUSER ?? 'postgres',
  database: process.env.TEST_DB_NAME ?? 'mma_test',
  max: 30,
});

export type Db = pg.PoolClient;

/** Run `fn` inside a transaction that is always rolled back (as the postgres owner). */
export async function tx<T>(fn: (c: Db) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    return await fn(c);
  } finally {
    await c.query('rollback').catch(() => {});
    c.release();
  }
}

/** Switch the current transaction to an API role, as PostgREST would. */
export async function actAs(c: Db, who: { uid: string } | 'anon' | 'service_role') {
  await c.query('reset role');
  if (who === 'anon') {
    await c.query(`select set_config('request.jwt.claims', '{"role":"anon"}', true)`);
    await c.query('set local role anon');
  } else if (who === 'service_role') {
    await c.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
    await c.query('set local role service_role');
  } else {
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: who.uid, role: 'authenticated' }),
    ]);
    await c.query('set local role authenticated');
  }
}

export async function asOwner(c: Db) {
  await c.query('reset role');
  await c.query(`select set_config('request.jwt.claims', '', true)`);
}

/** Run a statement in a savepoint and return the error (or null) without aborting the tx. */
export async function attempt(c: Db, sql: string, params: unknown[] = []): Promise<Error | null> {
  await c.query('savepoint attempt');
  try {
    await c.query(sql, params);
    await c.query('release savepoint attempt');
    return null;
  } catch (e) {
    await c.query('rollback to savepoint attempt');
    return e as Error;
  }
}

export async function createUser(
  c: Db,
  opts: { email?: string; orgRole?: 'super_admin' | 'org_admin' | 'staff' | 'coach'; org?: string } = {},
) {
  const id = randomUUID();
  const email = opts.email ?? `${id.slice(0, 8)}@test.example.com`;
  await c.query('insert into auth.users (id, email) values ($1, $2)', [id, email]);
  await c.query('insert into public.user_profiles (id, org_id, email, full_name) values ($1, $2, $3, $4)', [
    id,
    opts.org ?? ORG,
    email,
    `User ${id.slice(0, 4)}`,
  ]);
  if (opts.orgRole) {
    await c.query('insert into public.user_roles (user_id, org_id, role) values ($1, $2, $3)', [
      id,
      opts.org ?? ORG,
      opts.orgRole,
    ]);
  }
  return { uid: id, email };
}

export async function createEvent(c: Db, slug = `evt-${randomUUID().slice(0, 8)}`, extra: Record<string, unknown> = {}) {
  const cols = ['org_id', 'slug', 'name', ...Object.keys(extra)];
  const vals = [ORG, slug, `Event ${slug}`, ...Object.values(extra)];
  const { rows } = await c.query(
    `insert into public.events (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')}) returning *`,
    vals,
  );
  // weight classes and rules are copied from org templates by a trigger
  return rows[0] as { id: string; slug: string; event_code: string };
}

export async function grantEvent(c: Db, eventId: string, uid: string, role: 'event_admin' | 'matchmaker') {
  await c.query('insert into public.event_admins (event_id, user_id, role) values ($1, $2, $3)', [eventId, uid, role]);
}

export async function createFighter(
  c: Db,
  opts: { name?: string; division?: string; eventId?: string; weightG?: number; email?: string } = {},
) {
  const { rows } = await c.query(
    `insert into public.fighters (org_id, fight_name, division) values ($1, $2, $3) returning id, fighter_code`,
    [ORG, opts.name ?? `Fighter ${randomUUID().slice(0, 6)}`, opts.division ?? 'men'],
  );
  const f = rows[0] as { id: string; fighter_code: string };
  await c.query(
    `insert into public.fighter_private (fighter_id, legal_name, date_of_birth, email, consent_at, consent_version)
     values ($1, 'Legal Name', '1998-01-01', $2, now(), 'v1')`,
    [f.id, opts.email ?? `${f.id.slice(0, 8)}@fighter.example.com`],
  );
  if (opts.eventId) {
    await c.query(
      `insert into public.event_registrations (event_id, fighter_id, status, submitted_via, declared_weight_g,
         weight_recorded_at, weight_unit_entered, division, competition_level, submitted_at)
       values ($1, $2, 'approved', 'self', $3, now(), 'kg', $4, 'amateur', now())`,
      [opts.eventId, f.id, opts.weightG ?? 70000, opts.division ?? 'men'],
    );
  }
  return f;
}

export async function createBout(c: Db, eventId: string, a: string, b: string) {
  const { rows } = await c.query(
    `insert into public.bouts (org_id, event_id, fighter_a_id, fighter_b_id) values ($1, $2, $3, $4) returning *`,
    [ORG, eventId, a, b],
  );
  return rows[0] as { id: string; status: string; bout_code: string; offer_version: number };
}

/** Simulate the offer workflow (normally done by Edge Functions) up to both fighters accepting. */
export async function acceptBoth(c: Db, boutId: string) {
  const { rows } = await c.query('select * from public.bouts where id = $1', [boutId]);
  const b = rows[0];
  await c.query(`select private.set_context(null, 'system', 'test offers')`);
  await c.query(`update public.bouts set status = 'offer_sent', offer_version = offer_version + 1 where id = $1`, [boutId]);
  for (const [corner, fid] of [
    ['A', b.fighter_a_id],
    ['B', b.fighter_b_id],
  ]) {
    await c.query(
      `insert into public.bout_offers (id, bout_id, fighter_id, corner, offer_version, token_nonce, token_hash,
         status, expires_at, terms_snapshot)
       values (gen_random_uuid(), $1, $2, $3, $4, 'nonce-nonce-nonce-nonce-01', encode(sha256(gen_random_uuid()::text::bytea), 'hex'),
               'accepted', now() + interval '1 day', '{}')`,
      [boutId, fid, corner, b.offer_version + 1],
    );
  }
  await c.query(`update public.bouts set status = 'accepted_one' where id = $1`, [boutId]);
  await c.query(`update public.bouts set status = 'accepted_both' where id = $1`, [boutId]);
}

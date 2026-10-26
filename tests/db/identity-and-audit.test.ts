import { afterAll, describe, expect, it } from 'vitest';
import { ORG, actAs, attempt, createEvent, createFighter, createUser, pool, tx } from './helpers';

afterAll(() => pool.end());

describe('permanent fighter IDs', () => {
  it('uses the configurable prefix and zero-padded sequence', async () => {
    await tx(async (c) => {
      const f = await createFighter(c);
      expect(f.fighter_code).toMatch(/^WDS-F-\d{4,}$/);
    });
  });

  it('is unique under heavy concurrency (25 parallel committed transactions)', async () => {
    const N = 25;
    const codes = await Promise.all(
      Array.from({ length: N }, async (_, i) => {
        const c = await pool.connect();
        try {
          await c.query('begin');
          const { rows } = await c.query(
            `insert into public.fighters (org_id, fight_name, division) values ($1, $2, 'men') returning fighter_code`,
            [ORG, `Concurrent ${i}`],
          );
          await c.query('commit');
          return rows[0].fighter_code as string;
        } finally {
          c.release();
        }
      }),
    );
    expect(new Set(codes).size).toBe(N);
    const nums = codes.map((s) => Number(s.split('-').at(-1))).sort((a, b) => a - b);
    expect(nums.at(-1)! - nums[0]).toBe(N - 1); // contiguous: no lost or duplicated allocations
  });

  // The counter is transactional: an aborted registration never issued its number (no email can
  // leave before commit, thanks to the outbox), so the next fighter receives it — no gaps. Numbers
  // that WERE issued can never come back: fighters cannot be deleted and codes cannot change.
  it('never reuses an issued ID: aborted allocations leave no gap, fighters cannot be deleted, codes cannot change', async () => {
    const c = await pool.connect();
    let rolledBack: string;
    try {
      await c.query('begin');
      rolledBack = (
        await c.query(`insert into public.fighters (org_id, fight_name, division) values ($1, 'Ghost', 'men') returning fighter_code`, [ORG])
      ).rows[0].fighter_code;
      await c.query('rollback');
    } finally {
      c.release();
    }
    await tx(async (t) => {
      const next = await createFighter(t);
      expect(next.fighter_code).toBe(rolledBack);
      const retired = await t.query(`update public.fighters set status = 'retired' where id = $1 returning fighter_code`, [next.id]);
      expect(retired.rows[0].fighter_code).toBe(next.fighter_code);
      const after = await createFighter(t);
      expect(Number(after.fighter_code.split('-').at(-1))).toBe(Number(next.fighter_code.split('-').at(-1)) + 1);
      expect((await attempt(t, 'delete from public.fighters where id = $1', [next.id]))?.message).toMatch(/append-only/);
      expect(
        (await attempt(t, `update public.fighters set fighter_code = 'WDS-F-0001' where id = $1`, [next.id]))?.message,
      ).toMatch(/cannot be changed/);
    });
  });

  it('keeps formatting correct past 9999', async () => {
    await tx(async (c) => {
      await c.query(`update public.id_counters set last_value = 9999 where org_id = $1 and kind = 'fighter'`, [ORG]);
      const f = await createFighter(c);
      expect(f.fighter_code).toBe('WDS-F-10000');
    });
  });

  it('separates permanent identity from per-event registrations', async () => {
    await tx(async (c) => {
      const ev1 = await createEvent(c);
      const ev2 = await createEvent(c);
      const f = await createFighter(c, { eventId: ev1.id });
      await c.query(
        `insert into public.event_registrations (event_id, fighter_id, submitted_via, division, competition_level)
         values ($1, $2, 'self', 'men', 'amateur')`,
        [ev2.id, f.id],
      );
      const dup = await attempt(
        c,
        `insert into public.event_registrations (event_id, fighter_id, submitted_via, division, competition_level)
         values ($1, $2, 'self', 'men', 'amateur')`,
        [ev2.id, f.id],
      );
      expect(dup?.message).toMatch(/duplicate key/);
    });
  });
});

describe('audit log', () => {
  it('records actor, change and reason, redacting personal data', async () => {
    await tx(async (c) => {
      const admin = await createUser(c, { orgRole: 'org_admin' });
      const f = await createFighter(c);
      await actAs(c, admin);
      await c.query(`update public.fighter_private set email = 'new@example.com' where fighter_id = $1`, [f.id]);
      await c.query(`update public.fighters set nickname = 'The Test' where id = $1`, [f.id]);
      const { rows } = await c.query(
        `select table_name, actor_id, changes from public.audit_logs where record_id = $1 and action = 'update' order by id`,
        [f.id],
      );
      expect(rows).toHaveLength(2);
      expect(rows[0].actor_id).toBe(admin.uid);
      expect(rows[0].changes).toEqual({ email: { redacted: true } });
      expect(JSON.stringify(rows)).not.toContain('new@example.com');
      expect(rows[1].changes.nickname).toEqual({ from: null, to: 'The Test' });
    });
  });

  it('cannot be rewritten or deleted, by admins or by the owner', async () => {
    await tx(async (c) => {
      const admin = await createUser(c, { orgRole: 'org_admin' });
      await createFighter(c);
      await actAs(c, admin);
      expect((await attempt(c, `update public.audit_logs set reason = 'x'`))?.message).toMatch(/permission denied/);
      expect((await attempt(c, `delete from public.audit_logs`))?.message).toMatch(/permission denied/);
      await c.query('reset role');
      expect((await attempt(c, `update public.audit_logs set reason = 'x'`))?.message).toMatch(/append-only/);
      expect((await attempt(c, `delete from public.audit_logs`))?.message).toMatch(/append-only/);
      expect((await attempt(c, `truncate public.audit_logs`))?.message).toMatch(/cannot be truncated/);
    });
  });

  it('is visible only to org admins', async () => {
    await tx(async (c) => {
      const ev = await createEvent(c);
      const staff = await createUser(c, { orgRole: 'staff' });
      await c.query('insert into public.event_admins (event_id, user_id, role) values ($1, $2, $3)', [ev.id, staff.uid, 'event_admin']);
      await actAs(c, staff);
      expect((await c.query('select id from public.audit_logs')).rowCount).toBe(0);
    });
  });
});

describe('registration review', () => {
  it('enforces valid transitions, reasons and queues the notification email', async () => {
    await tx(async (c) => {
      const ev = await createEvent(c);
      const admin = await createUser(c, { orgRole: 'org_admin' });
      const f = await createFighter(c);
      const { rows } = await c.query(
        `insert into public.event_registrations (event_id, fighter_id, submitted_via, division, competition_level, submitted_at)
         values ($1, $2, 'self', 'men', 'amateur', now()) returning id`,
        [ev.id, f.id],
      );
      const reg = rows[0].id;
      await actAs(c, admin);
      expect((await attempt(c, `select public.review_registration($1, 'rejected')`, [reg]))?.message).toMatch(/reason is required/);
      expect((await attempt(c, `select public.review_registration($1, 'incomplete', 'x', '[]')`, [reg]))?.message).toMatch(
        /missing information/,
      );
      await c.query(`select public.review_registration($1, 'incomplete', 'Need photo', '["profile_photo"]')`, [reg]);
      expect((await attempt(c, `select public.review_registration($1, 'approved')`, [reg]))?.message).toMatch(/invalid registration status/);
      await c.query(`select public.review_registration($1, 'under_review')`, [reg]);
      await c.query(`select public.review_registration($1, 'approved')`, [reg]);
      const emails = await c.query(`select template, status from public.email_logs where entity_id = $1 order by created_at`, [reg]);
      expect(emails.rows.map((r) => r.template).sort()).toEqual(['registration_approved', 'registration_incomplete']);
      expect(emails.rows.every((r) => r.status === 'queued')).toBe(true);
    });
  });
});

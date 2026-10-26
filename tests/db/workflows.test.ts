import { randomUUID, createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DEMO_EVENT, ORG, actAs, asOwner, attempt, createEvent, createFighter, createUser, grantEvent, pool, tx, type Db,
} from './helpers';

afterAll(() => pool.end());

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function fighterPayload(over: Record<string, unknown> = {}) {
  return {
    submission_key: randomUUID(),
    event_slug: 'demo-fight-night-1',
    legal_name: 'Test Person',
    fight_name: 'Test Fighter',
    date_of_birth: '1999-04-04',
    email: `${randomUUID().slice(0, 8)}@reg.example.com`,
    division: 'men',
    competition_level: 'amateur',
    weight_g: 70000,
    weight_unit: 'kg',
    wins: 3,
    losses: 1,
    gym_name: 'Brand New Gym',
    city: 'Mumbai',
    country: 'India',
    consent_version: 'v1',
    ...over,
  };
}

async function register(c: Db, p: Record<string, unknown>, actor: string | null = null, coach: string | null = null) {
  await actAs(c, 'service_role');
  const { rows } = await c.query('select public.svc_register_fighter($1, $2, $3) as r', [JSON.stringify(p), actor, coach]);
  await asOwner(c);
  return rows[0].r as Record<string, unknown>;
}

async function errorHint(c: Db, sql: string, params: unknown[]) {
  await c.query('savepoint s');
  try {
    await c.query(sql, params);
    await c.query('release savepoint s');
    return null;
  } catch (e) {
    await c.query('rollback to savepoint s');
    return (e as { hint?: string }).hint ?? (e as Error).message;
  }
}

describe('fighter registration', () => {
  it('creates identity, private record, self-reported record, registration and a confirmation email', async () => {
    await tx(async (c) => {
      const p = fighterPayload();
      const r = await register(c, p);
      expect(r.status).toBe('created');
      expect(r.fighter_code).toMatch(/^WDS-F-\d{4}$/);
      const { rows } = await c.query(
        `select f.fight_name, fp.email, er.status, er.declared_weight_g, er.clearance_status, g.verification_status as gym
           from public.fighters f join public.fighter_private fp on fp.fighter_id = f.id
           join public.event_registrations er on er.fighter_id = f.id join public.gyms g on g.id = f.gym_id
          where f.fighter_code = $1`,
        [r.fighter_code],
      );
      expect(rows[0]).toMatchObject({ fight_name: 'Test Fighter', status: 'submitted', declared_weight_g: 70000, clearance_status: 'pending', gym: 'pending' });
      const mail = await c.query(`select template, payload from public.email_logs where idempotency_key = $1`, [
        `fighter_registration:${p.submission_key}`,
      ]);
      expect(mail.rows[0].template).toBe('fighter_registration_confirmation');
      expect(mail.rows[0].payload.fighter_code).toBe(r.fighter_code);
    });
  });

  it('replays the same result for a duplicate submission (double click)', async () => {
    await tx(async (c) => {
      const p = fighterPayload();
      const a = await register(c, p);
      const b = await register(c, p);
      expect(b.fighter_code).toBe(a.fighter_code);
      expect(b.replayed).toBe(true);
      const n = await c.query(`select count(*)::int as n from public.fighter_private where email = $1`, [p.email]);
      expect(n.rows[0].n).toBe(1);
    });
  });

  it('reuses an identity only when ID + email + DOB all match, and flags likely duplicates', async () => {
    await tx(async (c) => {
      const first = await register(c, fighterPayload({ email: 'same@reg.example.com', event_slug: null }));
      // wrong DOB ⇒ refused
      await actAs(c, 'service_role');
      const hint = await errorHint(c, 'select public.svc_register_fighter($1)', [
        JSON.stringify(fighterPayload({ existing_fighter_code: first.fighter_code, email: 'same@reg.example.com', date_of_birth: '2000-01-01' })),
      ]);
      expect(hint).toBe('identity_mismatch');
      await asOwner(c);
      const reused = await register(c, fighterPayload({ existing_fighter_code: first.fighter_code, email: 'same@reg.example.com' }));
      expect(reused).toMatchObject({ status: 'reused', fighter_code: first.fighter_code });
      // A brand-new submission with the same email creates a new ID but is flagged for review.
      const dupe = await register(c, fighterPayload({ email: 'same@reg.example.com', event_slug: null }));
      expect(dupe.fighter_code).not.toBe(first.fighter_code);
      const flags = await c.query(
        `select match_reason from public.fighter_duplicate_flags fl join public.fighters f on f.id = fl.fighter_id where f.fighter_code = $1`,
        [dupe.fighter_code],
      );
      expect(flags.rows[0].match_reason).toBe('same email');
    });
  });

  it('rejects closed events unless an authorised admin overrides, and rejects unknown divisions', async () => {
    await tx(async (c) => {
      const ev = await createEvent(c, 'closed-evt', { status: 'registration_closed' });
      await actAs(c, 'service_role');
      expect(await errorHint(c, 'select public.svc_register_fighter($1)', [JSON.stringify(fighterPayload({ event_slug: 'closed-evt' }))])).toBe(
        'registration_closed',
      );
      expect(
        await errorHint(c, 'select public.svc_register_fighter($1)', [JSON.stringify(fighterPayload({ division: 'open_weight' }))]),
      ).toBe('division_not_allowed');
      await asOwner(c);
      const admin = await createUser(c, { orgRole: 'org_admin' });
      const outsider = await createUser(c, { orgRole: 'staff' });
      await actAs(c, 'service_role');
      expect(
        await errorHint(c, 'select public.svc_register_fighter($1, $2)', [JSON.stringify(fighterPayload({ event_slug: 'closed-evt' })), outsider.uid]),
      ).toBe('registration_closed');
      await asOwner(c);
      const ok = await register(c, fighterPayload({ event_slug: 'closed-evt' }), admin.uid);
      expect(ok.status).toBe('created');
      const reg = await c.query('select submitted_via, late_override_by from public.event_registrations where event_id = $1', [ev.id]);
      expect(reg.rows[0]).toEqual({ submitted_via: 'admin', late_override_by: admin.uid });
    });
  });

  it('is not callable by anonymous or authenticated users directly', async () => {
    await tx(async (c) => {
      const u = await createUser(c, { orgRole: 'org_admin' });
      for (const who of ['anon', u] as const) {
        await actAs(c, who);
        expect((await attempt(c, 'select public.svc_register_fighter($1)', [JSON.stringify(fighterPayload())]))?.message).toMatch(
          /permission denied/,
        );
      }
    });
  });

  it('coach-submitted fighters are linked to the coach automatically', async () => {
    await tx(async (c) => {
      const coachUser = await createUser(c, { orgRole: 'coach' });
      const { rows } = await c.query(
        `insert into public.coaches (org_id, user_id, full_name, email, verification_status) values ($1, $2, 'Coach', $3, 'verified') returning id`,
        [ORG, coachUser.uid, coachUser.email],
      );
      const r = await register(c, fighterPayload(), coachUser.uid, rows[0].id);
      const link = await c.query(
        `select cf.status from public.coach_fighters cf join public.fighters f on f.id = cf.fighter_id where f.fighter_code = $1`,
        [r.fighter_code],
      );
      expect(link.rows[0].status).toBe('approved');
      await actAs(c, coachUser);
      const visible = await c.query('select fighter_code from public.fighters');
      expect(visible.rows.map((x) => x.fighter_code)).toContain(r.fighter_code);
    });
  });
});

describe('coach registration', () => {
  it('creates a pending coach once and answers identically for repeats (no enumeration)', async () => {
    await tx(async (c) => {
      const base = { event_slug: 'demo-fight-night-1', full_name: 'Coach Test', email: 'coach.x@example.com', gym_name: 'Iron Tide MMA', city: 'Mumbai' };
      await actAs(c, 'service_role');
      const a = await c.query('select public.svc_register_coach($1) as r', [JSON.stringify({ ...base, submission_key: randomUUID() })]);
      const b = await c.query('select public.svc_register_coach($1) as r', [JSON.stringify({ ...base, submission_key: randomUUID() })]);
      await asOwner(c);
      expect(a.rows[0].r).toEqual({ status: 'received' });
      expect(b.rows[0].r).toEqual({ status: 'received' });
      const coaches = await c.query(`select verification_status, gym_id from public.coaches where email = 'coach.x@example.com'`);
      expect(coaches.rows).toHaveLength(1);
      expect(coaches.rows[0]).toEqual({ verification_status: 'pending', gym_id: '00000000-0000-4000-8000-0000000000a1' });
    });
  });
});

async function setupBout(c: Db) {
  const ev = await createEvent(c, `bout-${randomUUID().slice(0, 6)}`, { status: 'matchmaking' });
  const admin = await createUser(c, { orgRole: 'staff' });
  await grantEvent(c, ev.id, admin.uid, 'event_admin');
  const a = await createFighter(c, { eventId: ev.id, name: 'Red Corner' });
  const b = await createFighter(c, { eventId: ev.id, name: 'Blue Corner' });
  return { ev, admin, a, b };
}

async function createViaService(c: Db, actor: string, p: Record<string, unknown>) {
  await actAs(c, 'service_role');
  const { rows } = await c.query('select * from public.svc_create_bout($1, $2)', [actor, JSON.stringify(p)]);
  await asOwner(c);
  return rows[0];
}

async function issue(c: Db, actor: string, boutId: string) {
  const tokens = { A: randomUUID() + randomUUID(), B: randomUUID() + randomUUID() };
  const offers = (['A', 'B'] as const).map((corner) => ({
    id: randomUUID(),
    corner,
    nonce: randomUUID().replace(/-/g, ''),
    token_hash: sha(tokens[corner]),
  }));
  await actAs(c, 'service_role');
  await c.query(`select public.svc_issue_offers($1, $2, now() + interval '3 days', $3)`, [actor, boutId, JSON.stringify(offers)]);
  await asOwner(c);
  return { tokens, offers };
}

async function respond(c: Db, token: string, response: 'accept' | 'decline', reason: string | null = null) {
  await actAs(c, 'service_role');
  const { rows } = await c.query(`select public.svc_respond_offer($1, $2, $3, $4, 'vitest') as r`, [sha(token), response, reason, sha('1.2.3.4')]);
  await asOwner(c);
  return rows[0].r as { ok: boolean; code?: string; bout_status?: string };
}

describe('bout creation', () => {
  it('requires a server evaluation and an override reason for pairings that need review', async () => {
    await tx(async (c) => {
      const { ev, admin, a, b } = await setupBout(c);
      await actAs(c, 'service_role');
      const hint = await errorHint(c, 'select public.svc_create_bout($1, $2)', [
        admin.uid,
        JSON.stringify({ event_id: ev.id, fighter_a_id: a.id, fighter_b_id: b.id, evaluation: { classification: 'requires_review' } }),
      ]);
      expect(hint).toBe('override_required');
      await asOwner(c);
      const bout = await createViaService(c, admin.uid, {
        event_id: ev.id, fighter_a_id: a.id, fighter_b_id: b.id,
        evaluation: { classification: 'requires_review' }, override_reason: 'Both camps agreed after weigh-in check',
      });
      expect(bout.status).toBe('draft');
      expect(bout.override_reason).toMatch(/camps agreed/);
      expect(bout.rounds).toBe(3);
    });
  });

  it('refuses fighters without an approved registration, and users without event access', async () => {
    await tx(async (c) => {
      const { ev, admin, a } = await setupBout(c);
      const outsider = await createFighter(c); // not registered
      const stranger = await createUser(c, { orgRole: 'staff' });
      await actAs(c, 'service_role');
      const p = { event_id: ev.id, fighter_a_id: a.id, fighter_b_id: outsider.id, evaluation: { classification: 'strong_candidate' } };
      expect(await errorHint(c, 'select public.svc_create_bout($1, $2)', [admin.uid, JSON.stringify(p)])).toBe('ineligible');
      expect(await errorHint(c, 'select public.svc_create_bout($1, $2)', [stranger.uid, JSON.stringify(p)])).toBe('forbidden');
    });
  });
});

describe('offers', () => {
  it('full happy path: offer → view → accept × 2 → admin confirms → publish', async () => {
    await tx(async (c) => {
      const { ev, admin, a, b } = await setupBout(c);
      const bout = await createViaService(c, admin.uid, { event_id: ev.id, fighter_a_id: a.id, fighter_b_id: b.id, evaluation: { classification: 'strong_candidate' } });
      const { tokens } = await issue(c, admin.uid, bout.id);

      const emails = await c.query(`select template, payload from public.email_logs where entity_type = 'offer' and template = 'bout_offer'`);
      expect(emails.rows.filter((r) => r.payload.event_name === `Event ${ev.slug}`)).toHaveLength(2);
      expect(JSON.stringify(emails.rows)).not.toContain(tokens.A);

      await actAs(c, 'service_role');
      const view = (await c.query('select public.svc_get_offer($1) as v', [sha(tokens.A)])).rows[0].v;
      await asOwner(c);
      expect(view).toMatchObject({ ok: true, can_respond: true, status: 'pending' });
      expect(view.terms.opponent.fight_name).toBe('Blue Corner');
      expect(JSON.stringify(view)).not.toMatch(/Legal Name|fighter\.example\.com|1998-01-01/);
      expect((await c.query('select status from public.bouts where id = $1', [bout.id])).rows[0].status).toBe('awaiting_responses');

      expect(await respond(c, tokens.A, 'accept')).toMatchObject({ ok: true, bout_status: 'accepted_one' });
      expect(await respond(c, tokens.A, 'accept')).toEqual({ ok: false, code: 'already_responded' }); // replay
      expect(await respond(c, tokens.B, 'accept')).toMatchObject({ ok: true, bout_status: 'accepted_both' });

      // Both accepted is NOT confirmed — an admin must confirm.
      expect((await c.query('select status, is_published from public.bouts where id = $1', [bout.id])).rows[0]).toEqual({ status: 'accepted_both', is_published: false });
      await actAs(c, admin);
      await c.query(`select public.transition_bout($1, 'confirmed', 'Confirmed after medicals')`, [bout.id]);
      await c.query(`select public.set_bout_published($1, true)`, [bout.id]);
      await asOwner(c);
      const adminMails = await c.query(`select template from public.email_logs where entity_id = $1 order by created_at`, [bout.id]);
      const t = adminMails.rows.map((r) => r.template);
      expect(t).toContain('admin_offer_accepted');
      expect(t).toContain('admin_both_accepted');
      expect(t).toContain('bout_confirmed');
    });
  });

  it('a decline withdraws the other offer and flags the bout; the declined fighter is released for a replacement', async () => {
    await tx(async (c) => {
      const { ev, admin, a, b } = await setupBout(c);
      const bout = await createViaService(c, admin.uid, { event_id: ev.id, fighter_a_id: a.id, fighter_b_id: b.id, evaluation: { classification: 'strong_candidate' } });
      const { tokens } = await issue(c, admin.uid, bout.id);
      expect(await respond(c, tokens.B, 'decline', 'Injured')).toMatchObject({ ok: true, bout_status: 'declined' });
      expect(await respond(c, tokens.A, 'accept')).toMatchObject({ ok: false, code: 'withdrawn' });
      const reason = await c.query(`select decline_reason from public.bout_responses where bout_id = $1`, [bout.id]);
      expect(reason.rows[0].decline_reason).toBe('Injured');

      // Replacement: new opponent for A, history preserved.
      const d = await createFighter(c, { eventId: ev.id, name: 'Late Replacement' });
      const repl = await createViaService(c, admin.uid, {
        event_id: ev.id, fighter_a_id: a.id, fighter_b_id: d.id, replaces_bout_id: bout.id,
        evaluation: { classification: 'possible_candidate' },
      });
      expect(repl.replaces_bout_id).toBe(bout.id);
      const old = await c.query(`select status from public.bouts where id = $1`, [bout.id]);
      expect(old.rows[0].status).toBe('cancelled');
    });
  });

  it('expired offers are expired by the scheduled job and cannot be answered', async () => {
    await tx(async (c) => {
      const { ev, admin, a, b } = await setupBout(c);
      const bout = await createViaService(c, admin.uid, { event_id: ev.id, fighter_a_id: a.id, fighter_b_id: b.id, evaluation: { classification: 'strong_candidate' } });
      const { tokens } = await issue(c, admin.uid, bout.id);
      await respond(c, tokens.A, 'accept');
      await c.query(`update public.bout_offers set expires_at = now() - interval '1 minute' where bout_id = $1`, [bout.id]);
      expect(await respond(c, tokens.B, 'accept')).toEqual({ ok: false, code: 'expired' });
      await actAs(c, 'service_role');
      const n = (await c.query('select public.svc_expire_offers() as n')).rows[0].n;
      await asOwner(c);
      expect(n).toBeGreaterThanOrEqual(1);
      const st = await c.query(`select b.status, array_agg(o.status::text order by o.corner) as offers
        from public.bouts b join public.bout_offers o on o.bout_id = b.id where b.id = $1 group by b.status`, [bout.id]);
      expect(st.rows[0]).toEqual({ status: 'expired', offers: ['accepted', 'expired'] });
      // Re-offer creates a new version; old tokens stop working.
      const second = await issue(c, admin.uid, bout.id);
      expect(await respond(c, tokens.B, 'accept')).toMatchObject({ ok: false });
      expect(await respond(c, second.tokens.B, 'accept')).toMatchObject({ ok: true, bout_status: 'accepted_one' });
    });
  });

  it('putting a bout under review revokes pending offer links', async () => {
    await tx(async (c) => {
      const { ev, admin, a, b } = await setupBout(c);
      const bout = await createViaService(c, admin.uid, { event_id: ev.id, fighter_a_id: a.id, fighter_b_id: b.id, evaluation: { classification: 'strong_candidate' } });
      const { tokens } = await issue(c, admin.uid, bout.id);
      await actAs(c, admin);
      await c.query(`select public.transition_bout($1, 'under_review', 'Weight changed')`, [bout.id]);
      await asOwner(c);
      expect(await respond(c, tokens.A, 'accept')).toEqual({ ok: false, code: 'revoked' });
    });
  });

  it('event date/venue changes notify fighters with live bouts', async () => {
    await tx(async (c) => {
      const { ev, admin, a, b } = await setupBout(c);
      const bout = await createViaService(c, admin.uid, { event_id: ev.id, fighter_a_id: a.id, fighter_b_id: b.id, evaluation: { classification: 'strong_candidate' } });
      await issue(c, admin.uid, bout.id);
      await actAs(c, admin);
      await c.query(`update public.events set venue_name = 'New Arena' where id = $1`, [ev.id]);
      await asOwner(c);
      const n = await c.query(`select count(*)::int as n from public.email_logs where template = 'event_updated' and entity_id = $1`, [bout.id]);
      expect(n.rows[0].n).toBe(2);
    });
  });
});

describe('email dispatch', () => {
  it('claims with SKIP LOCKED, marks sent only with a provider id, backs off and finally fails', async () => {
    await tx(async (c) => {
      await c.query(`update public.email_logs set status = 'cancelled' where status = 'queued'`);
      await c.query(
        `insert into public.email_logs (org_id, template, to_email, idempotency_key, max_attempts) values ($1, 'test_mail', 'a@example.com', 'test:a:1', 2), ($1, 'test_mail', 'b@example.com', 'test:b:1', 2)`,
        [ORG],
      );
      await actAs(c, 'service_role');
      const claimed = await c.query('select id, to_email, attempts from public.svc_claim_emails(10)');
      expect(claimed.rows).toHaveLength(2);
      const [x, y] = claimed.rows;
      await c.query(`select public.svc_email_sent($1, 'prov_123')`, [x.id]);
      await c.query(`select public.svc_email_failed($1, 'timeout')`, [y.id]);
      expect((await c.query('select count(*)::int as n from public.svc_claim_emails(10)')).rows[0].n).toBe(0); // backoff
      await asOwner(c);
      await c.query(`update public.email_logs set next_attempt_at = now() where id = $1`, [y.id]);
      await actAs(c, 'service_role');
      await c.query('select * from public.svc_claim_emails(10)');
      await c.query(`select public.svc_email_failed($1, 'timeout again')`, [y.id]);
      await asOwner(c);
      const st = await c.query('select id, status, attempts, provider_message_id from public.email_logs where id = any($1)', [[x.id, y.id]]);
      const byId = new Map(st.rows.map((r) => [r.id, [r.status, r.attempts, r.provider_message_id]]));
      expect([byId.get(x.id), byId.get(y.id)]).toEqual([
        ['sent', 1, 'prov_123'],
        ['failed', 2, null],
      ]);
      // Admin retry
      const admin = await createUser(c, { orgRole: 'org_admin' });
      await actAs(c, admin);
      const r = await c.query('select status from public.retry_email($1)', [y.id]);
      expect(r.rows[0].status).toBe('queued');
    });
  });

  it('a "sent" status without a provider id is impossible', async () => {
    await tx(async (c) => {
      const err = await attempt(
        c,
        `insert into public.email_logs (org_id, template, to_email, idempotency_key, status) values ($1, 'test_mail', 'a@example.com', 'test:c:1', 'sent')`,
        [ORG],
      );
      expect(err?.message).toMatch(/check constraint/);
    });
  });
});

describe('rate limiting', () => {
  it('allows up to the limit within a window', async () => {
    await tx(async (c) => {
      await actAs(c, 'service_role');
      const results: boolean[] = [];
      for (let i = 0; i < 4; i++) results.push((await c.query(`select public.svc_rate_limit('t:1', 3, 60) as ok`)).rows[0].ok);
      expect(results).toEqual([true, true, true, false]);
    });
  });
});

describe('merging duplicate profiles', () => {
  it('moves registrations, retires the duplicate ID and records the reason', async () => {
    await tx(async (c) => {
      const admin = await createUser(c, { orgRole: 'org_admin' });
      const ev = await createEvent(c);
      const keep = await createFighter(c);
      const drop = await createFighter(c, { eventId: ev.id });
      await actAs(c, admin);
      expect((await attempt(c, 'select public.merge_fighters($1, $2, $3)', [keep.id, drop.id, ' ']))?.message).toMatch(/reason/);
      await c.query('select public.merge_fighters($1, $2, $3)', [keep.id, drop.id, 'Same person, registered twice']);
      await asOwner(c);
      const reg = await c.query('select fighter_id from public.event_registrations where event_id = $1', [ev.id]);
      expect(reg.rows[0].fighter_id).toBe(keep.id);
      const d = await c.query('select status, merged_into, fighter_code from public.fighters where id = $1', [drop.id]);
      expect(d.rows[0]).toEqual({ status: 'merged', merged_into: keep.id, fighter_code: drop.fighter_code });
      const audit = await c.query(`select reason from public.audit_logs where table_name = 'fighters' and record_id = $1 order by id desc limit 1`, [drop.id]);
      expect(audit.rows[0].reason).toBe('Same person, registered twice');
    });
  });
});

describe('events', () => {
  it('new events get their own copy of weight classes and rules, editable independently', async () => {
    await tx(async (c) => {
      const ev = await createEvent(c);
      const n = await c.query('select count(*)::int as n from public.weight_classes where event_id = $1', [ev.id]);
      expect(n.rows[0].n).toBe(12);
      const r = await c.query('select config ->> $2 as v from public.matchmaking_rules where event_id = $1', [ev.id, 'max_experience_gap_hard']);
      expect(r.rows[0].v).toBe('8');
    });
  });

  it('admin overview counts only what the caller can see', async () => {
    await tx(async (c) => {
      const ev = await createEvent(c);
      await createFighter(c, { eventId: ev.id });
      const staff = await createUser(c, { orgRole: 'staff' });
      await grantEvent(c, ev.id, staff.uid, 'event_admin');
      await actAs(c, staff);
      const o = (await c.query('select public.admin_overview() as o')).rows[0].o;
      expect(o.fighters).toBe(1);
      expect(o.active_events).toBe(0); // draft
      await asOwner(c);
      void DEMO_EVENT;
    });
  });
});

// Smoke test: every route renders against a fake Supabase client without crashing,
// and public pages never render admin controls.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { Session } from '@supabase/supabase-js';

const EVENT = {
  id: 'e1', org_id: 'o1', event_code: 'WDS-E-001', slug: 'demo', name: 'Demo Night', promotion: 'Demo', description: 'Desc', branding: {},
  registration_opens_at: null, registration_closes_at: null, starts_at: null, timezone: 'UTC', venue_name: null, venue_address: null, venue_city: 'Mumbai',
  venue_country: 'India', status: 'registration_open', is_public: true, fight_card_published: true, allow_late_registration: false, rules_text: null,
  default_rounds: 3, default_round_minutes: 5, offer_validity_hours: 72, notify_coaches: true, eligibility: { divisions: ['men'] },
  registration_open: true, weight_classes: [{ id: 'w1', name: 'Lightweight', division: 'men', min_g: 65771, max_g: 70307 }],
  divisions: ['men'], competition_levels: ['amateur'], required_documents: [],
};
const FIGHTER_JSON = { fight_name: 'Alpha', nickname: null, country: 'India', hometown: null, photo_path: null, gym: 'Iron Tide', primary_style: null, record: { wins: 3, losses: 1, draws: 0, no_contests: 0 } };
const RPC: Record<string, unknown> = {
  my_access: { user_id: 'u1', is_super_admin: false, org_roles: [{ org_id: 'o1', role: 'org_admin' }], event_roles: [], coach_id: null },
  admin_overview_fresh: { fighters: 2, coaches: 1, gyms: 1, active_events: 1, pending_registrations: 1, fighters_by_weight_class: [{ name: 'Lightweight', division: 'men', n: 2 }], open_suggestions: 0, outstanding_offers: 0, accepted_offers: 0, declined_offers: 0, confirmed_bouts: 1, email_failures: 0, upcoming_events: [{ id: 'e1', name: 'Demo Night', slug: 'demo', starts_at: null, status: 'registration_open' }] },
  get_match_suggestions: {
    refreshed_at: '2026-10-27T08:00:00Z',
    stats: { registrants: 4, approved: 3, ready: 2, awaiting_review: 1 },
    suggestions: [{
      id: 's1', fighter_a_id: 'fa', fighter_b_id: 'fb', score: 81.5, classification: 'strong_candidate',
      fighter_a: { fight_name: 'Night Hawk', fighter_code: 'WDS-F-0001', weight_g: 70000, division: 'men' },
      fighter_b: { fight_name: 'The Viper', fighter_code: 'WDS-F-0002', weight_g: 70400, division: 'men' },
      evaluation: { fighter_a_id: 'fa', fighter_b_id: 'fb', score: 81.5, classification: 'strong_candidate', proposed_weight_class: { id: 'w1', name: 'Lightweight' }, weight_diff_g: 400,
        components: { weight: { score: 0.8, detail: '0.4 kg apart (limit 2.3 kg)' }, experience: { score: 1, detail: '4 vs 4 fights' }, record: { score: 1, detail: '3-1-0 vs 3-1-0' }, age: { score: 1, detail: '25 vs 25 years' }, skill: { score: null, detail: 'Skill level not provided' } },
        explanation: ['Weights 0.4 kg apart (limit 2.3 kg), proposed Lightweight.'], missing: [], issues: [] },
    }],
  },
  public_list_events: [EVENT],
  public_get_event: [EVENT],
  public_registration_event: [EVENT],
  public_list_gyms: [{ id: 'g1', name: 'Iron Tide', city: 'Mumbai' }],
  public_get_fight_card: [{ bout_code: 'WDS-B-0001', card_order: 1, card_segment: 'main_card', weight_class: 'Lightweight', weight_limit_g: 70307, division: 'men', rounds: 3, round_minutes: 5, status: 'confirmed', fighter_a: FIGHTER_JSON, fighter_b: { ...FIGHTER_JSON, fight_name: 'Bravo' } }],
};
const SINGLE: Record<string, unknown> = {
  events: EVENT,
  organizations: { id: 'o1', name: 'Demo', slug: 'demo', fighter_id_prefix: 'WDS', contact_email: null, branding: {} },
  fighters: {
    id: 'f1', org_id: 'o1', fighter_code: 'WDS-F-0001', fight_name: 'Alpha', nickname: null, division: 'men', competition_level: 'amateur', primary_style: null, skill_level: null,
    height_cm: null, reach_cm: null, hometown: null, country: 'India', bio: null, photo_path: null, public_photo_path: null, public_profile_approved: false, status: 'active',
    merged_into: null, registered_at: '2026-10-01T00:00:00Z', gyms: null,
    fighter_private: { legal_name: 'A', date_of_birth: '1999-01-01', email: 'a@x.co', phone_country_code: '+91', phone: '123456', city: null, country: null, mma_experience_years: null, previous_experience: null, coach_name_declared: null, consent_at: '2026-10-01T00:00:00Z' },
    fighter_records: [{ id: 'r1', kind: 'self_reported', wins: 3, losses: 1, draws: 0, no_contests: 0, ko_tko_wins: null, submission_wins: null, decision_wins: null, verified_at: null, source_note: null }],
    event_registrations: [{ id: 'reg1', event_id: 'e1', status: 'submitted', submitted_via: 'self', declared_weight_g: 70000, weight_recorded_at: null, division: 'men', competition_level: 'amateur', is_available: true, availability_notes: null, clearance_status: 'pending', missing_info: [], review_notes: null, rejection_reason: null, submitted_at: null, events: { name: 'Demo Night' }, weight_classes: null, registration_documents: [] }],
  },
};

function query(table: string) {
  let single = false;
  const result = () => Promise.resolve({ data: single ? (SINGLE[table] ?? null) : table === 'events' ? [EVENT] : [], error: null, count: 0 });
  const q: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => result().then(res, rej);
        if (prop === 'single' || prop === 'maybeSingle') {
          single = true;
          return () => q;
        }
        return () => q;
      },
    },
  );
  return q;
}

vi.mock('@/lib/supabase', () => ({
  configError: null,
  siteUrl: 'https://fights.example.com',
  friendlyError: (e: unknown) => String((e as Error)?.message ?? e),
  supabase: {
    from: (t: string) => query(t),
    rpc: (name: string) => Promise.resolve({ data: RPC[name] ?? null, error: null }),
    storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: '' } }), createSignedUrl: async () => ({ data: null, error: null }) }) },
    auth: { getSession: async () => ({ data: { session: null } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
  },
}));

vi.mock('@/lib/env', async (orig) => ({
  ...(await orig<typeof import('@/lib/env')>()),
  readEnv: () => ({ ok: true, env: { VITE_SUPABASE_URL: 'https://x.supabase.co', VITE_SUPABASE_ANON_KEY: 'anon' } }),
}));

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.open = false; };
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ ok: true, status: 'pending', can_respond: true, expires_at: '2026-12-01T00:00:00Z', responded_at: null, fighter: { fight_name: 'Alpha', fighter_code: 'WDS-F-0001' }, terms: { bout_code: 'B1', event_name: 'Demo Night', starts_at: null, timezone: 'UTC', venue_name: null, venue_city: null, weight_class: 'Lightweight', weight_limit_g: 70307, contracted_weight_g: null, rounds: 3, round_minutes: 5, rules_text: null, opponent: { fight_name: 'Bravo', nickname: null, country: null, gym: null, primary_style: null, height_cm: null, reach_cm: null, declared_weight_g: 70000, record: null } } }), { status: 200 }),
  ) as unknown as typeof fetch;
});
afterEach(cleanup);

async function renderRoute(path: string, signedIn = true) {
  const { routes } = await import('@/router');
  const { AuthContext } = await import('@/lib/auth');
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const session = signedIn ? ({ user: { id: 'u1', email: 'admin@example.com' } } as unknown as Session) : null;
  render(
    <AuthContext.Provider value={{ session, access: signedIn ? (RPC.my_access as never) : null, loading: false, signIn: async () => null, signOut: async () => {}, refreshAccess: async () => {} }}>
      <RouterProvider router={router} />
    </AuthContext.Provider>,
  );
}

const cases: [string, RegExp, boolean?][] = [
  ['/events', /Demo Night/, false],
  ['/events/demo', /Register as a fighter/, false],
  ['/events/demo/fight-card', /Bravo/, false],
  ['/register?event=demo', /Coach or gym/, false],
  ['/register/fighter?event=demo', /Submit registration/, false],
  ['/register/coach?event=demo', /Submit registration/, false],
  ['/offers/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ', /Your opponent/, false],
  ['/coach', /Coach sign in/, false],
  ['/admin/dashboard', /Pending registrations/],
  ['/admin/events', /Demo Night/],
  ['/admin/events/e1', /Save event/],
  ['/admin/fighters', /No fighters found/],
  ['/admin/fighters/f1', /Event registrations/],
  ['/admin/coaches', /No coaches/],
  ['/admin/gyms', /No gyms/],
  ['/admin/matchmaking?event=e1', /Ready to match/],
  ['/admin/bouts?event=e1', /No bouts yet/],
  ['/admin/fight-cards?event=e1', /Publish card|Unpublish card/],
  ['/admin/emails', /No emails/],
  ['/admin/audit-logs', /No audit entries/],
  ['/admin/settings', /Fighter ID prefix/],
  ['/admin/account', /New password/],
];

describe('route smoke tests', () => {
  it.each(cases)('%s renders', async (path, text, signedIn = true) => {
    await renderRoute(path, signedIn);
    await waitFor(() => expect(screen.getAllByText(text).length).toBeGreaterThan(0), { timeout: 4000 });
    expect(screen.queryByText(/Unexpected Application Error/)).toBeNull();
  });

  it('public pages contain no admin controls or private data', async () => {
    await renderRoute('/events/demo/fight-card', false);
    await waitFor(() => screen.getByText('Bravo'));
    expect(screen.queryByRole('button', { name: /publish|edit|delete|approve/i })).toBeNull();
    expect(document.body.textContent).not.toMatch(/@|date of birth|legal name/i);
  });

  it('matchmaking shows automatic suggestions with no generate button or manual pairing', async () => {
    await renderRoute('/admin/matchmaking?event=e1');
    await waitFor(() => screen.getByText('The Viper'));
    expect(screen.getByText('Night Hawk')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create bout' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Generate suggestions/ })).toBeNull();
    expect(screen.queryByText(/Manual matchup/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /Evaluate & create/ })).toBeNull();
  });

  it('admin routes redirect anonymous visitors to sign-in', async () => {
    await renderRoute('/admin/fighters', false);
    await waitFor(() => screen.getByText(/Admin/));
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });
});

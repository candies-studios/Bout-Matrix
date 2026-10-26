export interface Access {
  user_id: string;
  is_super_admin: boolean;
  org_roles: { org_id: string; role: 'super_admin' | 'org_admin' | 'staff' | 'coach' }[];
  event_roles: { event_id: string; role: 'event_admin' | 'matchmaker' }[];
  coach_id: string | null;
}

/** Can this user use the admin portal at all? (The database still checks every request.) */
export function isAdminUser(a: Access | null): boolean {
  if (!a) return false;
  return a.is_super_admin || a.org_roles.some((r) => r.role === 'org_admin' || (r.role === 'staff' && a.event_roles.length > 0));
}

export function isOrgAdmin(a: Access | null): boolean {
  return !!a && (a.is_super_admin || a.org_roles.some((r) => r.role === 'org_admin'));
}


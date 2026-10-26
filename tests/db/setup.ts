// Global setup for database tests: builds a throwaway database from the Supabase shim,
// every migration in order, and the synthetic seed.
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pg from 'pg';

const root = resolve(import.meta.dirname, '../..');
export const TEST_DB = process.env.TEST_DB_NAME ?? 'mma_test';
const adminConfig = {
  host: process.env.PGHOST ?? '/tmp',
  port: Number(process.env.PGPORT ?? 54329),
  user: process.env.PGUSER ?? 'postgres',
  database: 'postgres',
};

export default async function setup() {
  const admin = new pg.Client(adminConfig);
  await admin.connect();
  await admin.query(`drop database if exists ${TEST_DB} with (force)`);
  await admin.query(`create database ${TEST_DB}`);
  await admin.end();

  const db = new pg.Client({ ...adminConfig, database: TEST_DB });
  await db.connect();
  const files = [
    join(root, 'supabase/tests/shim/00_supabase_shim.sql'),
    ...readdirSync(join(root, 'supabase/migrations'))
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => join(root, 'supabase/migrations', f)),
    join(root, 'supabase/seed.sql'),
  ];
  for (const f of files) {
    try {
      await db.query(readFileSync(f, 'utf8'));
    } catch (e) {
      throw new Error(`Failed applying ${f}: ${(e as Error).message}`);
    }
  }
  await db.end();
}

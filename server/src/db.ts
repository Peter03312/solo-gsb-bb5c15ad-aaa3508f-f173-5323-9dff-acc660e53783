import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from './db/schema.js';
import { seed } from './db/seed.js';

const DB_PATH = process.env.DB_PATH ?? '/data/app.db';

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export interface UserRow {
  id: number;
  username: string;
  display_name: string;
  password_hash: string;
  role: 'checker' | 'librarian';
  created_at: string;
}

export interface LabelRow {
  id: number;
  title: string;
  subtitle: string;
  current_version: number;
  created_at: string;
  updated_at: string;
}

export interface LabelVersionRow {
  id: number;
  label_id: number;
  version: number;
  body: string;
  created_at: string;
}

export interface SuggestionRow {
  id: number;
  label_id: number;
  author_id: number;
  author_name: string;
  sel_start: number;
  sel_end: number;
  selected_text: string;
  replacement: string;
  basis: string;
  status: 'pending' | 'conflict' | 'adopted';
  range_version: number;
  based_on_version: number;
  conflict_reason: string | null;
  adopted_in_version: number | null;
  created_at: string;
  updated_at: string;
}

export interface PublicationRow {
  id: number;
  label_id: number;
  label_version: number;
  body: string;
  published_by: number;
  publisher_name: string;
  published_at: string;
  note: string;
}

/** 幂等初始化：建表 → 播种演示数据。 */
export function initDatabase(): void {
  db.exec(SCHEMA_SQL);
  seed(db);
}

export type Role = 'checker' | 'librarian';

export interface User {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  createdAt: string;
  sessionExpiresAt?: string;
}

export interface Label {
  id: number;
  title: string;
  subtitle: string;
  currentVersion: number;
  body: string;
  updatedAt: string;
  createdAt: string;
}

export type SuggestionStatus = 'pending' | 'conflict' | 'adopted';

export interface Suggestion {
  id: number;
  labelId: number;
  authorName: string;
  start: number;
  end: number;
  selectedText: string;
  replacement: string;
  basis: string;
  status: SuggestionStatus;
  rangeVersion: number;
  basedOnVersion: number;
  conflictReason: string | null;
  adoptedInVersion: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface PublicationSummary {
  id: number;
  labelId: number;
  labelVersion: number;
  publishedBy: string;
  publishedAt: string;
  note: string;
  adoptionCount: number;
}

export interface PublicationAdoption {
  id: number;
  suggestion_id: number;
  sel_start: number;
  sel_end: number;
  selected_text: string;
  replacement: string;
  basis: string;
  author_name: string;
  adopted_in_version: number;
}

export interface Publication extends PublicationSummary {
  body: string;
  adoptions: PublicationAdoption[];
}

export interface DiffOp {
  type: 'equal' | 'insert' | 'delete';
  value: string;
}

export interface DiffResult {
  from: { id: number; labelVersion: number; publishedAt: string };
  to: { id: number; labelVersion: number; publishedAt: string };
  ops: DiffOp[];
  stats: { equal: number; insert: number; delete: number };
}

export interface AdoptResponse {
  adopted: Suggestion;
  conflicts: Suggestion[];
  moved: Suggestion[];
  label: { currentVersion: number; body: string };
}

export interface BatchAdoptResponse {
  adopted: Suggestion[];
  conflicts: Suggestion[];
  moved: Suggestion[];
  label: { currentVersion: number; body: string };
}

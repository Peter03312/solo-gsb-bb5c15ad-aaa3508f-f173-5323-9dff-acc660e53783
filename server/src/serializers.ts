import type { SuggestionRow } from './db.js';

const SUGGESTION_SELECT = `
  SELECT s.*, u.display_name AS author_name
    FROM suggestions s JOIN users u ON u.id = s.author_id
`;

export { SUGGESTION_SELECT };

export function serializeSuggestion(s: SuggestionRow) {
  return {
    id: s.id,
    labelId: s.label_id,
    authorName: s.author_name,
    start: s.sel_start,
    end: s.sel_end,
    selectedText: s.selected_text,
    replacement: s.replacement,
    basis: s.basis,
    status: s.status,
    rangeVersion: s.range_version,
    basedOnVersion: s.based_on_version,
    conflictReason: s.conflict_reason,
    adoptedInVersion: s.adopted_in_version,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  };
}

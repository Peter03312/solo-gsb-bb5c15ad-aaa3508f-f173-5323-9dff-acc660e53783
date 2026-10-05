import { Router } from 'express';
import { db, type LabelRow, type LabelVersionRow } from '../db.js';
import { requireAuth } from '../auth.js';

export const labelsRouter = Router();

function serializeLabel(row: LabelRow, currentBody: string) {
  return {
    id: row.id,
    title: row.title,
    subtitle: row.subtitle,
    currentVersion: row.current_version,
    body: currentBody,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
  };
}

labelsRouter.get('/', (_req, res) => {
  const rows = db.prepare('SELECT * FROM labels ORDER BY id').all() as LabelRow[];
  const getBody = db.prepare(
    'SELECT body FROM label_versions WHERE label_id = ? AND version = ?',
  );
  res.json({
    labels: rows.map((row) => {
      const v = getBody.get(row.id, row.current_version) as LabelVersionRow;
      return serializeLabel(row, v.body);
    }),
  });
});

labelsRouter.get('/:id', (req, res) => {
  requireAuth(req);
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM labels WHERE id = ?').get(id) as
    | LabelRow
    | undefined;
  if (!row) {
    res.status(404).json({ error: '展签不存在' });
    return;
  }
  const v = db
    .prepare('SELECT body FROM label_versions WHERE label_id = ? AND version = ?')
    .get(id, row.current_version) as LabelVersionRow;
  res.json({ label: serializeLabel(row, v.body) });
});

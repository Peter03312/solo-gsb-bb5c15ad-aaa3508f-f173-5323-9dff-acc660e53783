import { Router } from 'express';
import {
  db,
  type LabelRow,
  type LabelVersionRow,
  type PublicationRow,
  type SuggestionRow,
} from '../db.js';
import { requireAuth, requireRole } from '../auth.js';
import { HttpError } from '../http-error.js';
import { diffTexts, type DiffOp } from '../diff.js';

export const publicationsRouter = Router();

function serializePublication(p: PublicationRow, adoptionCount: number) {
  return {
    id: p.id,
    labelId: p.label_id,
    labelVersion: p.label_version,
    publishedBy: p.publisher_name,
    publishedAt: p.published_at,
    note: p.note,
    adoptionCount,
  };
}

function listPublications(labelId: number): unknown[] {
  const rows = db
    .prepare(
      `SELECT p.*, u.display_name AS publisher_name
         FROM publications p JOIN users u ON u.id = p.published_by
        WHERE p.label_id = ?
        ORDER BY p.label_version`,
    )
    .all(labelId) as PublicationRow[];
  return rows.map((p) => {
    const count = db
      .prepare('SELECT COUNT(*) AS c FROM publication_adoptions WHERE publication_id = ?')
      .get(p.id) as { c: number };
    return serializePublication(p, count.c);
  });
}

/** 某展签的发布历史。 */
publicationsRouter.get('/labels/:labelId/publications', (req, res) => {
  requireAuth(req);
  const labelId = Number(req.params.labelId);
  res.json({ publications: listPublications(labelId) });
});

/** 发布：固化当前正文及全部采纳记录（快照不可变）。 */
publicationsRouter.post('/labels/:labelId/publish', (req, res) => {
  const user = requireRole(req, 'librarian');
  const labelId = Number(req.params.labelId);
  const { expectedVersion, note } = req.body ?? {};

  const label = db
    .prepare('SELECT * FROM labels WHERE id = ?')
    .get(labelId) as LabelRow | undefined;
  if (!label) throw new HttpError(404, '展签不存在', 'not_found');

  if (!Number.isInteger(expectedVersion)) {
    throw new HttpError(400, '缺少发布所依据的正文版本号 expectedVersion', 'invalid_input');
  }
  // 并发保护：页面停留在旧版本时拒绝发布
  if (expectedVersion !== label.current_version) {
    throw new HttpError(
      409,
      `发布所依据的正文版本 v${expectedVersion} 已过期，当前为 v${label.current_version}，请刷新核对后再发布`,
      'version_stale',
    );
  }

  // 同一版本只允许发布一次：旧发布不可改写、不可覆盖
  const existing = db
    .prepare('SELECT id FROM publications WHERE label_id = ? AND label_version = ?')
    .get(labelId, label.current_version);
  if (existing) {
    throw new HttpError(
      409,
      `正文 v${label.current_version} 已发布，不能重复发布；可在有新采纳后发布新版本`,
      'already_published',
    );
  }

  const current = db
    .prepare('SELECT body FROM label_versions WHERE label_id = ? AND version = ?')
    .get(labelId, label.current_version) as LabelVersionRow;
  const now = new Date().toISOString();
  const noteText = typeof note === 'string' ? note.trim().slice(0, 500) : '';

  const result = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO publications
           (label_id, label_version, body, published_by, published_at, note)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(labelId, label.current_version, current.body, user.id, now, noteText);
    const publicationId = Number(info.lastInsertRowid);

    // 固化全部采纳记录（坐标取该建议在当前正文中的位置，即采纳后形态）
    const adopted = db
      .prepare(
        `SELECT s.*, u.display_name AS author_name
           FROM suggestions s JOIN users u ON u.id = s.author_id
          WHERE s.label_id = ? AND s.status = 'adopted'
          ORDER BY s.id`,
      )
      .all(labelId) as SuggestionRow[];

    const insertPa = db.prepare(
      `INSERT INTO publication_adoptions
         (publication_id, suggestion_id, sel_start, sel_end, selected_text,
          replacement, basis, author_name, adopted_in_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const s of adopted) {
      insertPa.run(
        publicationId, s.id, s.sel_start, s.sel_end, s.selected_text,
        s.replacement, s.basis, s.author_name, s.adopted_in_version,
      );
    }
    return publicationId;
  })();

  res.status(201).json({
    publication: listPublications(labelId).find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (p: any) => p.id === result,
    ),
  });
});

/** 发布详情：含固化正文与采纳清单（只读取快照，不随后续编辑改变）。 */
publicationsRouter.get('/publications/:id', (req, res) => {
  requireAuth(req);
  const id = Number(req.params.id);
  const pub = db
    .prepare(
      `SELECT p.*, u.display_name AS publisher_name
         FROM publications p JOIN users u ON u.id = p.published_by
        WHERE p.id = ?`,
    )
    .get(id) as PublicationRow | undefined;
  if (!pub) throw new HttpError(404, '发布记录不存在', 'not_found');

  const adoptions = db
    .prepare(
      `SELECT * FROM publication_adoptions WHERE publication_id = ? ORDER BY sel_start`,
    )
    .all(id);

  res.json({
    publication: {
      id: pub.id,
      labelId: pub.label_id,
      labelVersion: pub.label_version,
      body: pub.body,
      publishedBy: pub.publisher_name,
      publishedAt: pub.published_at,
      note: pub.note,
      adoptions,
    },
  });
});

/** 两次发布的正文差异（from → to，默认相邻版本，均从不可变快照读取）。 */
publicationsRouter.get('/labels/:labelId/diff', (req, res) => {
  requireAuth(req);
  const labelId = Number(req.params.labelId);
  const pubs = db
    .prepare(
      `SELECT * FROM publications WHERE label_id = ? ORDER BY label_version`,
    )
    .all(labelId) as PublicationRow[];
  if (pubs.length < 2) {
    throw new HttpError(400, '至少需要两次发布才能比较正文差异', 'no_diff');
  }

  const fromVersion = req.query.from
    ? Number(req.query.from)
    : pubs[pubs.length - 2].label_version;
  const toVersion = req.query.to
    ? Number(req.query.to)
    : pubs[pubs.length - 1].label_version;

  const from = pubs.find((p) => p.label_version === fromVersion);
  const to = pubs.find((p) => p.label_version === toVersion);
  if (!from || !to) {
    throw new HttpError(404, '指定的发布版本不存在', 'not_found');
  }
  if (from.label_version >= to.label_version) {
    throw new HttpError(400, '参数 from 必须早于 to', 'invalid_input');
  }

  const ops: DiffOp[] = diffTexts(from.body, to.body);
  const stats = {
    equal: 0,
    insert: 0,
    delete: 0,
  };
  for (const op of ops) stats[op.type] += op.value.length;

  res.json({
    from: { id: from.id, labelVersion: from.label_version, publishedAt: from.published_at },
    to: { id: to.id, labelVersion: to.label_version, publishedAt: to.published_at },
    ops,
    stats,
  });
});

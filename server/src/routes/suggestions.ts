import { Router } from 'express';
import {
  db,
  type LabelRow,
  type LabelVersionRow,
  type SuggestionRow,
} from '../db.js';
import { requireAuth, requireRole } from '../auth.js';
import { HttpError } from '../http-error.js';
import { transformRange, validateSelection, rangesOverlap, applyEdits, transformRangeAcrossEdits, type Edit } from '../ranges.js';
import { SUGGESTION_SELECT, serializeSuggestion } from '../serializers.js';

export const suggestionsRouter = Router();

/** 列出某展签的全部校核建议（按时间排序）。 */
suggestionsRouter.get('/labels/:labelId/suggestions', (req, res) => {
  requireAuth(req);
  const labelId = Number(req.params.labelId);
  const rows = db
    .prepare(`${SUGGESTION_SELECT} WHERE s.label_id = ? ORDER BY s.id`)
    .all(labelId) as SuggestionRow[];
  res.json({ suggestions: rows.map(serializeSuggestion) });
});

/** 校核人提交替换建议。 */
suggestionsRouter.post('/labels/:labelId/suggestions', (req, res) => {
  const user = requireRole(req, 'checker');
  const labelId = Number(req.params.labelId);
  const label = db
    .prepare('SELECT * FROM labels WHERE id = ?')
    .get(labelId) as LabelRow | undefined;
  if (!label) throw new HttpError(404, '展签不存在', 'not_found');

  const { start, end, replacement, basis, expectedVersion } = req.body ?? {};

  if (typeof replacement !== 'string') {
    throw new HttpError(400, '替换文本必须为字符串', 'invalid_input');
  }
  if (replacement.length === 0) {
    throw new HttpError(400, '替换文本不能为空；如需删除请直接联系馆员', 'invalid_input');
  }
  if (replacement.length > 2000) {
    throw new HttpError(400, '替换文本过长（上限 2000 字）', 'invalid_input');
  }
  if (typeof basis !== 'string' || !basis.trim()) {
    throw new HttpError(400, '请填写校核依据', 'invalid_input');
  }
  if (basis.length > 2000) {
    throw new HttpError(400, '校核依据过长（上限 2000 字）', 'invalid_input');
  }
  if (!Number.isInteger(expectedVersion)) {
    throw new HttpError(400, '缺少提交所依据的正文版本号', 'invalid_input');
  }

  // 乐观并发：提交时所见版本不是最新版本则拒绝，不能基于旧正文提交
  if (expectedVersion !== label.current_version) {
    throw new HttpError(
      409,
      `提交所依据的正文版本 v${expectedVersion} 已过期，当前为 v${label.current_version}，请刷新后重新选择`,
      'version_stale',
    );
  }

  const versionRow = db
    .prepare('SELECT body FROM label_versions WHERE label_id = ? AND version = ?')
    .get(labelId, label.current_version) as LabelVersionRow;
  const body = versionRow.body;

  // 无效选区：越界 / 空选区 / 与正文不符
  const invalid = validateSelection(body, start, end);
  if (invalid) throw new HttpError(422, invalid, 'invalid_selection');

  const s = start as number;
  const e = end as number;
  const selectedText = body.slice(s, e);

  // 防止重复提交完全相同的待审建议
  const dup = db
    .prepare(
      `SELECT id FROM suggestions
        WHERE label_id = ? AND status = 'pending'
          AND sel_start = ? AND sel_end = ?
          AND replacement = ? AND basis = ?`,
    )
    .get(labelId, s, e, replacement, basis.trim());
  if (dup) {
    throw new HttpError(409, '已存在完全相同的待审建议，请勿重复提交', 'duplicate_suggestion');
  }

  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO suggestions
         (label_id, author_id, sel_start, sel_end, selected_text, replacement, basis,
          status, range_version, based_on_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    )
    .run(
      labelId, user.id, s, e, selectedText, replacement, basis.trim(),
      label.current_version, label.current_version, now, now,
    );

  const row = db
    .prepare(`${SUGGESTION_SELECT} WHERE s.id = ?`)
    .get(info.lastInsertRowid) as SuggestionRow;
  res.status(201).json({ suggestion: serializeSuggestion(row) });
});

interface AdoptResult {
  adopted: SuggestionRow;
  conflicts: SuggestionRow[];
  moved: SuggestionRow[];
  newVersion: number;
  newBody: string;
}

/** 馆员在事务中采纳一条建议。 */
const adoptTransaction = db.transaction(
  (suggestionId: number, expectedVersion: number, _userId: number): AdoptResult => {
    const sug = db
      .prepare(`${SUGGESTION_SELECT} WHERE s.id = ?`)
      .get(suggestionId) as SuggestionRow | undefined;
    if (!sug) throw new HttpError(404, '建议不存在', 'not_found');

    // 重复采纳 / 冲突建议：拒绝且不改变任何数据
    if (sug.status === 'adopted') {
      throw new HttpError(
        409,
        `建议 #${sug.id} 已在正文 v${sug.adopted_in_version} 被采纳，不能重复采纳`,
        'already_adopted',
      );
    }
    if (sug.status === 'conflict') {
      throw new HttpError(
        409,
        `建议 #${sug.id} 已转为冲突（${sug.conflict_reason ?? '选区与已采纳编辑重叠'}），无法采纳`,
        'in_conflict',
      );
    }

    const label = db
      .prepare('SELECT * FROM labels WHERE id = ?')
      .get(sug.label_id) as LabelRow;

    // 乐观并发：审批所见版本已过期 → 拒绝，不能覆盖并发改动
    if (expectedVersion !== label.current_version) {
      throw new HttpError(
        409,
        `审批所依据的正文版本 v${expectedVersion} 已过期，当前为 v${label.current_version}，请刷新核对后再操作`,
        'version_stale',
      );
    }

    const current = db
      .prepare('SELECT body FROM label_versions WHERE label_id = ? AND version = ?')
      .get(label.id, label.current_version) as LabelVersionRow;
    const body = current.body;

    // 无效选区：位移后仍应与当前正文一致，不一致则拒绝
    const invalid = validateSelection(body, sug.sel_start, sug.sel_end, sug.selected_text);
    if (invalid) throw new HttpError(422, `无法采纳：${invalid}`, 'invalid_selection');

    const start = sug.sel_start;
    const end = sug.sel_end;
    const oldLen = end - start;
    const newLen = sug.replacement.length;
    const newVersion = label.current_version + 1;
    const now = new Date().toISOString();
    const newBody =
      body.slice(0, start) + sug.replacement + body.slice(end);

    db.prepare(
      `INSERT INTO label_versions (label_id, version, body, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(label.id, newVersion, newBody, now);

    db.prepare(
      `UPDATE labels SET current_version = ?, updated_at = ? WHERE id = ?`,
    ).run(newVersion, now, label.id);

    // 被采纳建议：选区在新正文中对应替换后的区间
    db.prepare(
      `UPDATE suggestions
          SET status = 'adopted',
              adopted_in_version = ?,
              sel_start = ?,
              sel_end = ?,
              range_version = ?,
              updated_at = ?
        WHERE id = ?`,
    ).run(newVersion, start, start + newLen, newVersion, now, sug.id);

    // 其余待审建议：不重叠 → 随文字位移并更新指向版本；重叠 → 转为冲突
    const siblings = db
      .prepare(
        `${SUGGESTION_SELECT}
          WHERE s.label_id = ? AND s.status = 'pending' AND s.id != ?
          ORDER BY s.id`,
      )
      .all(label.id, sug.id) as SuggestionRow[];

    const conflictIds: number[] = [];
    const movedIds: number[] = [];

    for (const other of siblings) {
      const next = transformRange(
        { start: other.sel_start, end: other.sel_end },
        start,
        oldLen,
        newLen,
      );
      if (next === null) {
        db.prepare(
          `UPDATE suggestions
              SET status = 'conflict',
                  conflict_reason = ?,
                  updated_at = ?
            WHERE id = ?`,
        ).run(
          `选区与建议 #${sug.id} 在正文 v${newVersion} 的采纳编辑重叠，已停止采纳`,
          now,
          other.id,
        );
        conflictIds.push(other.id);
      } else {
        db.prepare(
          `UPDATE suggestions
              SET sel_start = ?, sel_end = ?, range_version = ?, updated_at = ?
            WHERE id = ?`,
        ).run(next.start, next.end, newVersion, now, other.id);
        movedIds.push(other.id);
      }
    }

    // 响应数据一律取更新后的行，避免返回过期字段（如 conflict_reason、range_version）
    const getRow = db.prepare(`${SUGGESTION_SELECT} WHERE s.id = ?`);
    const adopted = getRow.get(sug.id) as SuggestionRow;
    const conflicts = conflictIds.map((id) => getRow.get(id) as SuggestionRow);
    const moved = movedIds.map((id) => getRow.get(id) as SuggestionRow);

    return { adopted, conflicts, moved, newVersion, newBody };
  },
);

/** 馆员采纳建议。 */
suggestionsRouter.post('/suggestions/:id/adopt', (req, res) => {
  const user = requireRole(req, 'librarian');
  const suggestionId = Number(req.params.id);
  const { expectedVersion } = req.body ?? {};
  if (!Number.isInteger(expectedVersion)) {
    throw new HttpError(400, '缺少审批所依据的正文版本号 expectedVersion', 'invalid_input');
  }

  const result = adoptTransaction(suggestionId, expectedVersion, user.id);

  res.json({
    adopted: serializeSuggestion(result.adopted),
    conflicts: result.conflicts.map(serializeSuggestion),
    moved: result.moved.map(serializeSuggestion),
    label: { currentVersion: result.newVersion, body: result.newBody },
  });
});

interface BatchAdoptResult {
  adopted: SuggestionRow[];
  conflicts: SuggestionRow[];
  moved: SuggestionRow[];
  newVersion: number;
  newBody: string;
}

interface ResolvedEdit extends Edit {
  id: number;
}

/**
 * 馆员在同一事务中成组采纳多条建议。
 * 任何一项校验不通过（版本、状态、选区、跨展签、区间重叠、编号重复）
 * 都整组拒绝并回滚，不改正文、不改建议。
 */
const adoptBatchTransaction = db.transaction(
  (labelId: number, ids: number[], expectedVersion: number): BatchAdoptResult => {
    const label = db
      .prepare('SELECT * FROM labels WHERE id = ?')
      .get(labelId) as LabelRow | undefined;
    if (!label) throw new HttpError(404, '展签不存在', 'not_found');

    // 乐观并发：预览/确认所依据的版本必须是当前版本
    if (expectedVersion !== label.current_version) {
      throw new HttpError(
        409,
        `审批所依据的正文版本 v${expectedVersion} 已过期，当前为 v${label.current_version}，请刷新核对后重新预览与采纳`,
        'version_stale',
      );
    }

    const current = db
      .prepare('SELECT body FROM label_versions WHERE label_id = ? AND version = ?')
      .get(labelId, label.current_version) as LabelVersionRow;
    const body = current.body;

    // 逐条核对：存在性、是否同属本展签、状态、选区原文
    const selected: { row: SuggestionRow; invalid?: string }[] = [];
    for (const id of ids) {
      const row = db
        .prepare(`${SUGGESTION_SELECT} WHERE s.id = ?`)
        .get(id) as SuggestionRow | undefined;
      if (!row) {
        throw new HttpError(404, `建议 #${id} 不存在`, 'not_found');
      }
      if (row.label_id !== labelId) {
        throw new HttpError(
          409,
          `建议 #${id} 不属于展签「${label.title}」（属展签 #${row.label_id}），不能跨展签成组采纳`,
          'cross_label',
        );
      }
      if (row.status === 'adopted') {
        throw new HttpError(
          409,
          `建议 #${row.id} 已在正文 v${row.adopted_in_version} 被采纳，不能重复采纳`,
          'already_adopted',
        );
      }
      if (row.status === 'conflict') {
        throw new HttpError(
          409,
          `建议 #${row.id} 已转为冲突（${row.conflict_reason ?? '选区与已采纳编辑重叠'}），无法采纳`,
          'in_conflict',
        );
      }
      const invalid = validateSelection(body, row.sel_start, row.sel_end, row.selected_text);
      if (invalid) {
        throw new HttpError(422, `建议 #${row.id} 无法采纳：${invalid}`, 'invalid_selection');
      }
      selected.push({ row });
    }

    // 所选区间两两重叠（边界相接不算）→ 整组拒绝，并说明冲突项
    const edits: ResolvedEdit[] = selected.map(({ row }) => ({
      id: row.id,
      start: row.sel_start,
      end: row.sel_end,
      replacement: row.replacement,
    }));
    edits.sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 0; i < edits.length; i++) {
      for (let j = i + 1; j < edits.length; j++) {
        if (rangesOverlap(edits[i], edits[j])) {
          throw new HttpError(
            422,
            `所选建议 #${edits[i].id} 与 #${edits[j].id} 的选区在正文 v${label.current_version} 中重叠，成组采纳无法同时进行；请取消其中一条后重新预览`,
            'selections_overlap',
          );
        }
      }
    }

    const newVersion = label.current_version + 1;
    const now = new Date().toISOString();
    const { body: newBody, applied } = applyEdits(body, edits);

    db.prepare(
      `INSERT INTO label_versions (label_id, version, body, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(labelId, newVersion, newBody, now);

    db.prepare(
      `UPDATE labels SET current_version = ?, updated_at = ? WHERE id = ?`,
    ).run(newVersion, now, labelId);

    // 被采纳建议：选区指向最终正文中的替换区间（applied 与排序后的 edits 一一对应）
    const finalRangeById = new Map<number, { start: number; end: number }>();
    for (let i = 0; i < applied.length; i++) {
      finalRangeById.set(edits[i].id, {
        start: applied[i].finalStart,
        end: applied[i].finalEnd,
      });
    }

    const updateAdopted = db.prepare(
      `UPDATE suggestions
          SET status = 'adopted',
              adopted_in_version = ?,
              sel_start = ?,
              sel_end = ?,
              range_version = ?,
              updated_at = ?
        WHERE id = ?`,
    );
    for (const { row } of selected) {
      const r = finalRangeById.get(row.id)!;
      updateAdopted.run(newVersion, r.start, r.end, newVersion, now, row.id);
    }

    // 其余未选待审建议：按全部替换后的坐标位移；与任一替换区间重叠 → 转为冲突
    const siblings = db
      .prepare(
        `${SUGGESTION_SELECT}
          WHERE s.label_id = ? AND s.status = 'pending' AND s.id NOT IN (${ids.map(() => '?').join(',')})
          ORDER BY s.id`,
      )
      .all(labelId, ...ids) as SuggestionRow[];

    const conflictIds: number[] = [];
    const movedIds: number[] = [];

    const markConflict = db.prepare(
      `UPDATE suggestions
          SET status = 'conflict',
              conflict_reason = ?,
              updated_at = ?
        WHERE id = ?`,
    );
    const movePending = db.prepare(
      `UPDATE suggestions
          SET sel_start = ?, sel_end = ?, range_version = ?, updated_at = ?
        WHERE id = ?`,
    );

    for (const other of siblings) {
      const otherRange = { start: other.sel_start, end: other.sel_end };
      const next = transformRangeAcrossEdits(otherRange, edits);
      if (next === null) {
        // edits 已按原正文位置排序，取第一条重叠的已采纳建议用于留痕
        const hit = edits.find((e) =>
          rangesOverlap(otherRange, { start: e.start, end: e.end }),
        );
        markConflict.run(
          `选区与建议 #${hit?.id ?? edits[0].id} 在正文 v${newVersion} 的成组采纳编辑重叠，已转为冲突`,
          now,
          other.id,
        );
        conflictIds.push(other.id);
      } else {
        movePending.run(next.start, next.end, newVersion, now, other.id);
        movedIds.push(other.id);
      }
    }

    // 响应数据一律取更新后的行
    const getRow = db.prepare(`${SUGGESTION_SELECT} WHERE s.id = ?`);
    const adopted = ids
      .slice()
      .sort((a, b) => a - b)
      .map((id) => getRow.get(id) as SuggestionRow);
    const conflicts = conflictIds.map((id) => getRow.get(id) as SuggestionRow);
    const moved = movedIds.map((id) => getRow.get(id) as SuggestionRow);

    return { adopted, conflicts, moved, newVersion, newBody };
  },
);

/** 馆员成组采纳多条建议（一次替换生成一个新正文版本）。 */
suggestionsRouter.post('/labels/:labelId/suggestions/adopt-batch', (req, res) => {
  const user = requireRole(req, 'librarian');
  const labelId = Number(req.params.labelId);
  const { suggestionIds, expectedVersion } = req.body ?? {};

  if (!Array.isArray(suggestionIds)) {
    throw new HttpError(400, '缺少待采纳建议编号数组 suggestionIds', 'invalid_input');
  }
  if (suggestionIds.length === 0) {
    throw new HttpError(400, '请至少勾选一条待审建议再成组采纳', 'invalid_input');
  }
  if (suggestionIds.length > 200) {
    throw new HttpError(400, '单次成组采纳不能超过 200 条建议', 'invalid_input');
  }
  const ids: number[] = [];
  for (const raw of suggestionIds) {
    if (!Number.isInteger(raw)) {
      throw new HttpError(400, '建议编号必须为整数', 'invalid_input');
    }
    ids.push(raw as number);
  }
  // 编号重复 → 整组拒绝
  const dedup = new Set(ids);
  if (dedup.size !== ids.length) {
    const dup = ids.find((id) => ids.indexOf(id) !== ids.lastIndexOf(id));
    throw new HttpError(
      400,
      `建议编号 #${dup} 在请求中重复出现，请去重后重新提交`,
      'duplicate_ids',
    );
  }
  if (!Number.isInteger(expectedVersion)) {
    throw new HttpError(400, '缺少审批所依据的正文版本号 expectedVersion', 'invalid_input');
  }

  const result = adoptBatchTransaction(labelId, ids, expectedVersion);

  res.json({
    adopted: result.adopted.map(serializeSuggestion),
    conflicts: result.conflicts.map(serializeSuggestion),
    moved: result.moved.map(serializeSuggestion),
    label: { currentVersion: result.newVersion, body: result.newBody },
  });
});

import { Router } from 'express';
import {
  db,
  type LabelRow,
  type LabelVersionRow,
  type SuggestionRow,
} from '../db.js';
import { requireAuth, requireRole } from '../auth.js';
import { HttpError } from '../http-error.js';
import { transformRange, validateSelection } from '../ranges.js';
import {
  applyGroupEdits,
  findOverlapPairs,
  transformRangeAcrossEdits,
  type AppliedGroupEdit,
  type GroupEdit,
} from '../ranges.js';
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

// ---------------------------------------------------------------------------
// 成组采纳（一次勾选多条待审建议）
// ---------------------------------------------------------------------------

interface ResolvedGroup {
  label: LabelRow;
  body: string;
  selected: SuggestionRow[]; // 按原正文位置（start、id）排序
}

/** 解析成组请求并完成全部只读核对：权限、版本、状态、跨展签、选区原文。 */
function resolveGroup(
  labelId: number,
  ids: unknown,
  expectedVersion: unknown,
): ResolvedGroup {
  const label = db
    .prepare('SELECT * FROM labels WHERE id = ?')
    .get(labelId) as LabelRow | undefined;
  if (!label) throw new HttpError(404, '展签不存在', 'not_found');

  if (!Number.isInteger(expectedVersion)) {
    throw new HttpError(400, '缺少审批所依据的正文版本号 expectedVersion', 'invalid_input');
  }
  // 预览后版本已变化（或并发改动）：整组拒绝，不修改任何数据
  if (expectedVersion !== label.current_version) {
    throw new HttpError(
      409,
      `审批所依据的正文版本 v${expectedVersion} 已过期，当前为 v${label.current_version}，请刷新核对后再操作`,
      'version_stale',
    );
  }

  if (!Array.isArray(ids) || ids.length === 0) {
    throw new HttpError(400, '请至少勾选一条建议（suggestionIds 为非空数组）', 'invalid_input');
  }
  if (ids.length > 200) {
    throw new HttpError(400, '单次成组采纳不能超过 200 条建议', 'invalid_input');
  }

  const numIds: number[] = [];
  for (const v of ids) {
    if (!Number.isInteger(v)) {
      throw new HttpError(400, '建议编号必须为整数', 'invalid_input');
    }
    numIds.push(v as number);
  }

  // 编号重复：整组拒绝
  const seen = new Set<number>();
  for (const id of numIds) {
    if (seen.has(id)) {
      throw new HttpError(409, `建议编号 #${id} 重复出现，每条建议只能选择一次`, 'duplicate_ids');
    }
    seen.add(id);
  }

  const versionRow = db
    .prepare('SELECT body FROM label_versions WHERE label_id = ? AND version = ?')
    .get(labelId, label.current_version) as LabelVersionRow;
  const body = versionRow.body;

  const getSug = db.prepare(`${SUGGESTION_SELECT} WHERE s.id = ?`);
  const selected: SuggestionRow[] = [];
  for (const id of numIds) {
    const sug = getSug.get(id) as SuggestionRow | undefined;
    if (!sug) throw new HttpError(404, `建议 #${id} 不存在`, 'not_found');
    // 跨展签：整组拒绝
    if (sug.label_id !== labelId) {
      throw new HttpError(
        409,
        `建议 #${id} 不属于展签 #${labelId}（属于展签 #${sug.label_id}），不能跨展签成组采纳`,
        'cross_label',
      );
    }
    // 建议已处理（已采纳 / 冲突）：整组拒绝，不能只采纳其中一部分
    if (sug.status === 'adopted') {
      throw new HttpError(
        409,
        `建议 #${sug.id} 已在正文 v${sug.adopted_in_version} 被采纳，不能重复采纳；请刷新后重新勾选`,
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
    // 选区失效（越界/反向/原文与当前正文不一致）：整组拒绝
    const invalid = validateSelection(body, sug.sel_start, sug.sel_end, sug.selected_text);
    if (invalid) {
      throw new HttpError(
        422,
        `建议 #${sug.id} 的选区已失效：${invalid}；请刷新核对后重新勾选`,
        'invalid_selection',
      );
    }
    selected.push(sug);
  }

  // 所选区间彼此重叠：整组拒绝并说明冲突项
  const pairs = findOverlapPairs(
    selected.map((s) => ({ id: s.id, start: s.sel_start, end: s.sel_end })),
  );
  if (pairs.length > 0) {
    const desc = pairs.map(([a, b]) => `#${a} 与 #${b}`).join('、');
    throw new HttpError(
      409,
      `所选建议的选区在当前正文中彼此重叠（${desc}），整组未采纳；请取消冲突项后重新提交`,
      'selections_overlap',
    );
  }

  selected.sort((a, b) => a.sel_start - b.sel_start || a.id - b.id);
  return { label, body, selected };
}

interface GroupPreviewItem {
  suggestion: SuggestionRow;
  finalStart: number;
  finalEnd: number;
}

/** 计算成组采纳的确定性结果（不写库）：预览与事务共用，保证所见即所得。 */
function computeGroupResult(resolved: ResolvedGroup) {
  const { label, body, selected } = resolved;
  const edits: GroupEdit[] = selected.map((s) => ({
    id: s.id,
    start: s.sel_start,
    end: s.sel_end,
    replacement: s.replacement,
  }));
  const { body: newBody, applied } = applyGroupEdits(body, edits);
  const newVersion = label.current_version + 1;

  const byId = new Map<number, AppliedGroupEdit>(applied.map((e) => [e.id, e]));
  const previewItems: GroupPreviewItem[] = selected.map((s) => ({
    suggestion: s,
    finalStart: byId.get(s.id)!.finalStart,
    finalEnd: byId.get(s.id)!.finalEnd,
  }));

  // 未选待审建议：按全部替换后的坐标位移；与任一替换区间重叠则转为冲突
  const siblings = db
    .prepare(
      `${SUGGESTION_SELECT}
        WHERE s.label_id = ? AND s.status = 'pending'
        ORDER BY s.id`,
    )
    .all(label.id) as SuggestionRow[];
  const chosen = new Set(selected.map((s) => s.id));

  const moved: Array<{ suggestion: SuggestionRow; start: number; end: number }> = [];
  const conflicts: Array<{ suggestion: SuggestionRow }> = [];
  for (const other of siblings) {
    if (chosen.has(other.id)) continue;
    const next = transformRangeAcrossEdits(
      { start: other.sel_start, end: other.sel_end },
      edits,
    );
    if (next === null) conflicts.push({ suggestion: other });
    else moved.push({ suggestion: other, start: next.start, end: next.end });
  }

  return { newBody, newVersion, previewItems, moved, conflicts };
}

/** 馆员确认前的成组替换预览（只读，按原正文位置排列）。 */
suggestionsRouter.post('/labels/:labelId/suggestions/adopt-preview', (req, res) => {
  requireRole(req, 'librarian');
  const labelId = Number(req.params.labelId);
  const { suggestionIds, expectedVersion } = req.body ?? {};
  const resolved = resolveGroup(labelId, suggestionIds, expectedVersion);
  const result = computeGroupResult(resolved);

  res.json({
    labelId,
    version: resolved.label.current_version,
    newVersion: result.newVersion,
    body: resolved.body,
    previewBody: result.newBody,
    items: result.previewItems.map((item) => ({
      suggestion: serializeSuggestion(item.suggestion),
      start: item.suggestion.sel_start,
      end: item.suggestion.sel_end,
      finalStart: item.finalStart,
      finalEnd: item.finalEnd,
    })),
    moved: result.moved.map((m) => ({
      suggestion: serializeSuggestion(m.suggestion),
      start: m.start,
      end: m.end,
    })),
    conflicts: result.conflicts.map((c) => ({
      suggestion: serializeSuggestion(c.suggestion),
    })),
  });
});

interface GroupAdoptResult {
  adopted: SuggestionRow[];
  conflicts: SuggestionRow[];
  moved: SuggestionRow[];
  newVersion: number;
  newBody: string;
}

/** 馆员在单个事务中成组采纳：成功一次形成新版本，失败整组回滚。 */
const adoptGroupTransaction = db.transaction(
  (resolved: ResolvedGroup): GroupAdoptResult => {
    // 事务内重新核对（防止预览确认前被并发改动）：版本/状态/选区任一失效即整组回滚
    const label = db
      .prepare('SELECT * FROM labels WHERE id = ?')
      .get(resolved.label.id) as LabelRow;
    if (label.current_version !== resolved.label.current_version) {
      throw new HttpError(
        409,
        `预览后正文已更新到 v${label.current_version}，请刷新后重新勾选并预览`,
        'version_stale',
      );
    }

    const result = computeGroupResult({ ...resolved, label });

    // 事务内对所选建议再做一次原文核对：即便版本号未变，行也可能在预览确认前
    // 被其他操作改写（坐标/原文变化）→ 整组回滚
    const currentBody = db
      .prepare('SELECT body FROM label_versions WHERE label_id = ? AND version = ?')
      .get(label.id, label.current_version) as LabelVersionRow;
    const recheck = db.prepare(`${SUGGESTION_SELECT} WHERE s.id = ?`);
    for (const item of result.previewItems) {
      const row = recheck.get(item.suggestion.id) as SuggestionRow | undefined;
      if (!row || row.status !== 'pending') {
        throw new HttpError(
          409,
          `建议 #${item.suggestion.id} 在预览后已被处理，请刷新后重新操作`,
          'suggestion_changed',
        );
      }
      const invalid = validateSelection(
        currentBody.body,
        row.sel_start,
        row.sel_end,
        row.selected_text,
      );
      if (invalid) {
        throw new HttpError(
          422,
          `建议 #${row.id} 的选区已失效：${invalid}；请刷新核对后重新勾选`,
          'invalid_selection',
        );
      }
    }

    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO label_versions (label_id, version, body, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(label.id, result.newVersion, result.newBody, now);
    db.prepare(
      `UPDATE labels SET current_version = ?, updated_at = ? WHERE id = ?`,
    ).run(result.newVersion, now, label.id);

    // 各条采纳记录指向最终正文中的替换区间
    const updateAdopted = db.prepare(
      `UPDATE suggestions
          SET status = 'adopted',
              adopted_in_version = ?,
              sel_start = ?,
              sel_end = ?,
              range_version = ?,
              updated_at = ?
        WHERE id = ? AND status = 'pending'`,
    );
    for (const item of result.previewItems) {
      const info = updateAdopted.run(
        result.newVersion,
        item.finalStart,
        item.finalEnd,
        result.newVersion,
        now,
        item.suggestion.id,
      );
      if (info.changes !== 1) {
        // 预览后建议已被并发处理：整组拒绝
        throw new HttpError(
          409,
          `建议 #${item.suggestion.id} 在预览后已被处理，请刷新后重新操作`,
          'suggestion_changed',
        );
      }
    }

    // 未选待审建议：位移或转冲突，同样要求行仍为 pending
    const updateMoved = db.prepare(
      `UPDATE suggestions
          SET sel_start = ?, sel_end = ?, range_version = ?, updated_at = ?
        WHERE id = ? AND status = 'pending'`,
    );
    const markConflict = db.prepare(
      `UPDATE suggestions
          SET status = 'conflict', conflict_reason = ?, updated_at = ?
        WHERE id = ? AND status = 'pending'`,
    );

    for (const m of result.moved) {
      const info = updateMoved.run(
        m.start,
        m.end,
        result.newVersion,
        now,
        m.suggestion.id,
      );
      if (info.changes !== 1) {
        throw new HttpError(
          409,
          `建议 #${m.suggestion.id} 在预览后已被处理，请刷新后重新操作`,
          'suggestion_changed',
        );
      }
    }
    for (const c of result.conflicts) {
      const info = markConflict.run(
        `选区与本次成组采纳（正文 v${result.newVersion}）的替换区间重叠，整组采纳中该条未被选择，已转为冲突`,
        now,
        c.suggestion.id,
      );
      if (info.changes !== 1) {
        throw new HttpError(
          409,
          `建议 #${c.suggestion.id} 在预览后已被处理，请刷新后重新操作`,
          'suggestion_changed',
        );
      }
    }

    // 响应数据一律取更新后的行，避免返回过期字段
    const getRow = db.prepare(`${SUGGESTION_SELECT} WHERE s.id = ?`);
    return {
      adopted: result.previewItems.map((i) => getRow.get(i.suggestion.id) as SuggestionRow),
      conflicts: result.conflicts.map((c) => getRow.get(c.suggestion.id) as SuggestionRow),
      moved: result.moved.map((m) => getRow.get(m.suggestion.id) as SuggestionRow),
      newVersion: result.newVersion,
      newBody: result.newBody,
    };
  },
);

/** 馆员成组采纳所选建议。 */
suggestionsRouter.post('/labels/:labelId/suggestions/adopt', (req, res) => {
  requireRole(req, 'librarian');
  const labelId = Number(req.params.labelId);
  const { suggestionIds, expectedVersion } = req.body ?? {};

  // 预览侧的完整核对（权限/版本/编号/状态/跨展签/选区/重叠），失败直接拒绝
  const resolved = resolveGroup(labelId, suggestionIds, expectedVersion);
  const result = adoptGroupTransaction(resolved);

  res.json({
    adopted: result.adopted.map(serializeSuggestion),
    conflicts: result.conflicts.map(serializeSuggestion),
    moved: result.moved.map(serializeSuggestion),
    label: { currentVersion: result.newVersion, body: result.newBody },
  });
});

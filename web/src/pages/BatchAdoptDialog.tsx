import { useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import type { BatchAdoptResponse, Label, Suggestion } from '../types';

interface Props {
  label: Label;
  /** 勾选的待审建议（任意顺序，弹窗内按原正文位置重排）。 */
  selected: Suggestion[];
  /** 打开预览时页面所见版本；与 label.currentVersion 不一致即提示过期。 */
  pinnedVersion: number;
  busy: boolean;
  onClose: () => void;
  onApplied: (res: BatchAdoptResponse) => void;
}

interface OrderedEdit {
  s: Suggestion;
  conflictingWith: number | null;
}

/** 按原正文位置排列勾选项，并标出彼此重叠（边界相接不算）的冲突项。 */
function orderAndFindOverlaps(selected: Suggestion[]): {
  ordered: OrderedEdit[];
  overlapPairs: Array<[number, number]>;
} {
  const ordered = [...selected]
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .map((s) => ({ s, conflictingWith: null as number | null }));
  const overlapPairs: Array<[number, number]> = [];
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      const a = ordered[i].s;
      const b = ordered[j].s;
      if (a.start < b.end && b.start < a.end) {
        overlapPairs.push([a.id, b.id]);
        if (ordered[i].conflictingWith === null) ordered[i].conflictingWith = b.id;
        if (ordered[j].conflictingWith === null) ordered[j].conflictingWith = a.id;
      }
    }
  }
  return { ordered, overlapPairs };
}

export default function BatchAdoptDialog({
  label,
  selected,
  pinnedVersion,
  busy,
  onClose,
  onApplied,
}: Props) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const { ordered, overlapPairs } = useMemo(
    () => orderAndFindOverlaps(selected),
    [selected],
  );

  // 预览后正文已被并发改动：所见版本不再是当前版本
  const stale = pinnedVersion !== label.currentVersion;
  const hasOverlap = overlapPairs.length > 0;

  // 选区失效（正文已变，勾选时保存的原文对不上当前正文）
  const invalid = ordered.find(
    ({ s }) =>
      s.start < 0 || s.end > label.body.length || label.body.slice(s.start, s.end) !== s.selectedText,
  );

  const canSubmit = !hasOverlap && !stale && !invalid && !submitting && !busy;

  async function submit() {
    setError(null);
    setSubmitting(true);
    try {
      const res = await api<BatchAdoptResponse>(
        'POST',
        `/api/labels/${label.id}/suggestions/adopt-batch`,
        {
          suggestionIds: selected.map((s) => s.id),
          expectedVersion: label.currentVersion,
        },
      );
      onApplied(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '成组采纳失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal card batch-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="section-title">
          成组采纳预览
          <span className="badge badge-version">基于 v{pinnedVersion}</span>
          <span className="muted small">共 {selected.length} 条 · 替换合并为一个新版本</span>
        </div>

        {stale && (
          <div className="notice notice-error">
            预览所依据的正文 v{pinnedVersion} 已变化，当前为 v{label.currentVersion}
            （他人可能已提交或采纳）。请关闭本窗口、核对最新正文与选区后重新勾选预览。
          </div>
        )}
        {!stale && hasOverlap && (
          <div className="notice notice-error">
            所选区间彼此重叠，整组无法同时采纳，冲突项：
            {overlapPairs.map(([a, b]) => ` #${a} ↔ #${b}`).join('；')}
            。请取消其中一条后重新预览。
          </div>
        )}
        {!stale && !hasOverlap && invalid && (
          <div className="notice notice-error">
            建议 #{invalid.s.id} 的选区已与当前正文不一致（选区失效），整组不能提交，请关闭后刷新重选。
          </div>
        )}

        {/* 按原正文位置排列的替换预览 */}
        <div className="batch-preview body-surface">
          {ordered.map(({ s, conflictingWith }, i) => {
            const before = i === 0 ? label.body.slice(0, s.start) : label.body.slice(ordered[i - 1].s.end, s.start);
            return (
              <span key={s.id}>
                {before}
                <span
                  className={`batch-edit${conflictingWith !== null ? ' batch-edit-conflict' : ''}`}
                  title={
                    conflictingWith !== null
                      ? `与 #${conflictingWith} 选区重叠`
                      : `建议 #${s.id}`
                  }
                >
                  <del>{label.body.slice(s.start, s.end)}</del>
                  <ins>{s.replacement}</ins>
                </span>
              </span>
            );
          })}
          {ordered.length > 0 && label.body.slice(ordered[ordered.length - 1].s.end)}
        </div>

        {/* 逐条清单（同样按原正文位置） */}
        <ol className="batch-list">
          {ordered.map(({ s, conflictingWith }) => (
            <li key={s.id} className={conflictingWith !== null ? 'batch-item-conflict' : ''}>
              <span className="badge badge-pending">#{s.id}</span>
              <span className="batch-pair">
                <del className="batch-old">{s.selectedText}</del>
                <span className="batch-arrow">→</span>
                <ins className="batch-new">{s.replacement}</ins>
              </span>
              <span className="muted small">
                [{s.start}, {s.end})
              </span>
            </li>
          ))}
        </ol>

        {error && <div className="notice notice-error">{error}</div>}

        <div className="row-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            {submitting ? '采纳中…' : `确认采纳所选 ${selected.length} 条`}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <span className="muted small">
            提交后服务端将重新核对权限、版本、建议状态与选区原文；任一不通过则整组拒绝，不修改任何内容。
          </span>
        </div>
      </div>
    </div>
  );
}

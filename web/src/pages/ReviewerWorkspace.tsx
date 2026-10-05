import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import {
  useLabelData,
  useVersionPolling,
  formatTime,
} from '../hooks';
import type { AdoptResponse, BatchAdoptResponse, Suggestion } from '../types';
import { ErrorBox, LabelHeader, SuggestionList } from './CheckerWorkspace';
import PublishDialog from './PublishDialog';
import BatchAdoptDialog from './BatchAdoptDialog';

interface Segment {
  start: number;
  end: number;
  status: 'plain' | 'pending' | 'adopted' | 'selected';
  ids: number[];
}

/** 把当前正文切成 [plain | 待审选区 | 已采纳选区] 片段；已采纳区间不与待审重叠。 */
function buildSegments(body: string, suggestions: Suggestion[], selectedIds: Set<number>): Segment[] {
  type Mark = { start: number; end: number; status: Segment['status']; id: number };
  const marks: Mark[] = [];
  for (const s of suggestions) {
    if (s.status === 'adopted') {
      marks.push({ start: s.start, end: s.end, status: 'adopted', id: s.id });
    } else if (s.status === 'pending' && s.rangeVersion !== undefined) {
      marks.push({
        start: s.start,
        end: s.end,
        status: selectedIds.has(s.id) ? 'selected' : 'pending',
        id: s.id,
      });
    }
  }
  // 合并相交区间（同为待审的重叠建议本应用冲突逻辑消解，这里仍做健壮性合并）
  marks.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Segment[] = [];
  for (const m of marks) {
    const last = merged[merged.length - 1];
    if (last && m.start < last.end && m.status === last.status) {
      if (m.end > last.end) last.end = m.end;
      last.ids.push(m.id);
    } else if (last && m.start < last.end) {
      // 不同状态相交时不合并（理论上不会出现）
      merged.push({ start: m.start, end: m.end, status: m.status, ids: [m.id] });
    } else {
      merged.push({ start: m.start, end: m.end, status: m.status, ids: [m.id] });
    }
  }

  const segments: Segment[] = [];
  let cursor = 0;
  for (const m of merged) {
    if (m.start > cursor) {
      segments.push({ start: cursor, end: m.start, status: 'plain', ids: [] });
    }
    segments.push(m);
    cursor = m.end;
  }
  if (cursor < body.length) {
    segments.push({ start: cursor, end: body.length, status: 'plain', ids: [] });
  }
  return segments;
}

export default function ReviewerWorkspace() {
  const { labelId, label, suggestions, error, loading, reload, setLabel, setSuggestions } =
    useLabelData();
  useVersionPolling(label?.currentVersion, reload);

  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showPublish, setShowPublish] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [showBatch, setShowBatch] = useState(false);
  const [pinnedVersion, setPinnedVersion] = useState<number | null>(null);

  const pendingSuggestions = useMemo(
    () => suggestions.filter((s) => s.status === 'pending'),
    [suggestions],
  );

  // 建议状态/选区被并发推进后，清掉已不再待审的勾选
  useEffect(() => {
    setSelectedIds((prev) => {
      const live = new Set(pendingSuggestions.map((s) => s.id));
      let changed = false;
      const next = new Set<number>();
      for (const id of prev) {
        if (live.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [pendingSuggestions]);

  const segments = useMemo(
    () => (label ? buildSegments(label.body, suggestions, selectedIds) : []),
    [label, suggestions, selectedIds],
  );

  const pendingCount = pendingSuggestions.length;
  const conflictCount = suggestions.filter((s) => s.status === 'conflict').length;

  function toggleSelect(id: number) {
    setActionError(null);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelectedIds((prev) =>
      prev.size === pendingSuggestions.length
        ? new Set()
        : new Set(pendingSuggestions.map((s) => s.id)),
    );
  }

  function openPreview() {
    setActionError(null);
    if (!label) return;
    setPinnedVersion(label.currentVersion);
    setShowBatch(true);
  }

  function applyBatchResult(res: BatchAdoptResponse) {
    setLabel((prev) =>
      prev
        ? { ...prev, body: res.label.body, currentVersion: res.label.currentVersion }
        : prev,
    );
    const byId = new Map([
      ...res.adopted.map((s): [number, Suggestion] => [s.id, s]),
      ...res.conflicts.map((s): [number, Suggestion] => [s.id, s]),
      ...res.moved.map((s): [number, Suggestion] => [s.id, s]),
    ]);
    setSuggestions((prev) => prev.map((item) => byId.get(item.id) ?? item));
    setSelectedIds(new Set());
    setShowBatch(false);
    setPinnedVersion(null);
    const parts = [
      `已成组采纳 #${res.adopted.map((s) => s.id).join('、#')}，正文更新到 v${res.label.currentVersion}`,
    ];
    if (res.conflicts.length > 0) {
      parts.push(
        `未选建议 #${res.conflicts.map((c) => c.id).join('、#')} 因与替换区间重叠转为冲突`,
      );
    }
    if (res.moved.length > 0) {
      parts.push(`#${res.moved.map((m) => m.id).join('、#')} 的选区已随全部替换位移`);
    }
    setNotice(parts.join('；'));
  }

  async function adopt(s: Suggestion) {
    if (!label) return;
    setBusyId(s.id);
    setActionError(null);
    setNotice(null);
    try {
      const res = await api<AdoptResponse>(
        'POST',
        `/api/suggestions/${s.id}/adopt`,
        { expectedVersion: label.currentVersion },
      );
      // 用返回结果就地更新，避免并发窗口期内整页覆盖
      setLabel((prev) =>
        prev
          ? { ...prev, body: res.label.body, currentVersion: res.label.currentVersion }
          : prev,
      );
      setSuggestions((prev) =>
        prev.map((item) => {
          if (item.id === res.adopted.id) return res.adopted;
          const conflicted = res.conflicts.find((c) => c.id === item.id);
          if (conflicted) return conflicted;
          const moved = res.moved.find((m) => m.id === item.id);
          if (moved) return moved;
          return item;
        }),
      );
      setSelectedIds((prev) => {
        if (!prev.has(s.id)) return prev;
        const next = new Set(prev);
        next.delete(s.id);
        return next;
      });
      const parts = [`已采纳 #${res.adopted.id}，正文更新到 v${res.label.currentVersion}`];
      if (res.conflicts.length > 0) {
        parts.push(
          `#${res.conflicts.map((c) => c.id).join('、#')} 因选区重叠转为冲突并停止采纳`,
        );
      }
      if (res.moved.length > 0) {
        parts.push(`#${res.moved.map((m) => m.id).join('、#')} 的选区已随文字位移`);
      }
      setNotice(parts.join('；'));
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : '采纳失败');
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <div className="container muted center">加载中…</div>;
  if (error || !label) {
    return (
      <div className="container">
        <ErrorBox text={error ?? '展签不存在'} onRetry={reload} />
      </div>
    );
  }

  const selectedSuggestions = suggestions.filter((s) => selectedIds.has(s.id));
  const allSelected = pendingSuggestions.length > 0 && selectedIds.size === pendingSuggestions.length;

  return (
    <div className="container two-col">
      <section>
        <LabelHeader
          label={label}
          onReload={() => {
            setActionError(null);
            setNotice(null);
            reload();
          }}
        />

        <div className="card">
          <div className="section-title">
            待发布正文
            <span className="badge badge-version">v{label.currentVersion}</span>
            <span className="legend">
              <i className="swatch swatch-pending" />待审选区
              <i className="swatch swatch-selected" />已勾选
              <i className="swatch swatch-adopted" />已采纳
            </span>
          </div>
          <div className="body-surface review">
            {segments.map((seg, i) =>
              seg.status === 'plain' ? (
                <span key={i}>{label.body.slice(seg.start, seg.end)}</span>
              ) : (
                <mark
                  key={i}
                  className={`hl hl-${seg.status}`}
                  title={`建议 #${seg.ids.join('、#')}`}
                >
                  {label.body.slice(seg.start, seg.end)}
                </mark>
              ),
            )}
          </div>
        </div>

        {actionError && <div className="notice notice-error">{actionError}</div>}
        {notice && <div className="notice notice-ok">{notice}</div>}

        <div className="publish-bar card batch-bar">
          <div>
            <label className="batch-check">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleSelectAll}
                disabled={pendingSuggestions.length === 0 || busyId !== null}
              />
              全选待审（{selectedIds.size}/{pendingCount} 已勾选）
            </label>
            <span className="muted small batch-hint">
              可在右侧建议卡勾选多条，按原正文位置预览替换后一次采纳
            </span>
          </div>
          <div className="row-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={selectedIds.size === 0 || busyId !== null}
              onClick={openPreview}
            >
              成组采纳预览{selectedIds.size > 0 ? `（${selectedIds.size} 条）` : ''}
            </button>
            {selectedIds.size > 0 && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setSelectedIds(new Set())}
                disabled={busyId !== null}
              >
                清除勾选
              </button>
            )}
          </div>
        </div>

        <div className="publish-bar card">
          <div>
            <strong>{pendingCount}</strong> 条待审 ·{' '}
            <strong className={conflictCount > 0 ? 'danger-text' : ''}>
              {conflictCount}
            </strong>{' '}
            条冲突 ·{' '}
            <strong>{suggestions.filter((s) => s.status === 'adopted').length}</strong>{' '}
            条已采纳
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setActionError(null);
              setShowPublish(true);
            }}
          >
            发布当前正文
          </button>
        </div>

        <p className="muted small publish-hint">
          正文最近更新：{formatTime(label.updatedAt)}。发布会固化 v{label.currentVersion}{' '}
          正文与全部采纳记录（含成组采纳）；之后继续编辑不会改写旧发布。
        </p>
      </section>

      <aside>
        <div className="aside-title">建议列表</div>
        <SuggestionList
          suggestions={suggestions}
          currentVersion={label.currentVersion}
          actions={(s) =>
            s.status === 'pending' ? (
              <div className="row-actions suggestion-actions">
                <label className="batch-check">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(s.id)}
                    onChange={() => toggleSelect(s.id)}
                    disabled={busyId !== null}
                  />
                  加入成组采纳
                </label>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={busyId !== null}
                  onClick={() => void adopt(s)}
                >
                  {busyId === s.id ? '处理中…' : `采纳 #${s.id}`}
                </button>
                <span className="muted small">
                  将基于 v{label.currentVersion} 审批（待审选区指向 v{s.rangeVersion}）
                </span>
              </div>
            ) : null
          }
        />
      </aside>

      {showBatch && pinnedVersion !== null && (
        <BatchAdoptDialog
          label={label}
          selected={selectedSuggestions}
          pinnedVersion={pinnedVersion}
          busy={busyId !== null}
          onClose={() => {
            setShowBatch(false);
            setPinnedVersion(null);
          }}
          onApplied={applyBatchResult}
        />
      )}

      {showPublish && (
        <PublishDialog
          labelId={labelId}
          expectedVersion={label.currentVersion}
          onClose={() => setShowPublish(false)}
          onPublished={() => {
            setShowPublish(false);
            setNotice(`已发布正文 v${label.currentVersion}（固化正文与采纳记录）`);
            reload();
          }}
        />
      )}
    </div>
  );
}

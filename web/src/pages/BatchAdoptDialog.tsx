import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import type {
  BatchAdoptResponse,
  BatchPreviewResponse,
} from '../types';

interface Props {
  labelId: number;
  expectedVersion: number;
  selectedIds: number[];
  onClose: () => void;
  onAdopted: (res: BatchAdoptResponse) => void;
}

type Segment =
  | { kind: 'plain'; start: number; end: number }
  | { kind: 'replace'; item: BatchPreviewResponse['items'][number] };

/** 按原正文位置把替换预览切成 原文 / 替换文本 片段。 */
function buildPreviewSegments(body: string, items: BatchPreviewResponse['items']): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;
  for (const item of items) {
    if (item.start > cursor) {
      segments.push({ kind: 'plain', start: cursor, end: item.start });
    }
    segments.push({ kind: 'replace', item });
    cursor = item.end;
  }
  if (cursor < body.length) {
    segments.push({ kind: 'plain', start: cursor, end: body.length });
  }
  return segments;
}

export default function BatchAdoptDialog({
  labelId,
  expectedVersion,
  selectedIds,
  onClose,
  onAdopted,
}: Props) {
  const [preview, setPreview] = useState<BatchPreviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setLoadError(null);
    setSubmitError(null);
    api<BatchPreviewResponse>(
      'POST',
      `/api/labels/${labelId}/suggestions/adopt-preview`,
      { suggestionIds: selectedIds, expectedVersion },
    )
      .then((data) => setPreview(data))
      .catch((err: unknown) => {
        setLoadError(err instanceof ApiError ? err.message : '生成预览失败');
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const segments = useMemo(
    () => (preview ? buildPreviewSegments(preview.body, preview.items) : []),
    [preview],
  );

  async function confirm() {
    if (!preview) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await api<BatchAdoptResponse>(
        'POST',
        `/api/labels/${labelId}/suggestions/adopt`,
        { suggestionIds: selectedIds, expectedVersion: preview.version },
      );
      onAdopted(res);
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : '成组采纳失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal card batch-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="section-title">
          成组采纳预览
          <span className="badge badge-version">基于 v{expectedVersion}</span>
          <span className="muted small">
            {selectedIds.length} 条建议 → 新正文 v{expectedVersion + 1}
          </span>
        </div>

        {loading && <div className="muted center-narrow">正在生成替换预览…</div>}

        {loadError && (
          <>
            <div className="notice notice-error">{loadError}</div>
            <div className="row-actions">
              <button type="button" className="btn btn-ghost" onClick={load}>
                重试
              </button>
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                关闭
              </button>
            </div>
          </>
        )}

        {preview && !loading && (
          <>
            <p className="muted small">
              下列预览按原正文位置排列，绿色高亮为各建议的替换文本；确认后全部替换一次形成
              v{preview.newVersion}，任一核对不通过则整组拒绝、不改正文。
            </p>

            <div className="body-surface review batch-preview">
              {segments.map((seg, i) =>
                seg.kind === 'plain' ? (
                  <span key={i}>{preview.body.slice(seg.start, seg.end)}</span>
                ) : (
                  <mark
                    key={i}
                    className="hl hl-adopted"
                    title={`建议 #${seg.item.suggestion.id} 采纳后区间 [${seg.item.finalStart}, ${seg.item.finalEnd})`}
                  >
                    {seg.item.suggestion.replacement}
                  </mark>
                ),
              )}
            </div>

            <div className="batch-itemlist">
              {preview.items.map(({ suggestion, start, end, finalStart, finalEnd }) => (
                <div key={suggestion.id} className="batch-item">
                  <span className="badge badge-pending">#{suggestion.id}</span>
                  <span className="pair-text">
                    <span className="tag-old tag-inline">原</span>
                    {suggestion.selectedText}
                    <span className="muted small">
                      {' '}[{start}, {end})
                    </span>
                  </span>
                  <span className="pair-text">
                    <span className="tag-new tag-inline">改</span>
                    {suggestion.replacement}
                    <span className="muted small">
                      {' '}→ [{finalStart}, {finalEnd})
                    </span>
                  </span>
                </div>
              ))}
            </div>

            {preview.conflicts.length > 0 && (
              <div className="notice notice-error">
                以下 {preview.conflicts.length} 条未选待审建议与替换区间重叠，采纳后将转为冲突：
                #
                {preview.conflicts
                  .map((c) => c.suggestion.id)
                  .sort((a, b) => a - b)
                  .join('、#')}
              </div>
            )}
            {preview.moved.length > 0 && (
              <div className="notice notice-ok">
                其余 {preview.moved.length} 条未选待审建议选区将随文字位移：
                #
                {preview.moved
                  .map((m) => m.suggestion.id)
                  .sort((a, b) => a - b)
                  .join('、#')}
              </div>
            )}

            {submitError && <div className="notice notice-error">{submitError}</div>}

            <div className="row-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={submitting}
                onClick={() => void confirm()}
              >
                {submitting
                  ? '采纳中…'
                  : `确认采纳 ${selectedIds.length} 条，生成 v${preview.newVersion}`}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={submitting}
                onClick={onClose}
              >
                取消
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

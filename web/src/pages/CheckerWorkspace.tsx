import { useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { useLabelData, useVersionPolling, formatTime, STATUS_CLASS, STATUS_TEXT } from '../hooks';
import type { Label, Suggestion } from '../types';

interface Draft {
  start: number;
  end: number;
  text: string;
}

/** 用 Selection 的字符偏移定位正文中的选区（正文渲染为单个文本节点）。 */
function getDraft(
  surface: HTMLDivElement,
  selection: Selection | null,
  body: string,
): Draft | null {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!surface.contains(range.startContainer) || !surface.contains(range.endContainer)) {
    return null;
  }
  const pre = range.cloneRange();
  pre.selectNodeContents(surface);
  pre.setEnd(range.startContainer, range.startOffset);
  const start = pre.toString().length;
  const end = start + range.toString().length;
  if (end <= start || end > body.length) return null;
  return { start, end, text: body.slice(start, end) };
}

export default function CheckerWorkspace() {
  const { labelId, label, suggestions, error, loading, reload } = useLabelData();
  useVersionPolling(label?.currentVersion, reload);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [replacement, setReplacement] = useState('');
  const [basis, setBasis] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [formOk, setFormOk] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function onMouseUp() {
    if (!label || !surfaceRef.current) return;
    const d = getDraft(surfaceRef.current, window.getSelection(), label.body);
    if (d) {
      setDraft(d);
      setFormError(null);
      setFormOk(null);
    }
  }

  function clearDraft() {
    setDraft(null);
    setReplacement('');
    setBasis('');
    window.getSelection()?.removeAllRanges();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!label || !draft) return;
    setFormError(null);
    setFormOk(null);
    setSubmitting(true);
    try {
      await api('POST', `/api/labels/${labelId}/suggestions`, {
        start: draft.start,
        end: draft.end,
        replacement,
        basis,
        expectedVersion: label.currentVersion,
      });
      clearDraft();
      setFormOk('建议已提交，等待馆员审批。');
      reload();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : '提交失败');
    } finally {
      setSubmitting(false);
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

  return (
    <div className="container two-col">
      <section>
        <LabelHeader label={label} onReload={reload} />

        <div className="card">
          <div className="section-title">
            当前正文 <span className="badge badge-version">v{label.currentVersion}</span>
            <span className="muted small">（按住鼠标拖动，选择连续文字）</span>
          </div>
          <div
            ref={surfaceRef}
            className="body-surface selectable"
            onMouseUp={onMouseUp}
          >
            {label.body}
          </div>
        </div>

        {draft && (
          <form className="card draft-card" onSubmit={submit}>
            <div className="section-title">新建替换建议</div>
            <div className="draft-quote">
              <span className="muted small">选区：</span>
              <q>{draft.text.length > 60 ? draft.text.slice(0, 60) + '…' : draft.text}</q>
              <span className="muted small">
                [{draft.start}, {draft.end}) · v{label.currentVersion}
              </span>
            </div>
            <label className="field">
              <span>替换文本</span>
              <textarea
                value={replacement}
                onChange={(e) => setReplacement(e.target.value)}
                rows={2}
                placeholder="输入替换后的文字"
                required
              />
            </label>
            <label className="field">
              <span>校核依据</span>
              <textarea
                value={basis}
                onChange={(e) => setBasis(e.target.value)}
                rows={3}
                placeholder="例如：权威文献、辞书条目、文字学依据…"
                required
              />
            </label>
            {formError && <div className="notice notice-error">{formError}</div>}
            <div className="row-actions">
              <button type="submit" className="btn btn-primary" disabled={submitting}>
                {submitting ? '提交中…' : '提交建议'}
              </button>
              <button type="button" className="btn btn-ghost" onClick={clearDraft}>
                取消
              </button>
            </div>
          </form>
        )}
        {!draft && formOk && <div className="notice notice-ok">{formOk}</div>}
      </section>

      <aside>
        <SuggestionList
          suggestions={suggestions}
          currentVersion={label.currentVersion}
        />
      </aside>
    </div>
  );
}

export function LabelHeader({ label, onReload }: { label: Label; onReload: () => void }) {
  return (
    <div className="page-head">
      <div>
        <h1 className="page-title">{label.title}</h1>
        <div className="muted">{label.subtitle}</div>
      </div>
      <button type="button" className="btn btn-ghost" onClick={onReload}>
        刷新
      </button>
    </div>
  );
}

export function ErrorBox({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div className="notice notice-error">
      {text}
      <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
        重试
      </button>
    </div>
  );
}

export function SuggestionList({
  suggestions,
  currentVersion,
  actions,
}: {
  suggestions: Suggestion[];
  currentVersion: number;
  actions?: (s: Suggestion) => JSX.Element | null;
}) {
  if (suggestions.length === 0) {
    return <div className="card muted">暂无建议。</div>;
  }
  return (
    <div className="stack">
      {[...suggestions]
        .sort((a, b) => a.id - b.id)
        .map((s) => (
          <div key={s.id} className={`card suggestion-card status-${s.status}`}>
            <div className="suggestion-head">
              <span className={`badge ${STATUS_CLASS[s.status]}`}>
                #{s.id} {STATUS_TEXT[s.status]}
              </span>
              <span className="muted small">{s.authorName} · {formatTime(s.createdAt)}</span>
            </div>
            <div className="suggestion-pair">
              <div className="pair-row">
                <span className="pair-tag tag-old">原</span>
                <span className="pair-text">{s.selectedText}</span>
              </div>
              <div className="pair-row">
                <span className="pair-tag tag-new">改</span>
                <span className="pair-text">{s.replacement}</span>
              </div>
            </div>
            <div className="basis">
              <span className="muted small">依据：</span>
              {s.basis}
            </div>
            <div className="muted small meta-line">
              提交基于 v{s.basedOnVersion}
              {s.status === 'pending' && ` · 选区现指向 v${s.rangeVersion}`}
              {s.status === 'adopted' && ` · 已在 v${s.adoptedInVersion} 采纳`}
              {s.status === 'pending' && s.rangeVersion !== currentVersion && (
                <span className="moved-hint">（正文更新后已随文字位移）</span>
              )}
            </div>
            {s.status === 'conflict' && s.conflictReason && (
              <div className="conflict-reason">{s.conflictReason}</div>
            )}
            {actions?.(s)}
          </div>
        ))}
    </div>
  );
}

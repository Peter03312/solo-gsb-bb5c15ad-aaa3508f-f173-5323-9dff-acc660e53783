import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';

interface Props {
  labelId: number;
  expectedVersion: number;
  onClose: () => void;
  onPublished: () => void;
}

export default function PublishDialog({
  labelId,
  expectedVersion,
  onClose,
  onPublished,
}: Props) {
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api('POST', `/api/labels/${labelId}/publish`, {
        expectedVersion,
        note,
      });
      onPublished();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '发布失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal card" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="section-title">发布正文 v{expectedVersion}</div>
        <p className="muted small">
          发布将把当前正文与全部已采纳记录固化为不可变快照；之后继续审批、编辑不会改写本次发布。
        </p>
        <label className="field">
          <span>发布说明（可选）</span>
          <textarea
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="例如：本季度校订，共采纳 3 处"
          />
        </label>
        {error && <div className="notice notice-error">{error}</div>}
        <div className="row-actions">
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? '发布中…' : '确认发布'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
        </div>
      </form>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAuth } from '../auth-context';
import { formatTime } from '../hooks';
import type {
  DiffResult,
  DiffOp,
  Publication,
  PublicationSummary,
} from '../types';

const LABEL_ID = 1;

export default function Publications() {
  const { user, loading } = useAuth();
  const [publications, setPublications] = useState<PublicationSummary[]>([]);
  const [fromVersion, setFromVersion] = useState<number | ''>('');
  const [toVersion, setToVersion] = useState<number | ''>('');
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [detail, setDetail] = useState<Publication | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    try {
      const data = await api<{ publications: PublicationSummary[] }>(
        'GET',
        `/api/labels/${LABEL_ID}/publications`,
      );
      setPublications(data.publications);
      setListError(null);
      if (data.publications.length >= 2) {
        setFromVersion((prev) =>
          prev === '' ? data.publications[data.publications.length - 2].labelVersion : prev,
        );
        setToVersion((prev) =>
          prev === '' ? data.publications[data.publications.length - 1].labelVersion : prev,
        );
      }
    } catch (err) {
      setListError(err instanceof ApiError ? err.message : '加载发布历史失败');
    }
  }, []);

  useEffect(() => {
    if (user) void loadList();
  }, [user, loadList]);

  const canCompare =
    typeof fromVersion === 'number' &&
    typeof toVersion === 'number' &&
    fromVersion < toVersion;

  async function compare() {
    if (!canCompare) return;
    setDiffError(null);
    setDiff(null);
    try {
      const data = await api<DiffResult>(
        'GET',
        `/api/labels/${LABEL_ID}/diff?from=${fromVersion}&to=${toVersion}`,
      );
      setDiff(data);
    } catch (err) {
      setDiffError(err instanceof ApiError ? err.message : '差异查询失败');
    }
  }

  async function openDetail(id: number) {
    setDetailError(null);
    setDetail(null);
    try {
      const data = await api<{ publication: Publication }>(
        'GET',
        `/api/publications/${id}`,
      );
      setDetail(data.publication);
    } catch (err) {
      setDetailError(err instanceof ApiError ? err.message : '加载发布详情失败');
    }
  }

  if (loading) return <div className="container muted center">加载中…</div>;
  if (!user) return <Navigate to="/login" replace />;

  return (
    <div className="container publications-layout">
      <h1 className="page-title">发布与版本</h1>

      {listError && <div className="notice notice-error">{listError}</div>}

      <section className="card">
        <div className="section-title">发布历史（不可变快照）</div>
        <table className="pub-table">
          <thead>
            <tr>
              <th>版本</th>
              <th>发布时间</th>
              <th>发布人</th>
              <th>采纳数</th>
              <th>说明</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {publications.map((p) => (
              <tr key={p.id}>
                <td>
                  <span className="badge badge-version">v{p.labelVersion}</span>
                </td>
                <td>{formatTime(p.publishedAt)}</td>
                <td>{p.publishedBy}</td>
                <td>{p.adoptionCount}</td>
                <td className="muted">{p.note || '—'}</td>
                <td>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => void openDetail(p.id)}
                  >
                    查看固化正文
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {detailError && <div className="notice notice-error">{detailError}</div>}
        {detail && <PublicationDetail detail={detail} onClose={() => setDetail(null)} />}
      </section>

      <section className="card">
        <div className="section-title">比较两次发布的正文差异</div>
        {publications.length < 2 ? (
          <div className="muted">至少需要两次发布才能比较。馆员可在审批工作台采纳建议后再次发布。</div>
        ) : (
          <>
            <div className="diff-controls">
              <label className="field inline">
                <span>自</span>
                <select
                  value={fromVersion}
                  onChange={(e) =>
                    setFromVersion(e.target.value === '' ? '' : Number(e.target.value))
                  }
                >
                  {publications.map((p) => (
                    <option key={p.id} value={p.labelVersion}>
                      v{p.labelVersion}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field inline">
                <span>至</span>
                <select
                  value={toVersion}
                  onChange={(e) =>
                    setToVersion(e.target.value === '' ? '' : Number(e.target.value))
                  }
                >
                  {publications.map((p) => (
                    <option key={p.id} value={p.labelVersion}>
                      v{p.labelVersion}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={!canCompare}
                onClick={() => void compare()}
              >
                比较
              </button>
              {!canCompare && (
                <span className="muted small">起点版本必须早于终点版本</span>
              )}
            </div>
            {diffError && <div className="notice notice-error">{diffError}</div>}
            {diff && <DiffView diff={diff} />}
          </>
        )}
      </section>
    </div>
  );
}

function PublicationDetail({
  detail,
  onClose,
}: {
  detail: Publication;
  onClose: () => void;
}) {
  const sortedAdoptions = useMemo(
    () => [...detail.adoptions].sort((a, b) => a.sel_start - b.sel_start),
    [detail],
  );
  return (
    <div className="pub-detail">
      <div className="pub-detail-head">
        <strong>v{detail.labelVersion} 固化正文</strong>
        <span className="muted small">
          {detail.publishedBy} · {formatTime(detail.publishedAt)}
        </span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
          关闭
        </button>
      </div>
      <div className="body-surface frozen">{detail.body}</div>
      <div className="muted small">本次发布固化的采纳记录（{sortedAdoptions.length} 条）：</div>
      {sortedAdoptions.length === 0 ? (
        <div className="muted small">无（初始发布）。</div>
      ) : (
        <ul className="frozen-list">
          {sortedAdoptions.map((a) => (
            <li key={a.id}>
              <span className="pair-tag tag-old">原</span>
              {a.selected_text} → <span className="pair-tag tag-new">改</span>
              {a.replacement}
              <span className="muted small">
                {' '}
                （建议 #{a.suggestion_id}，{a.author_name}，采纳于 v{a.adopted_in_version}）
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DiffView({ diff }: { diff: DiffResult }) {
  return (
    <div>
      <div className="muted small diff-meta">
        v{diff.from.labelVersion}（{formatTime(diff.from.publishedAt)}） → v
        {diff.to.labelVersion}（{formatTime(diff.to.publishedAt)}） · 新增 {diff.stats.insert}{' '}
        字，删除 {diff.stats.delete} 字
      </div>
      <div className="diff-body">
        {diff.ops.map((op: DiffOp, i: number) => {
          if (op.type === 'equal') return <span key={i}>{op.value}</span>;
          if (op.type === 'insert')
            return (
              <ins key={i} title="新发布中新增">
                {op.value}
              </ins>
            );
          return (
            <del key={i} title="旧发布内容">
              {op.value}
            </del>
          );
        })}
      </div>
    </div>
  );
}

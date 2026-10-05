import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { Label, Suggestion } from './types';

const LABEL_ID = 1;

export function useLabelData() {
  const [label, setLabel] = useState<Label | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadTick, setReloadTick] = useState(0);

  const reload = useCallback(() => setReloadTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api<{ label: Label }>('GET', `/api/labels/${LABEL_ID}`),
      api<{ suggestions: Suggestion[] }>(
        'GET',
        `/api/labels/${LABEL_ID}/suggestions`,
      ),
    ])
      .then(([l, s]) => {
        if (cancelled) return;
        setLabel(l.label);
        setSuggestions(s.suggestions);
        setError(null);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  return { labelId: LABEL_ID, label, suggestions, error, loading, reload, setLabel, setSuggestions };
}

/** 用 label 当前版本自动轮询，及时看到对方账号的改动（版本变化即刷新）。 */
export function useVersionPolling(currentVersion: number | undefined, reload: () => void) {
  const versionRef = useRef<number | undefined>(currentVersion);
  useEffect(() => {
    versionRef.current = currentVersion;
  }, [currentVersion]);

  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        const data = await api<{ labels: Label[] }>('GET', '/api/labels');
        const latest = data.labels[0];
        if (latest && versionRef.current !== undefined && latest.currentVersion > versionRef.current) {
          versionRef.current = latest.currentVersion;
          reload();
        }
      } catch {
        // 轮询失败静默忽略
      }
    }, 6000);
    return () => clearInterval(timer);
  }, [reload]);
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

export const STATUS_TEXT: Record<Suggestion['status'], string> = {
  pending: '待审',
  adopted: '已采纳',
  conflict: '冲突',
};

export const STATUS_CLASS: Record<Suggestion['status'], string> = {
  pending: 'badge-pending',
  adopted: 'badge-adopted',
  conflict: 'badge-conflict',
};

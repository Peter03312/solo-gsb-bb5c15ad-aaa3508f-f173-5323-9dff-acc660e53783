import { FormEvent, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth-context';
import { ApiError } from '../api';

export default function Login() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('checker');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (user) {
    return (
      <Navigate
        to={user.role === 'checker' ? '/checker' : '/reviewer'}
        replace
      />
    );
  }

  const from = (location.state as { from?: { pathname: string } } | null)?.from;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(username.trim(), password);
      navigate(
        from?.pathname ??
          (username.trim() === 'librarian' ? '/reviewer' : '/checker'),
        { replace: true },
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '登录失败，请重试');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={onSubmit}>
        <h1 className="login-title">展览展签校核</h1>
        <p className="muted login-hint">
          校核人提交文字替换建议；馆员按正文版本审批、处理冲突并发布。
        </p>

        <label className="field">
          <span>账号</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label className="field">
          <span>密码</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        {error && <div className="notice notice-error">{error}</div>}

        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? '登录中…' : '登录'}
        </button>

        <div className="demo-accounts">
          <div className="muted small">演示账号（本地）：</div>
          <div className="small">
            <code>checker / checker123</code>（校核人）
          </div>
          <div className="small">
            <code>librarian / librarian123</code>（馆员）
          </div>
        </div>
      </form>
    </div>
  );
}

import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth-context';
import Login from './pages/Login';
import CheckerWorkspace from './pages/CheckerWorkspace';
import ReviewerWorkspace from './pages/ReviewerWorkspace';
import Publications from './pages/Publications';
import type { Role } from './types';

function RequireRole({ role, children }: { role: Role; children: JSX.Element }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="container muted center">加载中…</div>;
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  if (user.role !== role) {
    return (
      <div className="container">
        <div className="notice notice-error">
          无权限：当前账号「{user.displayName}」是{user.role === 'librarian' ? '馆员' : '校核人'}，
          {role === 'librarian' ? '馆员' : '校核人'}页面无法访问。
        </div>
      </div>
    );
  }
  return children;
}

function Header() {
  const { user, logout } = useAuth();
  if (!user) return null;
  const isChecker = user.role === 'checker';
  return (
    <header className="app-header">
      <div className="container header-inner">
        <div className="brand">
          <span className="brand-mark">展</span>
          <div>
            <div className="brand-title">展览展签校核</div>
            <div className="brand-sub">
              {user.displayName} · {isChecker ? '校核人' : '馆员'}
            </div>
          </div>
        </div>
        <nav className="nav">
          <NavLink to={isChecker ? '/checker' : '/reviewer'}>
            {isChecker ? '校核工作台' : '审批工作台'}
          </NavLink>
          <NavLink to="/publications">发布与版本</NavLink>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              void logout();
            }}
          >
            退出登录
          </button>
        </nav>
      </div>
    </header>
  );
}

export default function App() {
  const { user, loading } = useAuth();

  return (
    <>
      <Header />
      <main>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/checker"
            element={
              <RequireRole role="checker">
                <CheckerWorkspace />
              </RequireRole>
            }
          />
          <Route
            path="/reviewer"
            element={
              <RequireRole role="librarian">
                <ReviewerWorkspace />
              </RequireRole>
            }
          />
          <Route path="/publications" element={<Publications />} />
          <Route
            path="*"
            element={
              loading ? null : (
                <Navigate
                  to={
                    user
                      ? user.role === 'checker'
                        ? '/checker'
                        : '/reviewer'
                      : '/login'
                  }
                  replace
                />
              )
            }
          />
        </Routes>
      </main>
    </>
  );
}

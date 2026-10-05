import { Router } from 'express';
import { db, type UserRow } from '../db.js';
import { HttpError } from '../http-error.js';
import { verifyPassword } from '../security.js';
import { SESSION_DAYS, createSession } from '../auth.js';

export const authRouter = Router();

authRouter.post('/login', (req, res) => {
  const { username, password } = req.body ?? {};
  if (typeof username !== 'string' || typeof password !== 'string' ||
      !username.trim() || !password) {
    throw new HttpError(400, '请输入账号和密码', 'invalid_credentials');
  }

  const user = db
    .prepare('SELECT * FROM users WHERE username = ?')
    .get(username.trim()) as UserRow | undefined;

  if (!user || !verifyPassword(password, user.password_hash)) {
    throw new HttpError(401, '账号或密码不正确', 'invalid_credentials');
  }

  const { token, expiresAt } = createSession(user.id);
  res.cookie('session', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: SESSION_DAYS * 86_400_000,
  });

  res.json({
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      role: user.role,
      createdAt: user.created_at,
      sessionExpiresAt: expiresAt,
    },
  });
});

authRouter.post('/logout', (req, res) => {
  const token = req.cookies?.session;
  if (typeof token === 'string') {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }
  res.clearCookie('session');
  res.json({ ok: true });
});

authRouter.get('/me', (req, res) => {
  if (!req.user) {
    res.json({ user: null });
    return;
  }
  const u = req.user;
  res.json({
    user: {
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      role: u.role,
      createdAt: u.created_at,
    },
  });
});

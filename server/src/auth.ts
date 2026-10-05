import type { NextFunction, Request, Response } from 'express';
import { db, type UserRow } from './db.js';
import { HttpError } from './http-error.js';
import { newToken } from './security.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: Omit<UserRow, 'password_hash'>;
    }
  }
}

const SESSION_DAYS = Number(process.env.SESSION_DAYS ?? '30');

export function createSession(userId: number): {
  token: string;
  expiresAt: string;
} {
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  db.prepare(
    `INSERT INTO sessions (token, user_id, expires_at, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(token, userId, expiresAt, new Date().toISOString());
  return { token, expiresAt };
}

/** 从 Cookie 解析当前登录用户（未登录则 req.user 为 undefined）。 */
export function loadCurrentUser(req: Request, _res: Response, next: NextFunction): void {
  const token = req.cookies?.session;
  if (typeof token === 'string' && token.length === 64) {
    const row = db
      .prepare(
        `SELECT u.id, u.username, u.display_name, u.role, u.created_at, s.expires_at
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token = ?`,
      )
      .get(token) as
      | (Omit<UserRow, 'password_hash'> & { expires_at: string })
      | undefined;
    if (row && new Date(row.expires_at) > new Date()) {
      const { expires_at: _ignored, ...user } = row;
      req.user = user;
    }
  }
  next();
}

/** 要求已登录，否则 401。 */
export function requireAuth(req: Request): Omit<UserRow, 'password_hash'> {
  if (!req.user) {
    throw new HttpError(401, '未登录或会话已过期，请重新登录', 'unauthorized');
  }
  return req.user;
}

/** 要求具备指定角色，否则 403 并说明原因（不改变任何数据）。 */
export function requireRole(
  req: Request,
  role: UserRow['role'],
): Omit<UserRow, 'password_hash'> {
  const user = requireAuth(req);
  if (user.role !== role) {
    const label = role === 'librarian' ? '馆员' : '校核人';
    throw new HttpError(
      403,
      `无权限：该操作仅限${label}，当前账号「${user.display_name}」为${
        user.role === 'librarian' ? '馆员' : '校核人'
      }`,
      'forbidden',
    );
  }
  return user;
}

export { SESSION_DAYS };

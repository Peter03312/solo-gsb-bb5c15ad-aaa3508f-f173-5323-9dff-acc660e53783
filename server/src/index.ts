import express from 'express';
import cookieParser from 'cookie-parser';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDatabase } from './db.js';
import { loadCurrentUser } from './auth.js';
import { HttpError } from './http-error.js';
import { authRouter } from './routes/auth.js';
import { labelsRouter } from './routes/labels.js';
import { suggestionsRouter } from './routes/suggestions.js';
import { publicationsRouter } from './routes/publications.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 默认指向 workspace/web/dist（容器中为绝对路径 /app/web/dist）
const DEFAULT_PUBLIC_DIR = path.resolve(__dirname, '../../web/dist');
const PUBLIC_DIR = process.env.PUBLIC_DIR
  ? path.resolve(process.env.PUBLIC_DIR)
  : DEFAULT_PUBLIC_DIR;
const PORT = Number(process.env.PORT ?? '4000');

// 启动即初始化数据库（建表 + 幂等播种）
initDatabase();

if (process.argv.includes('--init-only')) {
  console.log('数据库初始化完成（--init-only），退出。');
  process.exit(0);
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(loadCurrentUser);

app.use('/api', authRouter);
app.use('/api/labels', labelsRouter);
app.use('/api', suggestionsRouter);
app.use('/api', publicationsRouter);

app.use('/api', (_req, _res, next) => {
  next(new HttpError(404, '接口不存在', 'not_found'));
});

// 统一错误处理：把原因返回给前端，且路由内已在事务中抛错回滚，不改变数据
app.use(
  (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    if (err instanceof SyntaxError) {
      res.status(400).json({ error: '请求体不是合法 JSON', code: 'bad_json' });
      return;
    }
    console.error(err);
    res.status(500).json({ error: '服务器内部错误', code: 'internal' });
  },
);

// 生产环境托管前端构建产物
if (existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`展览展签校核服务已启动：http://localhost:${PORT}`);
  console.log(`数据库目录：${process.env.DB_PATH ?? '/data/app.db'}`);
});

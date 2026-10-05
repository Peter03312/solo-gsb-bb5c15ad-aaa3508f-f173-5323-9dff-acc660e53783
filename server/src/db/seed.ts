import type Database from 'better-sqlite3';
import { hashPassword } from '../security.js';

/** 演示展签正文，内含三处待校核问题（其中两处选区互相重叠，用于演示冲突）。 */
const DEMO_BODY =
  '北宋·范宽《溪山行旅图》，绢本水墨，纵二〇六点三厘米，横一〇三点三厘米，' +
  '现藏于台北故宫博物院。画面巨峰壁立，飞瀑如链，山脚下雾蔼蒸腾，一队商旅沿溪而行。' +
  '范宽以雨点皴表现北方山水的雄强气势，署款“范宽”二字藏于树阴之中，' +
  '一九五八年始被学者确认。此画与郭熙《早春图》、李唐《万壑松风图》并称北宋三大山水名迹。';

const SEED_TIME = '2026-09-01T09:00:00.000Z';

function findRange(body: string, needle: string): { start: number; end: number } {
  const start = body.indexOf(needle);
  if (start < 0) throw new Error(`播种失败：在演示正文中找不到「${needle}」`);
  return { start, end: start + needle.length };
}

/** 幂等播种：账号、演示展签、初始版本、三条待审建议、一次初始发布。 */
export function seed(database: Database.Database): void {
  const userCount = database
    .prepare('SELECT COUNT(*) AS c FROM users')
    .get() as { c: number };

  if (userCount.c === 0) {
    const insertUser = database.prepare(
      `INSERT INTO users (username, display_name, password_hash, role, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    insertUser.run(
      'checker',
      '校核人·林校',
      hashPassword('checker123'),
      'checker',
      SEED_TIME,
    );
    insertUser.run(
      'librarian',
      '馆员·周馆',
      hashPassword('librarian123'),
      'librarian',
      SEED_TIME,
    );
  }

  const labelCount = database
    .prepare('SELECT COUNT(*) AS c FROM labels')
    .get() as { c: number };

  if (labelCount.c > 0) return;

  const checker = database
    .prepare("SELECT id FROM users WHERE username = 'checker'")
    .get() as { id: number };
  const librarian = database
    .prepare("SELECT id FROM users WHERE username = 'librarian'")
    .get() as { id: number };

  const insertLabel = database.prepare(
    `INSERT INTO labels (id, title, subtitle, current_version, created_at, updated_at)
     VALUES (1, ?, ?, 1, ?, ?)`,
  );
  insertLabel.run(
    '溪山行旅图',
    '北宋 · 范宽',
    SEED_TIME,
    SEED_TIME,
  );

  database
    .prepare(
      `INSERT INTO label_versions (label_id, version, body, created_at)
       VALUES (1, 1, ?, ?)`,
    )
    .run(DEMO_BODY, SEED_TIME);

  const insertSuggestion = database.prepare(
    `INSERT INTO suggestions
       (label_id, author_id, sel_start, sel_end, selected_text, replacement, basis,
        status, range_version, based_on_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 1, 1, ?, ?)`,
  );

  // 建议 1：仅替换错字「链」
  const chain = findRange(DEMO_BODY, '链');
  insertSuggestion.run(
    1, checker.id, chain.start, chain.end, '链', '练',
    '成语“飞瀑如练”，练指洁白熟绢；“链”为形近误用。',
    SEED_TIME, SEED_TIME,
  );

  // 建议 2：选区与建议 1 重叠（含错字并顺带改标点）——采纳其一会使另一条转为冲突
  const overlap = findRange(DEMO_BODY, '飞瀑如链，山脚');
  insertSuggestion.run(
    1, checker.id, overlap.start, overlap.end, '飞瀑如链，山脚',
    '飞瀑如练。山脚',
    '“飞瀑如练”为规范写法；前后为两层句意，宜断句。',
    SEED_TIME, SEED_TIME,
  );

  // 建议 3：与前两条不重叠，前一条采纳后其选区应随文字位移
  const mist = findRange(DEMO_BODY, '雾蔼');
  insertSuggestion.run(
    1, checker.id, mist.start, mist.end, '雾蔼', '雾霭',
    '“霭”指云气，“蔼”为和气；此处应用“雾霭”。',
    SEED_TIME, SEED_TIME,
  );

  // 初始发布：固化 v1 正文与（当时为空的）采纳记录，供后续比对
  const pub = database
    .prepare(
      `INSERT INTO publications (label_id, label_version, body, published_by, published_at, note)
       VALUES (1, 1, ?, ?, ?, ?)`,
    )
    .run(DEMO_BODY, librarian.id, SEED_TIME, '展签初始发布');
  // 初始发布时尚无任何采纳，publication_adoptions 不产生记录
}

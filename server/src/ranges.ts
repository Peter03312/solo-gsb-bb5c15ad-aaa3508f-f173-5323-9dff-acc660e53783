/** 纯函数：文本选区区间的位移与冲突判定。 */

export interface Range {
  start: number;
  end: number;
}

/**
 * 在编辑区间 [editStart, editEnd)、旧长度 oldLen、新长度 newLen 后，
 * 计算待审建议新区间。
 *
 * 规则：
 * - 与编辑区有重叠（含边界交叉且不是“紧邻前方”）→ 冲突，返回 null；
 * - 完全在编辑点之前（end <= editStart）→ 不动；
 * - 完全在编辑点之后（start >= editEnd）→ 整体平移 delta。
 */
export function transformRange(
  r: Range,
  editStart: number,
  oldLen: number,
  newLen: number,
): Range | null {
  const editEnd = editStart + oldLen;

  if (r.end <= editStart) {
    return { start: r.start, end: r.end };
  }
  if (r.start >= editEnd) {
    const delta = newLen - oldLen;
    return { start: r.start + delta, end: r.end + delta };
  }
  return null;
}

/** 判断两个闭向选区是否重叠（边界相接不算重叠）。 */
export function rangesOverlap(a: Range, b: Range): boolean {
  return a.start < b.end && b.start < a.end;
}

export interface GroupEdit {
  id: number;
  start: number;
  end: number;
  replacement: string;
}

export interface AppliedGroupEdit extends GroupEdit {
  /** 该条替换在全部替换完成后的新正文中的区间。 */
  finalStart: number;
  finalEnd: number;
}

/**
 * 按原正文位置一次性应用一组互不重叠的替换，形成新正文，
 * 并给出每条替换在新正文中的最终区间。
 *
 * 调用方需保证 edits 已按 start 排序且两两不重叠（边界相接允许）。
 */
export function applyGroupEdits(
  body: string,
  edits: GroupEdit[],
): { body: string; applied: AppliedGroupEdit[] } {
  let out = '';
  let cursor = 0;
  let shift = 0;
  const applied: AppliedGroupEdit[] = [];

  for (const e of edits) {
    out += body.slice(cursor, e.start) + e.replacement;
    const finalStart = e.start + shift;
    const finalEnd = finalStart + e.replacement.length;
    applied.push({ ...e, finalStart, finalEnd });
    shift += e.replacement.length - (e.end - e.start);
    cursor = e.end;
  }
  out += body.slice(cursor);

  return { body: out, applied };
}

/**
 * 一组替换全部生效后，计算某个未参与替换的待审选区的新坐标。
 * 与任一替换区间重叠（边界相接不算）返回 null（调用方据此转冲突）；
 * 否则起止坐标平移其前方（end <= start）所有替换的长度差之和。
 */
export function transformRangeAcrossEdits(r: Range, edits: GroupEdit[]): Range | null {
  let shift = 0;
  for (const e of edits) {
    if (rangesOverlap(r, { start: e.start, end: e.end })) return null;
    if (e.end <= r.start) {
      shift += e.replacement.length - (e.end - e.start);
    }
  }
  return { start: r.start + shift, end: r.end + shift };
}

/** 返回一组区间中所有重叠对的编号（边界相接不算），编号对按 id 升序。 */
export function findOverlapPairs(
  ranges: ReadonlyArray<{ id: number; start: number; end: number }>,
): Array<[number, number]> {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      if (sorted[j].start >= sorted[i].end) break;
      const a = sorted[i].id;
      const b = sorted[j].id;
      pairs.push(a <= b ? [a, b] : [b, a]);
    }
  }
  pairs.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  return pairs;
}

/** 校验选区是否合法且与当前正文一致。返回错误原因，或 null 表示合法。 */
export function validateSelection(
  body: string,
  start: unknown,
  end: unknown,
  selectedText?: string,
): string | null {
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    return '选区偏移必须为整数';
  }
  const s = start as number;
  const e = end as number;
  if (s < 0 || e > body.length) {
    return `选区越界：正文长度为 ${body.length}，收到 [${s}, ${e})`;
  }
  if (e <= s) {
    return '选区为空或方向错误：结束位置必须大于开始位置';
  }
  if (selectedText !== undefined && body.slice(s, e) !== selectedText) {
    return '选区与当前正文不一致，所选文字可能已被改动，请刷新后重新选择';
  }
  return null;
}

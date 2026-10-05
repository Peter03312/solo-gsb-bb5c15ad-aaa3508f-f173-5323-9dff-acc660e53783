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

/** 一次成组采纳中的单条编辑：原正文区间与替换文本。 */
export interface Edit {
  start: number;
  end: number;
  replacement: string;
}

/** 成组应用后，单条编辑在最终正文中的落点。 */
export interface AppliedEdit {
  start: number;
  end: number;
  replacement: string;
  finalStart: number;
  finalEnd: number;
}

/**
 * 把一组互不重叠（边界相接允许）的编辑一次性应用到正文：
 * 按原正文位置单趟拼接，同时算出每条编辑在最终正文中的区间（结果顺序与排序后输入一致）。
 * 调用方须先保证编辑两两不重叠。
 */
export function applyEdits(body: string, edits: Edit[]): {
  body: string;
  applied: AppliedEdit[];
} {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  let out = '';
  let cursor = 0;
  let offset = 0;
  const applied: AppliedEdit[] = [];
  for (const e of sorted) {
    out += body.slice(cursor, e.start) + e.replacement;
    const finalStart = e.start + offset;
    applied.push({
      ...e,
      finalStart,
      finalEnd: finalStart + e.replacement.length,
    });
    offset += e.replacement.length - (e.end - e.start);
    cursor = e.end;
  }
  out += body.slice(cursor);
  return { body: out, applied };
}

/**
 * 未选待审建议在一组编辑全部完成后的新区间（坐标均以编辑前正文为基准）：
 * 与任一编辑区间重叠（边界相接不算）→ null（应转为冲突）；
 * 否则叠加所有“完全在其之前”的编辑造成的位移。
 */
export function transformRangeAcrossEdits(r: Range, edits: Edit[]): Range | null {
  let delta = 0;
  for (const e of edits) {
    if (rangesOverlap(r, { start: e.start, end: e.end })) return null;
    if (e.end <= r.start) delta += e.replacement.length - (e.end - e.start);
  }
  return { start: r.start + delta, end: r.end + delta };
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

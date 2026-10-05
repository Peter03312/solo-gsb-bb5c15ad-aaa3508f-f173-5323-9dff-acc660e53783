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

/** 正文差异计算：CJK 按单字、拉丁按单词、空白/标点各自成 token，再做 LCS。 */

export type DiffOp =
  | { type: 'equal'; value: string }
  | { type: 'insert'; value: string }
  | { type: 'delete'; value: string };

// 中日韩统一表意文字及常见扩展区逐字切分；拉丁字母数字按词；其余符号按字符
const TOKEN_RE =
  /[㐀-䶿一-鿿豈-﫿]|[A-Za-z0-9_]+|\s+|./g;

function tokenize(text: string): string[] {
  return text.match(TOKEN_RE) ?? [];
}

/** 计算两个正文之间的操作序列（基于最长公共子序列）。 */
export function diffTexts(oldText: string, newText: string): DiffOp[] {
  const a = tokenize(oldText);
  const b = tokenize(newText);
  const n = a.length;
  const m = b.length;

  // dp[i][j] = a[i:] 与 b[j:] 的 LCS 长度
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  const push = (type: DiffOp['type'], token: string) => {
    const last = ops[ops.length - 1];
    if (last && last.type === type) last.value += token;
    else ops.push({ type, value: token });
  };

  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push('equal', a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push('delete', a[i]);
      i++;
    } else {
      push('insert', b[j]);
      j++;
    }
  }
  while (i < n) push('delete', a[i++]);
  while (j < m) push('insert', b[j++]);

  return ops;
}

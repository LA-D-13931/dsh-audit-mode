#!/usr/bin/env bash
# 发布仓库自检（CI 与本地同一入口）。
# 退出码：0 全过 ／ 1 有失败 ／ 2 有没验成项（不是通过）
set -u
cd "$(dirname "$0")"

fail=0
unverified=0

echo "=== 1. JS 语法 ==="
while IFS= read -r -d '' f; do
  node --check "$f" || fail=1
done < <(find . -name '*.mjs' -not -path './.git/*' -print0)

echo "=== 2. enforce 自检 ==="
node enforce.js --self-test || fail=1

echo "=== 3. 评测集 ==="
node tools/跑评测.mjs || fail=1

echo "=== 4. YAML 语法 ==="
if command -v ruby >/dev/null 2>&1; then
  ruby -ryaml -e 'Psych.parse_file("cordis.patch.yml")' || fail=1
else
  echo "⚠️ 没有 ruby ⇒ YAML 没验成（不是通过）"
  unverified=1
fi

echo "=== 5. 隐私串扫描 ==="
if grep -RInE '/Users/[A-Za-z0-9]|CS231n|人智与图识|session-af8ee|@local/' . \
    --exclude-dir=.git --exclude-dir=node_modules --exclude=自检.sh > /tmp/audit-mode-privacy.$$ 2>/dev/null; then
  echo "✗ 发现本机/项目串："
  cat /tmp/audit-mode-privacy.$$
  fail=1
else
  echo "✓ 无私密路径/项目名"
fi
rm -f /tmp/audit-mode-privacy.$$

echo
if [ "$fail" -ne 0 ]; then
  echo "❌ 自检失败"
  exit 1
fi
if [ "$unverified" -ne 0 ]; then
  echo "⚠️ 有没验成项（不是通过）"
  exit 2
fi
echo "✓ 全部通过"
exit 0

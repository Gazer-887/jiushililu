#!/usr/bin/env node
// audit-docs.cjs —— 文档台账一致性审计
// 2026-09-16 立：`AGENTS.md` §四「台账可信度铁律」的**机制化**。
// 背景：2026-09-15 夜至 09-16 凌晨的 45 文件全量复验查出 20+ 处失真，其中一整类是
//   「CHANGELOG / README / 功能汇表 / progress.md 一页纸 的版本停在旧值」——
//   靠人记得更新靠不住，**变成脚本可检测的才算机制**（对照 `scripts/audit-css.cjs` 同一思路）。
//
// 用法：node scripts/audit-docs.cjs [--strict]
//   默认：硬性不一致 → error；滞后 → warning
//   --strict：warning 也按 error 处理（发版前建议用这个跑）
// 退出码：0 = 通过；1 = 存在 error（--strict 时含 warning）
//
// 检查项：
//   A. 版本一致性 —— `package.json` vs CHANGELOG 顶部 / README / 功能汇表基线 / progress.md 一页纸
//   B. 提交号抽验 —— 全文抓 7–8 位十六进制串，逐个 `git cat-file -t`；
//      查不到的先查 `.git/filter-repo/commit-map`（2026-09-10 历史重写，旧 SHA 合法存在过），
//      映射里也没有才判 error（**判"假"之前务必查一次** —— 2026-09-16 误判教训）

const { execFileSync } = require('node:child_process');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = process.cwd();
const STRICT = process.argv.includes('--strict');

let errors = 0;
let warnings = 0;
const lines = [];
function out(s) { lines.push(s); console.log(s); }
function err(s) { errors += 1; out(`  ✗ [ERROR] ${s}`); }
function warn(s) { warnings += 1; out(`  ! [WARN ] ${s}`); }
function ok(s) { out(`  ✓ ${s}`); }

function read(rel) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8');
}

function git(args, allowFail = true) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (e) {
    if (allowFail) return null;
    throw e;
  }
}

// ---------- A. 版本一致性 ----------
out('══ A. 版本一致性 ══');

const pkgRaw = read('package.json');
const pkgVer = pkgRaw ? (JSON.parse(pkgRaw).version || null) : null;
if (!pkgVer) { err('package.json 读不到 version'); }

const changelog = read('CHANGELOG.md');
let clVer = null;
if (changelog) {
  const m = changelog.match(/^##\s+(0\.\d+\.\d+)/m);
  clVer = m ? m[1] : null;
}

const readme = read('README.md');
let rdVer = null;
if (readme) {
  const m = readme.match(/\*\*(v?0\.\d+\.\d+)\*\*/);
  rdVer = m ? m[1].replace(/^v/, '') : null;
}

const huibiao = read(join('docs', '功能汇表.md'));
let hbVer = null;
if (huibiao) {
  const m = huibiao.match(/对账基线[:：]\s*\*?\*?(0\.\d+\.\d+)/);
  hbVer = m ? m[1] : null;
}

const progress = read(join('NOTEBOOK', 'progress.md'));
let pgVer = null;
if (progress) {
  // 一页纸「当前步骤」单元格：取该行内第一个 0.x.y 版本号
  const line = progress.split('\n').find((l) => l.includes('当前步骤'));
  if (line) {
    const m = line.match(/0\.\d+\.\d+/);
    pgVer = m ? m[0] : null;
  }
}

function cmp(name, got) {
  if (!got) { warn(`${name}: 未能提取版本号（可能措辞变了，检查提取正则）`); return; }
  if (got === pkgVer) ok(`${name} = ${got}（与 package.json 一致）`);
  else warn(`${name} = ${got}，落后于 package.json ${pkgVer} —— 更新它，或确认这本来就该滞后`);
}

if (pkgVer && clVer) {
  if (clVer === pkgVer) ok(`CHANGELOG 顶部 = ${clVer}（与 package.json 一致）`);
  else err(`CHANGELOG 顶部 = ${clVer} ≠ package.json ${pkgVer} —— 发版必更，这是硬规矩`);
} else if (!changelog) {
  err('CHANGELOG.md 不存在');
}
cmp('README', rdVer);
cmp('docs/功能汇表 对账基线', hbVer);
cmp('NOTEBOOK/progress.md 一页纸', pgVer);

// ---------- B. 提交号抽验 ----------
out('');
out('══ B. 提交号抽验 ══');

// 读 commit-map（历史重写的旧→新映射；不存在则视为无重写）
const mapPath = join(ROOT, '.git', 'filter-repo', 'commit-map');
const oldShas = new Set();
if (existsSync(mapPath)) {
  const map = readFileSync(mapPath, 'utf8');
  for (const line of map.split('\n').slice(1)) {
    const old = line.slice(0, 7);
    if (/^[0-9a-f]{7,}$/.test(old)) oldShas.add(old);
  }
}

// 抓取目标：对外文档 + 内部台账（PLAN/NOTEBOOK 的旧 SHA 失效同样误导后续会话）
const targets = [];
if (changelog) targets.push(['CHANGELOG.md', changelog]);
if (readme) targets.push(['README.md', readme]);
function addFile(rel) { const t = read(rel); if (t) targets.push([rel, t]); }
addFile(join('docs', '功能汇表.md'));
for (const f of ['progress.md', 'decisions.md', 'problem.md', 'learnings.md']) addFile(join('NOTEBOOK', f));
const planDir = join(ROOT, 'PLAN');
if (existsSync(planDir)) {
  for (const f of require('node:fs').readdirSync(planDir)) {
    if (/^plan\d+.*\.md$/.test(f)) addFile(join('PLAN', f));
  }
}

const seen = new Set();
let checked = 0;
for (const [name, text] of targets) {
  const shas = text.match(/\b[0-9a-f]{7,8}\b/g) || [];
  for (const sha of shas) {
    if (seen.has(sha)) continue;
    seen.add(sha);
    // 明显不是提交号的（全同字符如 0000000）跳过
    if (/^(.)\1+$/.test(sha)) continue;
    const t = git(['cat-file', '-t', sha]);
    if (t === 'commit' || t === 'tag') { checked += 1; continue; }
    if (oldShas.has(sha)) {
      warn(`${name}: ${sha} 是历史重写前的旧 SHA（见 .git/filter-repo/commit-map），引用不可解析 —— 建议两者并记或改用新值`);
      continue;
    }
    // ⚠️ 2026-09-16 实测教训：7–8 位 hex 也可能是**内容哈希**（如 ripgrep 二进制的 sha256
    //    片段，plan8 L881 的 `f9dde634…`）—— 脚本无法判断语义，故降为 warning 交人工确认，
    //    不武断判 error。
    warn(`${name}: ${sha} 不可解析 —— 若此处声称是**提交号**则为编造/笔误（必须修正）；也可能只是内容哈希片段，人工确认后可忽略`);
  }
}
ok(`直查通过 ${checked} 个（其余见上方逐条标注）`);

// ---------- 汇总 ----------
out('');
out('══ 汇总 ══');
out(`  error=${errors}  warning=${warnings}${STRICT ? '（--strict：warning 按 error 计）' : ''}`);
const fail = errors > 0 || (STRICT && warnings > 0);
out(fail ? '  结论：✗ 未通过' : '  结论：✓ 通过');
process.exit(fail ? 1 : 0);

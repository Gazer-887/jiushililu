// 测试夹具：Node 内置 assert 验证 sum(a, b)。
// 初始实现有缺陷 → 本文件预期失败；修复后应打印 SUM_TESTS_PASS。
const assert = require('node:assert')
const { sum } = require('./sum.cjs')

assert.strictEqual(sum(2, 3), 5, 'sum(2,3) 应为 5')
assert.strictEqual(sum(-2, 3), 1, 'sum(-2,3) 应为 1')
console.log('SUM_TESTS_PASS')

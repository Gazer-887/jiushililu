// 测试夹具：求和的实现带一个初始缺陷（返回差而非和），等待修复。
function sum(a, b) {
  return a - b
}

module.exports = { sum }

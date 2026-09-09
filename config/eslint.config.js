// ESLint 扁平配置。位于 config/ 子目录，package.json 的 lint 脚本用 --config 指回。
const js = require('@eslint/js')
const tseslint = require('typescript-eslint')

module.exports = [
  { ignores: ['out/**', 'node_modules/**', 'dist/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  }
]

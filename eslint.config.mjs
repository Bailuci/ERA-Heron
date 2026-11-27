/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 修改。
 * 日期：2026-11-26
 * 目的：lint 纳入 CI：忽略构建产物 artifact/ 与本地工作副本 .claude/，为 tests/*.cjs、scripts/*.cjs 配置 Node/CommonJS 环境
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import eslintConfigPrettier from 'eslint-config-prettier';
import eslintPluginBetterTailwindcss from 'eslint-plugin-better-tailwindcss';
import importx from 'eslint-plugin-import-x';
import pinia from 'eslint-plugin-pinia';
import vue from 'eslint-plugin-vue';
import { globalIgnores } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';
import vueParser from 'vue-eslint-parser';

/** @type {import('@typescript-eslint/utils').TSESLint.FlatConfig.ConfigFile} */
export default [
  js.configs.recommended,
  ...ts.configs.recommended,
  importx.flatConfigs.recommended,
  importx.flatConfigs.typescript,
  ...vue.configs['flat/recommended'],
  pinia.configs['recommended-flat'],
  {
    files: ['src/**/*.{html,vue,js,ts}'],
    plugins: {
      'better-tailwindcss': eslintPluginBetterTailwindcss,
    },
    rules: {
      ...eslintPluginBetterTailwindcss.configs['recommended-warn'].rules,
      ...eslintPluginBetterTailwindcss.configs['recommended-error'].rules,
      'better-tailwindcss/enforce-consistent-line-wrapping': ['off', { printWidth: 120 }],
      'better-tailwindcss/no-unregistered-classes': ['off', { ignore: ['fa-*'] }],
    },
    settings: {
      'better-tailwindcss': {
        entryPoint: 'src/global.css',
        tailwindConfig: 'tailwind.config.js',
      },
    },
  },
  {
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tsParser,
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      'handle-callback-err': 'off',
      'import-x/no-console': 'off',
      'import-x/no-cycle': 'error',
      'import-x/no-dynamic-require': 'warn',
      'import-x/no-nodejs-modules': 'warn',
      'no-dupe-class-members': 'off',
      'no-empty-function': 'off',
      'no-floating-decimal': 'error',
      'no-lonely-if': 'error',
      'no-multi-spaces': 'error',
      'no-redeclare': 'off',
      'no-shadow': 'off',
      'no-undef': 'off',
      'no-unused-vars': 'off',
      'no-var': 'error',
      'pinia/require-setup-store-properties-export': 'off',
      'prefer-const': 'warn',
      'vue/multi-word-component-names': 'off',
      yoda: 'error',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  {
    // 测试与仓库脚本在 Node 中以 CommonJS 运行
    files: ['tests/**/*.cjs', 'scripts/**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'import-x/no-nodejs-modules': 'off',
      // 断言里的正则按字面匹配生成的多行文本，连续空格更直观
      'no-regex-spaces': 'off',
    },
  },
  eslintConfigPrettier,
  globalIgnores([
    '.claude/**',
    'dist/**',
    'artifact/**',
    'node_modules/**',
    'eslint.config.mjs',
    'postcss.config.js',
    'webpack.config.ts',
  ]),
];

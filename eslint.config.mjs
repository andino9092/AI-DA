import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'release/**', 'coverage/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: [
      'src/main/**/*.ts',
      'src/preload/**/*.ts',
      'tests/**/*.ts',
      'scripts/**/*.cjs',
      '*.config.{ts,mjs}',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': 'warn',
    },
  },
  {
    // Privacy guarantee: only the Privacy Guard may mint ScrubbedText (see PLAN.md, "One way out").
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/main/privacy/guard.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "TSAsExpression > TSTypeReference[typeName.name='ScrubbedText']",
          message: 'Only the Privacy Guard may create ScrubbedText. Use guard.scrub().',
        },
        {
          selector: "TSTypeAssertion > TSTypeReference[typeName.name='ScrubbedText']",
          message: 'Only the Privacy Guard may create ScrubbedText. Use guard.scrub().',
        },
      ],
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);

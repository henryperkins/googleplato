import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    // .rc232*: Beta-RC-232's server/src, extracted for the upgrade gate and rehearsal.
    ignores: ['node_modules/**', 'client-dist/**', 'client-content/**', '.aws-sam/**', 'data/**', '.rc232/**', '.rc232-rehearsal-*/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-unreachable': 'error',
      'eqeqeq': ['warn', 'smart'],
    },
  },
];

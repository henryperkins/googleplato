import firebaseRulesPlugin from '@firebase/eslint-plugin-security-rules';

export default [
  {
    ignores: ['dist/**/*', 'client/**/*', 'server/**/*', 'node_modules/**/*', 'plugins/**/*', 'packages/**/*', 'scripts/**/*'],
  },
  firebaseRulesPlugin.configs['flat/recommended'],
];

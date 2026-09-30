import tseslint from 'typescript-eslint';

export default [{
  files: ['src/**/*.ts', 'scripts/**/*.ts'],
  languageOptions: { parser: tseslint.parser },
  rules: {
    complexity: ['error', { max: 10 }],
    'max-depth': ['error', 4],
    'max-statements': ['error', 35],
    'max-lines-per-function': ['error', { max: 90, skipBlankLines: true }],
  },
}];

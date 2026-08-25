import antfu from '@antfu/eslint-config';

export default antfu({
  ignores: ['templates/**'],
  pnpm: false,
  type: 'lib',
  typescript: true,
  stylistic: {
    braceStyle: '1tbs',
    quotes: 'single',
    semi: true,
  },
});

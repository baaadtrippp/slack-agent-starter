import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/coverage/**', '**/dist/**', '**/*.mjs'],
  },
  ...tseslint.configs.recommended,
);

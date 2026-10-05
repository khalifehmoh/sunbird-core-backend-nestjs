// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      "prettier/prettier": ["error", { endOfLine: "auto" }],
    },
  },
  {
    // Medplum treats a request without a delegated identity as the service
    // client itself, which is a Project Admin. Opening a client anywhere but
    // MedplumService would bypass the tenant and branch boundary.
    files: ['src/**/*.ts'],
    ignores: ['src/fhir/medplum.service.ts', '**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@medplum/core',
              allowTypeImports: true,
              message:
                'Obtain a Medplum client from MedplumService.getClient(actor) so every call is made on behalf of a user.',
            },
          ],
        },
      ],
    },
  },
);

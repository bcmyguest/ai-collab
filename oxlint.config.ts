import cloudflare from '@cloudflare/oxlint-config';
import { defineConfig } from 'oxlint';

// Passing baseline: rules below fail on the current tree. Each stays off
// until a later change fixes the findings or decides the rule does not fit.
export default defineConfig({
  extends: [cloudflare],
  env: cloudflare.env,
  // lib/vendor holds generated bundles (tools/vendor-mcp-sdk.mjs).
  ignorePatterns: [...cloudflare.ignorePatterns, 'lib/vendor/**'],
  rules: {
    // Existing code uses instanceof.
    '@nkzw/no-instanceof': 'off',
    // web/app/tasks.jsx calls useEffect without a dependency array.
    '@nkzw/require-use-effect-arguments': 'off',
    // Declarations use T[] rather than Array<T>.
    '@typescript-eslint/array-type': 'off',
    // await is applied to values that are not thenable.
    '@typescript-eslint/await-thenable': 'off',
    // Promise-returning callbacks are passed where void is expected.
    '@typescript-eslint/no-misused-promises': 'off',
    // Strings are spread into arrays.
    '@typescript-eslint/no-misused-spread': 'off',
    // lib/builder-code.cjs loads modules with require.
    '@typescript-eslint/no-require-imports': 'off',
    // sort() is called without a compare function.
    '@typescript-eslint/require-array-sort-compare': 'off',
    // Existing single-line if, for, and while bodies omit braces.
    curly: 'off',
    // Existing comparisons use ==.
    eqeqeq: 'off',
    // Site modules use inline type specifiers.
    'import/consistent-type-specifier-style': 'off',
    // UI components and tests import namespaces.
    'import-x/no-namespace': 'off',
    // CLI, runner, demo, and site scripts log with console.
    'no-console': 'off',
    // Patterns intentionally match control characters.
    'no-control-regex': 'off',
    // Empty blocks have no comment, which this rule rejects.
    'no-empty': 'off',
    // Promise executors return a value instead of calling resolve or reject.
    'no-promise-executor-return': 'off',
    // web/app/notify.jsx refers to reg outside the callback that declares it.
    'no-undef': 'off',
    // A ternary in lib/codex-compact.mjs is a statement that resolves or rejects.
    'no-unused-expressions': 'off',
    // Unused locals do not use a leading underscore.
    'no-unused-vars': 'off',
    // Some assignments are unused on the paths this rule sees.
    'no-useless-assignment': 'off',
    // lib/config.mjs escapes slashes that this rule treats as unnecessary.
    'no-useless-escape': 'off',
    // Some bindings are never reassigned.
    'prefer-const': 'off',
    // Rethrown errors do not attach the caught error as cause.
    'preserve-caught-error': 'off',
    // Arrays are filtered and then mapped in a second pass.
    'quality/no-array-filter-map': 'off',
    // Objects omit a property with a conditional empty spread.
    'quality/no-conditional-empty-object-spread': 'off',
    // runner/types.d.ts types dictionary values as unknown.
    'quality/no-unsafe-dictionary-type': 'off',
    // A test fixture button has no explicit type.
    'react/button-has-type': 'off',
    // Effects omit a dependency this rule wants listed.
    'react/exhaustive-deps': 'off',
    // Components read refs during render.
    'react/refs': 'off',
    // A test helper named use is not a React hook.
    'react/rules-of-hooks': 'off',
    // Effects call setState while setting up.
    'react/set-state-in-effect': 'off',
    // web/app/activity.jsx creates a component during render.
    'react/static-components': 'off',
    // The fake Claude generator in tests does not yield.
    'require-yield': 'off',
    // Floating promises are left unawaited.
    'typescript/no-floating-promises': 'off',
    // Site TypeScript passes an error-typed value where a string or URL is expected.
    'typescript/no-unsafe-argument': 'off',
    // There is no tsconfig, so the checker types these assigned values as error.
    'typescript/no-unsafe-assignment': 'off',
    // There is no tsconfig, so the checker types these calls as error.
    'typescript/no-unsafe-call': 'off',
    // There is no tsconfig, so the checker types these member reads as error.
    'typescript/no-unsafe-member-access': 'off',
    // There is no tsconfig, so the checker types these return values as error.
    'typescript/no-unsafe-return': 'off',
    // Assertions narrow an error-typed value to Error.
    'typescript/no-unsafe-type-assertion': 'off',
    // A test passes a method without its receiver.
    'typescript/unbound-method': 'off',
    // Rejection callbacks do not annotate the reason as unknown.
    'typescript/use-unknown-in-catch-callback-variable': 'off',
    // Catch bindings are named err and similar, not error.
    'unicorn/catch-error-name': 'off',
    // Nested helpers that close over nothing stay inside their callers.
    'unicorn/consistent-function-scoping': 'off',
    // A few strings use hexadecimal escapes.
    'unicorn/no-hex-escape': 'off',
    // Spreads copy arrays that are already lists.
    'unicorn/no-useless-spread': 'off',
    // Long numeric literals are not grouped with underscores.
    'unicorn/numeric-separators-style': 'off',
    // Scripts build a directory path from import.meta.url.
    'unicorn/prefer-import-meta-properties': 'off',
    // lib/mission-cli.mjs uses the global NaN.
    'unicorn/prefer-number-properties': 'off',
    // Membership tests use array includes rather than a Set.
    'unicorn/prefer-set-has': 'off',
    // Arrays are built with more than one push.
    'unicorn/prefer-single-call': 'off',
    // Strings escape backslashes instead of using String.raw.
    'unicorn/prefer-string-raw': 'off',
    // Global replaces use String#replace.
    'unicorn/prefer-string-replace-all': 'off',
  },
});

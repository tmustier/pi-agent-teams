// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{
		ignores: [
			"node_modules/**",
			"dist/**",
			"build/**",
			"coverage/**",
			".artifacts/**",
			".research/**",
			".resume-sessions/**",
		],
	},

	eslint.configs.recommended,
	...tseslint.configs.recommended,

	{
		files: ["extensions/**/*.ts", "scripts/**/*.ts", "scripts/**/*.mts"],
		rules: {
			// ━━ Project invariants (AGENTS.md) ━━
			"@typescript-eslint/no-explicit-any": "error",
			"@typescript-eslint/no-non-null-assertion": "error",
			"@typescript-eslint/ban-ts-comment": [
				"error",
				{
					"ts-ignore": true,
					"ts-expect-error": true,
					"ts-nocheck": true,
					"ts-check": false,
				},
			],

			// Imports/types
			"@typescript-eslint/consistent-type-imports": [
				"error",
				{ prefer: "type-imports", disallowTypeAnnotations: false },
			],

			// General correctness
			eqeqeq: ["error", "always"],

			// Prefer TS-aware unused-vars
			"no-unused-vars": "off",
			"@typescript-eslint/no-unused-vars": [
				"warn",
				{
					argsIgnorePattern: "^_",
					varsIgnorePattern: "^_",
					caughtErrorsIgnorePattern: "^_",
				},
			],
		},
	},

	// Scripts/tests: console is expected
	{
		files: ["scripts/**/*.ts", "scripts/**/*.mts"],
		rules: {
			"no-console": "off",
		},
	},

	// Extension source: discourage stray console.log
	{
		files: ["extensions/**/*.ts"],
		rules: {
			"no-console": "warn",
		},
	},
);

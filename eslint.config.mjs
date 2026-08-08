import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["node_modules/**", "data/**", "specs/**"],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // The CLI and the scripts are console programs: printing is the output.
      "no-console": "off",
      // `const { dropMe, ...rest } = row` is how a field is omitted from a comparison;
      // the named sibling is the point, not an oversight.
      "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],
    },
  },
);

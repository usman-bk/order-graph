import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    server: { deps: { inline: [/graphql/, /@graphql-tools/, /@envelop/, /@whatwg-node/] } },
    include: ["test/**/*.test.ts"],
    testTimeout: 20000,
    globalSetup: ["test/global-setup.ts"],
  },
});

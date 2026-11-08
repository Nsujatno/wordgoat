import { readFileSync } from "node:fs";
import moduleConfig from "../spacetimedb/vitest.config";

export default {
  ...moduleConfig,
  plugins: [
    {
      name: "committed-dictionary-line-endings",
      enforce: "pre",
      load(id: string) {
        if (id.endsWith("/spacetimedb/wordlist.txt")) {
          const text = readFileSync(id, "utf8").replace(/\r\n/g, "\n");
          return `export default ${JSON.stringify(text)};`;
        }
      },
    },
    ...moduleConfig.plugins,
  ],
  test: {
    ...moduleConfig.test,
    globals: true,
    include: [
      "tests/rules-parity.test.ts",
      "../spacetimedb/src/tests/*.test.ts",
    ],
    maxWorkers: 2,
    testTimeout: 45000,
  },
};

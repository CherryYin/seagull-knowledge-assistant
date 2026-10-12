import { expect, test } from "@playwright/test";
import { stripModelThinking } from "../src/lib/model-output";

test("model reasoning blocks are removed from Asset-ready output", () => {
  expect(stripModelThinking("<think>private reasoning</think>\n# Asset\n\nBody")).toBe("# Asset\n\nBody");
  expect(stripModelThinking("<analysis>private reasoning</analysis>\n# Asset")).toBe("# Asset");
  expect(stripModelThinking("<think>unfinished private reasoning")).toBe("");
  expect(stripModelThinking("<thi")).toBe("");
});

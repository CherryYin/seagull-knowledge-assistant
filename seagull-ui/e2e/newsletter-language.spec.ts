import { expect, test } from "@playwright/test";
import { splitAssetContent } from "../src/lib/asset-content";
import { assessAssetDraft, renderAssetGenerationContract, type AssetGenerationRequest } from "../src/lib/asset-generation";

const request: AssetGenerationRequest = {
  assetType: "newsletter_issue",
  title: "科技简报",
  brief: "整理科技新闻。",
  question: "有哪些值得关注的变化？",
  goal: "输出中文简报。",
  audience: "技术读者",
  creationMode: "produce",
  scope: [],
  constraints: [],
  styleNotes: "",
  styleProfileId: "visual_digest",
  sourceRefs: ["news-1"],
  noteRefs: [],
  wikiRefs: [],
};

test("newsletter drafting requests Chinese titles and content without changing citation markers", () => {
  const contract = renderAssetGenerationContract(request);
  expect(contract).toContain("every item title, summaries and body in Simplified Chinese");
  expect(contract).toContain("编者按、本期精选、为何值得关注、延伸阅读、证据说明、审阅说明");
  expect(contract).toContain("[Source: news-1]");
});

test("newsletter draft checks accept Chinese and legacy English section headings", () => {
  const sections = [
    ["编者按", "Editor’s Note"],
    ["本期精选", "Featured Items"],
    ["为何值得关注", "Why It Matters"],
    ["延伸阅读", "Further Reading"],
    ["证据说明", "Evidence Notes"],
    ["审阅说明", "Review Notes"],
  ];
  for (const languageIndex of [0, 1]) {
    const content = "# 科技简报\n\n" + sections.map(headings => `## ${headings[languageIndex]}\n\n这是有明确来源的中文说明，发布前仍需核验。[Source: news-1]`).join("\n\n");
    expect(assessAssetDraft(content, request).blockingIssues).toEqual([]);
  }
});

test("Chinese editorial notes stay outside newsletter reader content", () => {
  const content = "# 科技简报\n\n## 本期精选\n\n公开正文。[Source: news-1]\n\n## 证据说明\n\n内部来源映射。[Source: news-1]\n\n## 审阅说明\n\n发布前核验。";
  const presentation = splitAssetContent(content);
  expect(presentation.readerMarkdown).toContain("公开正文。");
  expect(presentation.readerMarkdown).not.toContain("内部来源映射");
  expect(presentation.readerMarkdown).not.toContain("审阅说明");
  expect(presentation.editorialMarkdown).toContain("[Source: news-1]");
  expect(presentation.editorialMarkdown).toContain("发布前核验");
});

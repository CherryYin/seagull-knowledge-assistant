import assert from "node:assert/strict";
import test from "node:test";
import { appendObservations, articleIdentity, cleanText, extractObservations, makeReport, responseSource, statisticsResponseDiagnostic } from "./observations.mjs";

const articleUrl = "https://mp.weixin.qq.com/s?__biz=MzDemo==&mid=12345&idx=1&sn=abc123";
const observedAt = "2026-10-18T08:00:00.000Z";
const publishSource = { endpoint: "/cgi-bin/appmsgpublish", action: "list" };
const analysisSource = { endpoint: "/misc/appmsganalysis", action: "get_article_list" };

function published(rows) {
  return JSON.stringify({ base_resp: { ret: 0 }, publish_page: JSON.stringify({ publish_list: [
    { publish_info: JSON.stringify({ appmsgex: rows }) },
  ] }) });
}

test("only public official article identities are accepted; authentication parameters are stripped", () => {
  const target = articleIdentity(`${articleUrl}&token=private&key=private&pass_ticket=private#secret`);
  assert.equal(target.url.includes("private"), false);
  assert.equal(target.url.includes("secret"), false);
  assert.equal(target.key, articleIdentity(articleUrl.replace("sn=abc123", "sn=def456")).key);
  assert.deepEqual(articleIdentity("https://mp.weixin.qq.com/s/Ab_cd-01?token=private"), {
    key: "short:Ab_cd-01", url: "https://mp.weixin.qq.com/s/Ab_cd-01",
  });
  for (const invalid of ["https://evil.example/s/article", "http://mp.weixin.qq.com/s/article", "https://mp.weixin.qq.com.evil.example/s/article", "https://user:secret@mp.weixin.qq.com/s/article", "https://mp.weixin.qq.com/cgi-bin/home?token=secret", "https://mp.weixin.qq.com/s?mid=123&idx=1"]) {
    assert.throws(() => articleIdentity(invalid));
  }
});

test("response allowlist never persists tokens or matches publishing write actions", () => {
  assert.deepEqual(responseSource("https://mp.weixin.qq.com/cgi-bin/appmsgpublish?sub=list&token=secret"), publishSource);
  assert.deepEqual(responseSource("https://mp.weixin.qq.com/misc/appmsganalysis?action=get_article_list&token=secret"), analysisSource);
  for (const invalid of ["https://mp.weixin.qq.com/cgi-bin/appmsgpublish?sub=publish", "https://mp.weixin.qq.com/cgi-bin/appmsgpublish?sub=delete", "https://mp.weixin.qq.com/misc/appmsganalysis?action=other", "https://evil.example/cgi-bin/appmsgpublish?sub=list", "not-a-url"]) {
    assert.equal(responseSource(invalid), null);
  }
});

test("nested publish list keeps only the exact target and allowlisted raw counters", () => {
  const body = published([
    { title: "其他文章", link: articleUrl.replace("mid=12345", "mid=67890"), read_num: 888 },
    { title: "目标文章", link: `${articleUrl}&token=secret`, read_num: "12", like_num: 0, share_num: null, read_uv: "unknown", secret: "secret", token: "secret", content: "private body" },
  ]);
  const observations = extractObservations(body, publishSource, articleUrl, observedAt);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].title, "目标文章");
  assert.equal(observations[0].metrics.read_num, 12);
  assert.equal(observations[0].metrics.like_num, 0);
  assert.equal(observations[0].metrics.share_num, null);
  assert.equal(observations[0].metrics.read_uv, null);
  assert.equal(observations[0].statistical_period, null);
  const report = makeReport("自己的号", articleUrl, observations);
  assert.equal(report.verification, "pending_manual_comparison");
  assert.equal(report.account_identity_verified, false);
  assert.doesNotMatch(JSON.stringify(report), /secret|token|private body|其他文章|888/);
});

test("analysis rows remain separate and counts are not renamed or summed", () => {
  const body = JSON.stringify({ appmsg_list: [
    { url: articleUrl, title: "目标文章", read_num: 12, like_num: 3, old_like_num: 4 },
    { url: articleUrl, title: "目标文章", read_num: 15, like_num: 5, old_like_num: 6 },
  ] });
  const observations = extractObservations(body, analysisSource, articleUrl, observedAt);
  assert.equal(observations.length, 2);
  assert.equal(observations[0].metrics.read_num, 12);
  assert.equal(observations[1].metrics.read_num, 15);
  assert.equal(observations[1].metrics.like_num, 5);
  assert.equal(observations[1].metrics.old_like_num, 6);
  assert.equal(observations[1].metric_units, "unverified");
});

test("missing, approximate, negative, boolean and unsafe counts stay unknown", () => {
  const observations = extractObservations(published([{ link: articleUrl, read_num: "10万+", read_uv: true, like_num: -1, share_num: 1.5, comment_num: Number.MAX_SAFE_INTEGER + 1 }]), publishSource, articleUrl, observedAt);
  assert.equal(observations.length, 1);
  assert.ok(Object.values(observations[0].metrics).every(value => value === null));
});

test("short and long URLs are not linked by title, nor are separate article indexes", () => {
  const body = published([
    { title: "同一个标题", link: "https://mp.weixin.qq.com/s/short", read_num: 10 },
    { title: "同一个标题", link: articleUrl.replace("idx=1", "idx=2"), read_num: 20 },
    { title: "同一个标题", link: "https://mp.weixin.qq.com.evil.example/s/article", read_num: 30 },
  ]);
  assert.deepEqual(extractObservations(body, publishSource, articleUrl, observedAt), []);
});

test("malformed, oversized, unexpected, empty and permission responses cannot become zero readership", () => {
  assert.deepEqual(extractObservations("{}", publishSource, articleUrl, observedAt), []);
  assert.deepEqual(extractObservations(JSON.stringify({ base_resp: { ret: 48001 }, appmsg_list: [{ url: articleUrl, read_num: 1 }] }), analysisSource, articleUrl, observedAt), []);
  assert.deepEqual(extractObservations("{}", { endpoint: "/unknown", action: "list" }, articleUrl, observedAt), []);
  assert.throws(() => extractObservations("not json", publishSource, articleUrl, observedAt));
  assert.throws(() => extractObservations(" ".repeat(2 * 1024 * 1024 + 1), publishSource, articleUrl, observedAt));
  assert.throws(() => extractObservations(published(Array.from({ length: 101 }, () => ({ link: articleUrl }))), publishSource, articleUrl, observedAt));
  assert.throws(() => makeReport("我的号", articleUrl, []));
});

test("console titles cannot carry terminal escapes or unbounded text", () => {
  assert.equal(cleanText("\u001b\u0007标题\n\u202e"), "标题");
  assert.equal(cleanText("长".repeat(1000)).length, 200);
});

test("matched article with no flat metrics reports missing fields instead of claiming statistics success", () => {
  const [observation] = extractObservations(published([{ link: articleUrl, title: "已匹配文章", appmsgid: 12345 }]), publishSource, articleUrl, observedAt);
  assert.equal(observation.capture_status, "article_matched_no_supported_metrics");
  assert.equal(observation.diagnostics.metric_fields.read_num, "missing");
  assert.ok(Object.values(observation.metrics).every(value => value === null));
  assert.ok(observation.diagnostics.article_fields.some(field => field.path === "appmsgid" && field.type === "number"));
});

test("diagnostics locate nested fields without copying nested values or guessing their statistics scope", () => {
  const [observation] = extractObservations(published([{
    link: articleUrl,
    stat_info: JSON.stringify({ read_num: 654321, like_num: 8, token: "private-token", nested: { share_num: 2 } }),
    appmsg_read_num: 654321,
    auth_key: "private-auth-key",
    comments: [{ read_num: 987654 }],
    "invalid\nfield": "private-value",
  }]), publishSource, articleUrl, observedAt);
  assert.equal(observation.metrics.read_num, null);
  assert.equal(observation.capture_status, "article_matched_no_supported_metrics");
  assert.ok(observation.diagnostics.article_fields.some(field => field.path === "stat_info.read_num" && field.type === "number"));
  assert.ok(observation.diagnostics.article_fields.some(field => field.path === "stat_info.nested.share_num"));
  assert.ok(observation.diagnostics.article_fields.some(field => field.path === "appmsg_read_num"));
  const diagnostic = JSON.stringify(observation.diagnostics);
  assert.doesNotMatch(diagnostic, /654321|987654|private|token|auth_key|invalid/);
  assert.doesNotMatch(diagnostic, /comments\./);
});

test("sibling publication counter structures are visible only as schema, never joined to the article", () => {
  const body = JSON.stringify({ publish_page: { publish_list: [{ publish_info: {
    appmsgex: [{ link: articleUrl, title: "目标文章" }],
    appmsgstat: [{ read_num: 999999, token: "private-token" }],
  } }] } });
  const [observation] = extractObservations(body, publishSource, articleUrl, observedAt);
  assert.equal(observation.metrics.read_num, null);
  assert.ok(observation.diagnostics.publication_fields.some(field => field.path === "appmsgstat" && field.type === "array"));
  assert.doesNotMatch(JSON.stringify(observation.diagnostics), /999999|private-token/);
});

test("diagnostics distinguish absent, null or invalid values, and explicit zero", () => {
  const [observation] = extractObservations(published([{ link: articleUrl, read_num: null, read_uv: "10万+", like_num: 0 }]), publishSource, articleUrl, observedAt);
  assert.equal(observation.capture_status, "metrics_observed");
  assert.equal(observation.diagnostics.metric_fields.read_num, "unsupported_or_null");
  assert.equal(observation.diagnostics.metric_fields.read_uv, "unsupported_or_null");
  assert.equal(observation.diagnostics.metric_fields.share_num, "missing");
  assert.equal(observation.diagnostics.metric_fields.like_num, "parsed");
  assert.equal(observation.metrics.like_num, 0);
});

test("structure diagnostics have bounded depth and output size", () => {
  const row = { link: articleUrl, stats: { level: { next: { read_num: 123456 } } } };
  for (let index = 0; index < 100; index += 1) row[`field_${index}`] = index;
  const [observation] = extractObservations(published([row]), publishSource, articleUrl, observedAt);
  assert.ok(observation.diagnostics.article_fields.length <= 40);
  assert.doesNotMatch(JSON.stringify(observation.diagnostics), /stats\.level\.next\.read_num|123456/);
});

test("identical refreshes are deduplicated but later different statistics can still enter a full buffer", () => {
  const body = published([{ link: articleUrl }]);
  const original = extractObservations(body, publishSource, articleUrl, observedAt);
  const repeated = extractObservations(body, publishSource, articleUrl, "2026-10-18T09:00:00Z");
  assert.equal(appendObservations(original, repeated).added, 0);
  let observations = [];
  for (let count = 0; count < 25; count += 1) {
    const incoming = extractObservations(published([{ link: articleUrl, read_num: count }]), publishSource, articleUrl, observedAt);
    observations = appendObservations(observations, incoming).observations;
  }
  assert.equal(observations.length, 20);
  assert.equal(observations[0].metrics.read_num, 5);
  assert.equal(observations[19].metrics.read_num, 24);
});

function publishedGroups(groups) {
  return JSON.stringify({ base_resp: { ret: 0 }, publish_page: JSON.stringify({ publish_list: groups.map(group => ({ publish_info: JSON.stringify(group) })) }) });
}

test("appmsg_info is parsed independently of appmsgex when the article URL matches", () => {
  const body = publishedGroups([{
    appmsgex: [{ link: articleUrl, title: "目标文章", appmsgid: 12345, itemidx: 1 }],
    appmsg_info: [
      { url: articleUrl.replace("idx=1", "idx=2"), read_num: 9999 },
      { content_url: `${articleUrl}&token=private`, title: "目标文章", read_num: "42", like_num: 0, share_num: 3 },
    ],
  }]);
  const observations = extractObservations(body, publishSource, articleUrl, observedAt);
  assert.equal(observations.length, 2);
  assert.equal(observations[0].capture_status, "article_matched_no_supported_metrics");
  assert.equal(observations[1].capture_status, "metrics_observed");
  assert.equal(observations[1].metrics.read_num, 42);
  assert.equal(observations[1].metrics.like_num, 0);
  assert.equal(observations[1].diagnostics.row_source, "appmsg_info");
  assert.equal(observations[1].diagnostics.article_match, "article_url");
  assert.equal(observations[1].statistical_period, null);
  assert.doesNotMatch(JSON.stringify(makeReport("自己的账号", articleUrl, observations)), /private|token|9999/);
});

test("URL-less counters need an exact message and item pair within the same publication", () => {
  const body = publishedGroups([{
    appmsgex: [{ link: articleUrl, title: "目标文章", appmsgid: 12345, itemidx: 1 }],
    appmsg_info: [
      { appmsgid: 12345, itemidx: 2, read_num: 8888 },
      { appmsgid: "12345", itemidx: "1", read_num: 42 },
    ],
  }]);
  const observations = extractObservations(body, publishSource, articleUrl, observedAt);
  assert.equal(observations.length, 2);
  assert.equal(observations[1].metrics.read_num, 42);
  assert.equal(observations[1].title, "目标文章");
  assert.equal(observations[1].diagnostics.article_match, "same_publication_message_item");
  assert.equal(observations[1].article_url, articleIdentity(articleUrl).url);
});

test("short and long article links can bridge only through a verified local message/item pair", () => {
  const shortUrl = "https://mp.weixin.qq.com/s/my-short-link";
  const body = publishedGroups([{
    appmsgex: [{ link: shortUrl, appmsgid: 12345, itemidx: 1 }],
    appmsg_info: [{ content_url: articleUrl, appmsgid: 12345, itemidx: 1, read_num: 42 }],
  }]);
  const observations = extractObservations(body, publishSource, shortUrl, observedAt);
  assert.equal(observations.length, 2);
  assert.equal(observations[1].metrics.read_num, 42);
  assert.equal(observations[1].article_url, shortUrl);
  assert.equal(observations[1].diagnostics.article_match, "same_publication_message_item");
});

test("message-only, item-only, title and array position are never article matches", () => {
  const body = publishedGroups([{
    appmsgex: [{ link: articleUrl, title: "同一个标题", appmsgid: 12345, itemidx: 1 }],
    appmsg_info: [
      { appmsgid: 12345, title: "同一个标题", read_num: 1 },
      { itemidx: 1, title: "同一个标题", read_num: 2 },
      { title: "同一个标题", read_num: 3 },
      { appmsgid: 12345, itemidx: 0, read_num: 4 },
    ],
  }]);
  const observations = extractObservations(body, publishSource, articleUrl, observedAt);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].metrics.read_num, null);
  assert.ok(observations[0].diagnostics.publication_article_info_fields.some(field => field.path === "appmsg_info[].read_num" && field.type === "number"));
});

test("matching cannot cross publication batches or ambiguous message/item pairs", () => {
  const metadata = { link: articleUrl, appmsgid: 12345, itemidx: 1 };
  const differentBatch = publishedGroups([
    { appmsgex: [metadata], appmsg_info: [] },
    { appmsgex: [], appmsg_info: [{ appmsgid: 12345, itemidx: 1, read_num: 9999 }] },
  ]);
  assert.equal(extractObservations(differentBatch, publishSource, articleUrl, observedAt).length, 1);
  const ambiguous = publishedGroups([{
    appmsgex: [metadata, { ...metadata, link: articleUrl.replace("mid=12345", "mid=99999") }],
    appmsg_info: [{ appmsgid: 12345, itemidx: 1, read_num: 9999 }],
  }]);
  assert.equal(extractObservations(ambiguous, publishSource, articleUrl, observedAt).length, 1);
});

test("explicit conflicting or untrusted URLs cannot be overridden by message/item IDs", () => {
  const shortUrl = "https://mp.weixin.qq.com/s/my-short-link";
  const body = publishedGroups([{
    appmsgex: [{ link: shortUrl, appmsgid: 12345, itemidx: 1 }],
    appmsg_info: [
      { link: "https://mp.weixin.qq.com/s/someone-else", appmsgid: 12345, itemidx: 1, read_num: 1 },
      { link: articleUrl.replace("idx=1", "idx=2"), appmsgid: 12345, itemidx: 1, read_num: 2 },
      { link: "https://evil.example/s/article", appmsgid: 12345, itemidx: 1, read_num: 3 },
      { link: shortUrl, content_url: "https://mp.weixin.qq.com/s/someone-else", appmsgid: 12345, itemidx: 1, read_num: 4 },
    ],
  }]);
  assert.equal(extractObservations(body, publishSource, shortUrl, observedAt).length, 1);
});

test("the content_url alias also works in the existing analysis article-list parser", () => {
  const body = JSON.stringify({ appmsg_list: [{ content_url: articleUrl, read_num: 42 }] });
  const [observation] = extractObservations(body, analysisSource, articleUrl, observedAt);
  assert.equal(observation.metrics.read_num, 42);
  assert.equal(observation.diagnostics.row_source, "appmsg_list");
});

test("analytics response discovery stores only route and bounded schema, never field or credential values", () => {
  const body = JSON.stringify({ list: [{ read_num: 987654, appmsgid: 12345, token: "private-token", cookie: "private-cookie" }], stat_info: { share_num: 54321 } });
  const diagnostic = statisticsResponseDiagnostic(body, "https://mp.weixin.qq.com/misc/appmsganalysis?action=get_unrecognized_stats&token=private&begin_date=private");
  assert.equal(diagnostic.status, "schema_only_not_article_matched");
  assert.equal(diagnostic.action, "get_unrecognized_stats");
  assert.ok(diagnostic.fields.some(field => field.path === "list[].read_num" && field.type === "number"));
  assert.ok(diagnostic.fields.some(field => field.path === "stat_info.share_num"));
  assert.doesNotMatch(JSON.stringify(diagnostic), /987654|12345|54321|private|token|cookie|begin_date/);
  assert.equal(statisticsResponseDiagnostic(body, "https://evil.example/misc/appmsganalysis?action=get_unrecognized_stats"), null);
  assert.equal(statisticsResponseDiagnostic(body, "https://mp.weixin.qq.com/cgi-bin/login"), null);
  assert.equal(statisticsResponseDiagnostic(body, "https://user:private@mp.weixin.qq.com/misc/appmsganalysis"), null);
});

test("analytics discovery does not grant statistics parsing permission or treat a schema as article data", () => {
  const url = "https://mp.weixin.qq.com/misc/appmsganalysis?action=get_other_stats";
  const body = JSON.stringify({ list: [{ read_num: 42 }] });
  assert.equal(responseSource(url), null);
  assert.equal(statisticsResponseDiagnostic(body, url).status, "schema_only_not_article_matched");
  assert.equal(statisticsResponseDiagnostic("<html>login required</html>", url).status, "not_supported_json");
  assert.equal(statisticsResponseDiagnostic(" ".repeat(2 * 1024 * 1024 + 1), url).status, "body_unavailable_or_oversized");
  assert.equal(statisticsResponseDiagnostic(body, `${url}&action=ignored`).action, "get_other_stats");
  assert.equal(statisticsResponseDiagnostic(body, "https://mp.weixin.qq.com/misc/appmsganalysis?action=private_token").action, "unspecified_or_redacted");
});

const origin = "https://mp.weixin.qq.com";
const maximumBodyBytes = 2 * 1024 * 1024;
const metricNames = [
  "read_num", "read_uv", "like_num", "old_like_num", "share_num", "share_uv",
  "comment_num", "collect_num", "favorite_num",
];

export function articleIdentity(value) {
  if (typeof value !== "string" || value.length > 4096) throw new Error("invalid_article");
  const article = new URL(value.replaceAll("&amp;", "&"));
  if (article.origin !== origin || article.username || article.password) {
    throw new Error("invalid_article");
  }
  const shortPath = /^\/s\/([A-Za-z0-9_-]{1,200})$/.exec(article.pathname);
  if (shortPath) return { key: `short:${shortPath[1]}`, url: `${origin}${article.pathname}` };
  if (article.pathname !== "/s") throw new Error("invalid_article");
  const account = article.searchParams.get("__biz");
  const message = article.searchParams.get("mid");
  const index = article.searchParams.get("idx");
  if (!account || !/^[A-Za-z0-9+/=]{1,200}$/.test(account) || !/^\d{1,30}$/.test(message ?? "") || !/^[1-9]\d?$/.test(index ?? "")) {
    throw new Error("invalid_article");
  }
  const safe = new URL(`${origin}/s`);
  for (const name of ["__biz", "mid", "idx", "sn"]) {
    const field = article.searchParams.get(name);
    if (field && (name !== "sn" || /^[a-fA-F0-9]{1,128}$/.test(field))) {
      safe.searchParams.set(name, field);
    }
  }
  return { key: `long:${account}:${message}:${index}`, url: safe.href };
}

export function responseSource(value) {
  try {
    const address = new URL(value);
    if (address.origin !== origin || address.username || address.password) return null;
    if (address.pathname === "/cgi-bin/appmsgpublish" && address.searchParams.get("sub") === "list") {
      return { endpoint: address.pathname, action: "list" };
    }
    if (address.pathname === "/misc/appmsganalysis" && address.searchParams.get("action") === "get_article_list") {
      return { endpoint: address.pathname, action: "get_article_list" };
    }
    return null;
  } catch {
    return null;
  }
}

function objectValue(value) {
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > maximumBodyBytes) throw new Error("oversized_payload");
    value = JSON.parse(value);
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function boundedRows(value) {
  if (!Array.isArray(value)) return [];
  if (value.length > 100) throw new Error("oversized_rows");
  return value;
}

export function cleanText(value, maximum = 200) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "").trim().slice(0, maximum) : "";
}

function countValue(value) {
  if (typeof value === "string" && /^\d{1,16}$/.test(value)) value = Number(value);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function describeFields(value, maximumDepth = 2) {
  const fields = [];
  const visit = (object, prefix, depth) => {
    if (!object || typeof object !== "object" || Array.isArray(object)) return;
    for (const [name, field] of Object.entries(object)) {
      if (fields.length >= 40) return;
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) continue;
      if (/token|secret|cookie|password|credential|ticket|session|openid|unionid|authorization|content|digest|nickname|avatar/i.test(name)) continue;
      if (/(^|_)(key|auth|sn|sign|signature|fakeid|biz)($|_)/i.test(name)) continue;
      const path = prefix ? `${prefix}.${name}` : name;
      let nested = field;
      let type = field === null ? "null" : Array.isArray(field) ? "array" : typeof field;
      if (typeof field === "string" && field.trimStart().startsWith("{") && Buffer.byteLength(field) <= 64 * 1024) {
        try {
          nested = objectValue(field);
          type = "json_object_string";
        } catch {
          nested = null;
        }
      }
      fields.push({ path, type });
      if (depth < maximumDepth) visit(nested, path, depth + 1);
    }
  };
  visit(value, "", 0);
  return fields;
}

function arrayFieldShapes(value, name) {
  const fields = [];
  const seen = new Set();
  for (const row of boundedRows(value).slice(0, 3)) {
    for (const field of describeFields(row, 1)) {
      const path = `${name}[].${field.path}`;
      const key = `${path}:${field.type}`;
      if (!seen.has(key) && fields.length < 40) {
        seen.add(key);
        fields.push({ path, type: field.type });
      }
    }
  }
  return fields;
}

function rowArticle(row) {
  const identities = new Map();
  for (const name of ["link", "url", "content_url"]) {
    if (!row[name]) continue;
    try {
      const article = articleIdentity(row[name]);
      identities.set(article.key, article);
    } catch {
      return { invalid: true };
    }
  }
  return identities.size > 1 ? { invalid: true } : { article: [...identities.values()][0] };
}

function identifier(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) value = String(value);
  return typeof value === "string" && /^\d{1,30}$/.test(value) ? value.replace(/^0+(?=\d)/, "") : null;
}

function messageItem(row) {
  const message = identifier(row.appmsgid);
  const index = identifier(row.itemidx);
  return message && message !== "0" && index !== null ? `${message}:${index}` : null;
}

function matchArticle(row, metadata, target, allowMessageItem) {
  const { article, invalid } = rowArticle(row);
  if (invalid) return null;
  if (article?.key === target.key) return { article, title: row.title, method: "article_url" };
  if (!allowMessageItem) return null;
  const pair = messageItem(row);
  if (!pair) return null;
  const peers = metadata.filter(peer => peer && typeof peer === "object" && messageItem(peer) === pair);
  if (peers.length !== 1) return null;
  const anchor = rowArticle(peers[0]);
  if (anchor.invalid || anchor.article?.key !== target.key) return null;
  if (article) {
    if (article.key.split(":")[0] === target.key.split(":")[0]) return null;
    const longArticle = article.key.startsWith("long:") ? article : anchor.article;
    const parameters = new URL(longArticle.url).searchParams;
    if (`${identifier(parameters.get("mid"))}:${identifier(parameters.get("idx"))}` !== pair) return null;
  }
  return { article: anchor.article, title: row.title || peers[0].title, method: "same_publication_message_item" };
}

export function statisticsResponseDiagnostic(body, value) {
  let address;
  try {
    address = new URL(value);
  } catch {
    return null;
  }
  if (address.origin !== origin || address.username || address.password || address.pathname !== "/misc/appmsganalysis") return null;
  const action = address.searchParams.get("action");
  const safeAction = /^[a-z][a-z0-9_]{0,47}$/.test(action ?? "") && !/token|secret|cookie|password|ticket|session/.test(action) ? action : "unspecified_or_redacted";
  const diagnostic = { endpoint: address.pathname, action: safeAction, status: "schema_only_not_article_matched", fields: [] };
  if (typeof body !== "string" || Buffer.byteLength(body) > maximumBodyBytes) return { ...diagnostic, status: "body_unavailable_or_oversized" };
  try {
    const payload = objectValue(body);
    diagnostic.fields = describeFields(payload);
    for (const [name, field] of Object.entries(payload)) {
      if (!/^[a-z_]{1,48}$/.test(name) || !Array.isArray(field) || /token|secret|cookie|password|credential|ticket|session|openid|unionid|content|nickname/.test(name)) continue;
      diagnostic.fields.push(...arrayFieldShapes(field, name).slice(0, 80 - diagnostic.fields.length));
      if (diagnostic.fields.length >= 80) break;
    }
    return diagnostic;
  } catch {
    return { ...diagnostic, status: "not_supported_json" };
  }
}

export function appendObservations(current, incoming) {
  const signature = observation => {
    const { observed_at: observedAt, ...data } = observation;
    return JSON.stringify(data);
  };
  const seen = new Set(current.map(signature));
  const combined = [...current];
  let added = 0;
  for (const observation of incoming) {
    const key = signature(observation);
    if (seen.has(key)) continue;
    seen.add(key);
    combined.push(observation);
    added += 1;
  }
  return { observations: combined.slice(-20), added };
}

export function extractObservations(body, source, targetUrl, observedAt) {
  if (typeof body !== "string" || Buffer.byteLength(body) > maximumBodyBytes) throw new Error("oversized_payload");
  const target = articleIdentity(targetUrl);
  const payload = objectValue(body);
  if (payload.base_resp?.ret !== undefined && payload.base_resp.ret !== 0) return [];
  let rows;
  let page = {};
  if (source.endpoint === "/cgi-bin/appmsgpublish" && source.action === "list") {
    page = objectValue(payload.publish_page);
    rows = boundedRows(page.publish_list).flatMap(published => {
      const publication = objectValue(published.publish_info);
      const metadata = boundedRows(publication.appmsgex);
      return [
        ...metadata.map(row => ({ row, publication, metadata, rowSource: "appmsgex" })),
        ...boundedRows(publication.appmsg_info).map(row => ({ row, publication, metadata, rowSource: "appmsg_info" })),
      ];
    });
  } else if (source.endpoint === "/misc/appmsganalysis" && source.action === "get_article_list") {
    rows = boundedRows(payload.appmsg_list).map(row => ({ row, publication: {}, metadata: [], rowSource: "appmsg_list" }));
  } else {
    return [];
  }
  if (rows.length > 800) throw new Error("oversized_rows");
  const observations = [];
  for (const { row, publication, metadata, rowSource } of rows) {
    if (!row || typeof row !== "object") continue;
    const match = matchArticle(row, metadata, target, rowSource === "appmsg_info");
    if (!match) continue;
    const metrics = Object.fromEntries(metricNames.map(name => [name, countValue(row[name])]));
    observations.push({
      source: "wechat_backend_browser",
      source_endpoint: source.endpoint,
      source_action: source.action,
      observed_at: observedAt,
      article_url: match.article.url,
      title: cleanText(match.title),
      metrics,
      capture_status: Object.values(metrics).some(value => value !== null) ? "metrics_observed" : "article_matched_no_supported_metrics",
      diagnostics: {
        row_source: rowSource,
        article_match: match.method,
        metric_fields: Object.fromEntries(metricNames.map(name => [name, !Object.hasOwn(row, name) ? "missing" : metrics[name] === null ? "unsupported_or_null" : "parsed"])),
        article_fields: describeFields(row),
        publication_fields: describeFields(publication),
        publication_article_info_fields: arrayFieldShapes(publication.appmsg_info, "appmsg_info"),
        page_fields: describeFields(page, 0),
        response_fields: describeFields(payload, 0),
      },
      statistical_period: null,
      metric_units: "unverified",
    });
  }
  return observations.slice(0, 20);
}

export function makeReport(accountLabel, targetUrl, observations, requestDiagnostics = []) {
  if (observations.length === 0 || observations.length > 20) throw new Error("invalid_observations");
  return {
    schema: "seagull.wechat-browser-check.v1",
    source: "wechat_backend_browser",
    verification: "pending_manual_comparison",
    account_label: cleanText(accountLabel, 80),
    account_identity_verified: false,
    article_url: articleIdentity(targetUrl).url,
    observations,
    request_diagnostics: requestDiagnostics.slice(-10),
  };
}

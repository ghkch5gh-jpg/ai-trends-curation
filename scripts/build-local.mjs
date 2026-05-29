#!/usr/bin/env node
// 로컬 생성기 — 수집 → claude -p (정액제) → 회차 .md 작성 → index.md 갱신.
// GitHub Actions(유료 API)가 아니라 PC에서 Claude Code 구독으로 돈다.
//   DRY_RUN=1  : 수집 + 프롬프트만 출력하고 claude 호출 안 함
//   CLAUDE_MODEL=opus : 모델 변경 (기본 sonnet)
import { readFile, writeFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";

const DRY_RUN = process.env.DRY_RUN === "1";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "sonnet";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";

const sources = JSON.parse(await readFile("scripts/sources.json", "utf8"));

const now = new Date();
const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
const sinceIso = yesterday.toISOString().slice(0, 10);
const sinceTs = Math.floor(yesterday.getTime() / 1000);

const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
const dateStr = kst.toISOString().slice(0, 10);
const dayOfWeek = ["일", "월", "화", "수", "목", "금", "토"][kst.getUTCDay()];
const slug = `${dateStr}_${dayOfWeek}`;

// 오늘 회차가 이미 있으면 멱등 종료 (스케줄러 중복 실행 방지)
const existing = (await readdir(".")).filter((f) => f === `${slug}.md`);
if (existing.length && process.env.FORCE !== "1") {
  console.log(`${slug}.md 이미 존재 — 종료 (FORCE=1로 강제 재생성)`);
  process.exit(0);
}

async function fetchWithRetry(url, { headers = {}, attempts = 3, baseDelayMs = 800 } = {}) {
  const mergedHeaders = {
    "User-Agent": "Mozilla/5.0 (compatible; AITrendsBot/1.0; +https://www.dangsun.kr)",
    "Accept-Language": "en-US,en;q=0.9,ko;q=0.8",
    ...headers,
  };
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers: mergedHeaders });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      lastErr = err;
      if (/HTTP (401|403|404)/.test(err.message)) throw err;
      if (i < attempts - 1) {
        const delay = baseDelayMs * Math.pow(2, i);
        console.warn(`fetch 재시도 ${i + 1} (${delay}ms): ${url} — ${err.message}`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

function stripHtml(html, baseUrl) {
  const seen = new Set();
  let s = html.replace(
    /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_, href, inner) => {
      let url;
      try {
        url = new URL(href, baseUrl).href;
      } catch {
        url = href;
      }
      const text = inner.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      if (!text) return " ";
      if (/^(mailto:|tel:|javascript:|#)/i.test(url)) return ` ${text} `;
      if (text.length < 3) return ` ${text} `;
      const key = `${text}::${url}`;
      if (seen.has(key)) return ` ${text} `;
      seen.add(key);
      return ` ${text} (${url}) `;
    }
  );
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function jsonExtractFromGithubSearch(json) {
  const items = json.items || [];
  return items
    .map((r) => {
      const star = r.stargazers_count || 0;
      const pushed = (r.pushed_at || "").slice(0, 10);
      const desc = (r.description || "").replace(/\s+/g, " ").trim();
      const lang = r.language || "";
      const topics = (r.topics || []).slice(0, 5).join(",");
      return `- ${r.full_name} (${r.html_url}) — ${star}⭐ · pushed ${pushed} · ${lang} · topics: ${topics} · ${desc}`;
    })
    .join("\n");
}

function jsonExtractFromHN(json) {
  const hits = json.hits || [];
  return hits
    .map((h) => {
      const url = h.url || `https://news.ycombinator.com/item?id=${h.objectID}`;
      return `- "${h.title || "(no title)"}" (${url}) — ${h.points || 0} pts · ${h.num_comments || 0} comments`;
    })
    .join("\n");
}

function jsonExtractFromReddit(json) {
  const children = json?.data?.children || [];
  return children
    .map((c) => {
      const d = c.data || {};
      const externalUrl = d.url_overridden_by_dest || d.url || "";
      const ghMatch = /github\.com\/[\w.-]+\/[\w.-]+|huggingface\.co\/[\w/.-]+|arxiv\.org/.test(
        externalUrl + " " + (d.selftext || "")
      );
      const tag = ghMatch ? "[has-code-link]" : "";
      return `- "${d.title}" (https://reddit.com${d.permalink}) — ${d.score} pts · external: ${externalUrl} ${tag}`;
    })
    .join("\n");
}

async function fetchSource(s) {
  let url = s.url
    .replaceAll("__SINCE__", sinceIso)
    .replaceAll("__SINCE_TS__", String(sinceTs));

  const headers = {};
  if (GITHUB_TOKEN && /api\.github\.com/.test(url)) {
    headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  }

  try {
    const res = await fetchWithRetry(url, { headers });
    if (s.kind === "html") {
      const html = await res.text();
      return { ...s, text: stripHtml(html, url).slice(0, 8000), ok: true };
    }
    if (s.kind === "json-search") {
      const json = await res.json();
      return { ...s, text: jsonExtractFromGithubSearch(json), ok: true };
    }
    if (s.kind === "json") {
      const json = await res.json();
      const isHN = /algolia/.test(url);
      const isReddit = /reddit\.com/.test(url);
      const text = isHN
        ? jsonExtractFromHN(json)
        : isReddit
        ? jsonExtractFromReddit(json)
        : JSON.stringify(json).slice(0, 4000);
      return { ...s, text: text.slice(0, 8000), ok: true };
    }
    return { ...s, text: "", ok: false, error: `unknown kind: ${s.kind}` };
  } catch (err) {
    console.warn(`수집 실패 ${s.name}: ${err.message}`);
    return { ...s, text: "", ok: false, error: String(err) };
  }
}

console.log(`소스 ${sources.length}개 fetch 시작 (병렬)...`);
const fetched = await Promise.all(sources.map(fetchSource));
const okSources = fetched.filter((f) => f.ok && f.text);
console.log(`성공: ${okSources.length}/${sources.length}`);

if (okSources.length === 0) {
  console.error("모든 소스 fetch 실패");
  process.exit(1);
}

// 직전 2회차 URL/제목 (중복 회피용)
const allMd = (await readdir(".")).filter(
  (f) => /^\d{4}-\d{2}-\d{2}.*\.md$/.test(f) && f !== `${slug}.md`
);
const priorFiles = allMd.sort().reverse().slice(0, 2);
const priorUrls = new Set();
for (const f of priorFiles) {
  const content = await readFile(f, "utf8");
  for (const m of content.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g)) {
    priorUrls.add(m[2]);
  }
}
console.log(`이전 ${priorFiles.length}회차에서 URL ${priorUrls.size}개 추출`);

const SPEC = await readFile("CURATION_SPEC.md", "utf8");

const prompt = `**중요 사전 지시 — 이 요청은 *채팅 응답* 형식입니다. 작업 요청이 아닙니다.**
- 어떤 도구·외부 검색·파일시스템도 사용 금지. (이미 모든 자료는 아래에 제공됨)
- 파일을 만들거나 디스크에 저장하지 마세요.
- 응답은 *한 덩어리 JSON*만. 인사·"완성했습니다"·"파일 경로:" 같은 보고문 절대 금지.
- 첫 글자부터 \`{\` 로 시작.

당신은 한국 개발자를 위한 **AI·개발 트렌드 큐레이터**입니다. 오늘(${dateStr}, ${dayOfWeek}요일) 회차를 작성하세요.

# 핵심 명세 (필독)

${SPEC}

# 수집된 소스 텍스트 (오늘 ${okSources.length}개 소스에서 fetch 됨)

${okSources.map((f) => `### ${f.name} (${f.url})\n${f.text}`).join("\n\n---\n\n")}

# 이전 2회차에 다룬 URL (중복 게재 금지 — 단, 의미 있는 신규 릴리스면 "[업데이트]" 라벨로 OK)

${[...priorUrls].slice(0, 60).map((u) => `- ${u}`).join("\n") || "(없음 — 첫 회차)"}

# 출력 규칙

**첫 글자부터** 아래 JSON 스키마로만 답하세요. 서론·"분석하겠습니다" 류 절대 금지.

\`\`\`
{
  "description": "이 회차 요약 한 문장 (~100자) — frontmatter description에 들어감",
  "flow_summary": "이번 회차 흐름 2~3문단 (~300자)",
  "trending_picks": [
    {
      "name": "owner/repo 또는 도구/모델명",
      "url": "https://...",
      "meta": "GitHub Trending | XXk ⭐ | +XX 오늘 등 한 줄",
      "what": "이게 뭐 하는 건지 한 문장 (아는 것에 빗대)",
      "note": "한 줄 코멘트 — 솔직하게 (핫하지만 실속 여부 등)"
    }
  ],
  "core_picks": [
    {
      "name": "owner/repo",
      "url": "https://...",
      "meta": "★★★ | GitHub | XXk ⭐ | 마지막 갱신",
      "what": "친구가 1초 만에 이해하는 설명 (비유 포함)",
      "why": ["구체적 시나리오 1", "구체적 시나리오 2", "시나리오 3 (선택)"],
      "claude_use": "git clone 후 AI 코딩 도구에 시킬 자연어 지시 한 줄",
      "why_now": "왜 오늘 다루는지 1줄"
    }
  ],
  "sub_picks": [
    {
      "name": "owner/repo",
      "url": "https://...",
      "meta": "★★ | GitHub | XXk ⭐ | 마지막 갱신",
      "what": "한 줄 설명 (비유 포함, CS/AI 약어 풀이)",
      "claude_use": "→ \\\`git clone …\\\` · \\"자연어 지시\\""
    }
  ],
  "memo": "큰 흐름 2~3줄 + 수집 한계 + 다음 회차 힌트. 자유 단락."
}
\`\`\`

분량 (명세 §4 절대 준수): trending_picks **정확히 5개**, core_picks **3~5개**, sub_picks **5~8개**.
언어 규칙(명세 §4-1)을 셀프 체크 후 통과시켜서 작성하세요.`;

const promptBytes = Buffer.byteLength(prompt, "utf8");
console.log(`Prompt 길이: ${prompt.length}자 (${(promptBytes / 1024).toFixed(1)} KB)`);

if (DRY_RUN) {
  console.log("=== DRY RUN ===");
  console.log(prompt.slice(0, 2500));
  console.log(`...\n(전체 ${prompt.length}자)`);
  process.exit(0);
}

// === claude -p 정액제 호출 (stdin으로 프롬프트 전달, 도구 전부 비활성) ===
function callClaude(promptText) {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "text", "--allowedTools", "", "--model", CLAUDE_MODEL];
    console.log(`claude ${args.join(" ")} 호출 (stdin ${promptText.length}자)...`);
    const child = spawn("claude", args, { stdio: ["pipe", "pipe", "inherit"], shell: true });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("claude 호출 타임아웃 (5분)"));
    }, 5 * 60 * 1000);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(out) : reject(new Error(`claude exit ${code}`));
    });
    child.stdin.write(promptText);
    child.stdin.end();
  });
}

const raw = await callClaude(prompt);
const m = raw.match(/```json\s*([\s\S]*?)\s*```/) || raw.match(/\{[\s\S]*\}/);
if (!m) {
  console.error("JSON 블록 미발견. 원문 앞 600:", raw.slice(0, 600));
  process.exit(1);
}
let resultJson;
try {
  resultJson = JSON.parse(m[1] ?? m[0]);
} catch (e) {
  console.error("JSON 파싱 실패:", e.message, "\n원문 앞 600:", raw.slice(0, 600));
  process.exit(1);
}

const heroDate = dateStr.replaceAll("-", " · ");

function renderTrending(t, i) {
  return `### ${i + 1}. [${t.name}](${t.url})
${t.meta || ""}

${t.what || ""}

**코멘트:** ${t.note || ""}`;
}

function renderCore(c) {
  const whyList = (c.why || []).map((w) => `- ${w}`).join("\n");
  return `### [${c.name}](${c.url})
${c.meta || ""}

**한 줄로:** ${c.what || ""}

**왜 의미 있냐:**
${whyList}

**AI 코딩 도구에 시키기:**
\`\`\`
git clone ${c.url}
\`\`\`
→ "${c.claude_use || ""}"

**왜 오늘:** ${c.why_now || ""}`;
}

function renderSub(s) {
  return `### [${s.name}](${s.url})
${s.meta || ""}

${s.what || ""}
${s.claude_use || ""}`;
}

const trending = (resultJson.trending_picks || []).map(renderTrending).join("\n\n");
const core = (resultJson.core_picks || []).map(renderCore).join("\n\n---\n\n");
const sub = (resultJson.sub_picks || []).map(renderSub).join("\n\n");

const md = `---
title: ${dateStr} (${dayOfWeek})
eyebrow: 큐레이션 회차
hero_title: "${heroDate} <em>(${dayOfWeek})</em>"
description: "${(resultJson.description || "").replaceAll('"', "'")}"
summary: ${(resultJson.description || "").replaceAll('"', "'")}
---

## 이번 회차 흐름

${resultJson.flow_summary || ""}

---

## 🔥 오늘 핫한 것 (도메인 무관, 그냥 화제인 거)

분위기 파악용 5개.

${trending}

---

## 코어 ★★★

${core}

---

## 서브 ★★

${sub}

---

## 메모

${resultJson.memo || ""}
`;

await writeFile(`${slug}.md`, md);
console.log(
  `${slug}.md 저장 (트렌딩 ${(resultJson.trending_picks || []).length} / 코어 ${
    (resultJson.core_picks || []).length
  } / 서브 ${(resultJson.sub_picks || []).length})`
);

// index.md 회차 목록 재생성
const files = (await readdir("."))
  .filter((f) => /^\d{4}-\d{2}-\d{2}.*\.md$/.test(f))
  .sort()
  .reverse();

async function readSummaryOf(file) {
  try {
    const raw = await readFile(file, "utf8");
    const fm = raw.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---/);
    if (!fm) return "";
    const sumMatch = fm[1].match(/^summary:\s*(.+)$/m);
    if (sumMatch) return sumMatch[1].trim();
    const descMatch = fm[1].match(/^description:\s*"?(.+?)"?$/m);
    return descMatch ? descMatch[1].trim() : "";
  } catch {
    return "";
  }
}

const entries = await Promise.all(
  files.map(async (f) => {
    const slugOnly = f.replace(".md", "");
    const summary = await readSummaryOf(f);
    const mm = slugOnly.match(/^(\d{4}-\d{2}-\d{2})_(.+)$/);
    const label = mm ? `${mm[1]} (${mm[2]})` : slugOnly;
    return summary
      ? `- [${label} — ${summary}](${slugOnly}.html)`
      : `- [${label}](${slugOnly}.html)`;
  })
);

const indexMd = `---
title: AI Trends
eyebrow: AI × DEV · DAILY
hero_title: "AI <em>Trends</em>"
description: 매일 아침, GitHub·Hacker News·arXiv·HuggingFace·Reddit에서 그날의 AI·개발 트렌드를 자동으로 모아 한국어로 정리합니다. URL 하나 복사해 AI 코딩 도구에 넣으면 바로 작업이 시작되는 자료 위주.
stats:
  - num: "매일"
    lbl: "Daily Update"
  - num: "${sources.length}"
    lbl: "Sources"
  - num: "10+"
    lbl: "Items / Day"
  - num: "${files.length}"
    lbl: "회차"
---

## 회차 목록

${entries.join("\n")}
{:.episode-list}

*매일 08:00 KST 새 회차가 자동으로 추가됩니다.*

## 각 회차에는

- 🔥 **오늘 핫한 것** 5개 — 도메인 무관, 그냥 화제인 것
- ★★★ **코어** 3~5개 — 받아서 바로 써먹을 진짜배기
- ★★ **서브** 5~8개 — 알아두면 좋은 인접 기술
- *흐름 메모* — 큰 흐름 2~3줄

## 이 큐레이션은

매일 아침, **GitHub Trending · Hacker News · arXiv · HuggingFace · Reddit** 을 자동으로 돌며
그날 새로 나온 것 중 실제로 써먹을 수 있는 것만 골라 정리합니다.
Claude Code 구독으로 로컬에서 생성하므로 별도 API 비용이 없습니다.

기준은 단순합니다 — **"이 URL을 AI 코딩 도구에 붙여 넣으면 바로 작업이 시작되는가?"**
`;

await writeFile("index.md", indexMd);
console.log(`index.md 갱신 (${files.length}회차)`);

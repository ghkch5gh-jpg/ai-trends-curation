#!/usr/bin/env node
// 로컬 생성기 — 수집 → claude -p (정액제) → 회차 .md(시맨틱 HTML) → index.md.
// 레이아웃·말투는 baeksang.dev/daily 식: 주제 섹션 + 항목마다 얻는 것/지금 할 일/왜 지금/점수/출처.
//   DRY_RUN=1 : 수집+프롬프트만   FORCE=1 : 오늘 회차 강제 재생성   CLAUDE_MODEL=opus
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
        await new Promise((r) => setTimeout(r, baseDelayMs * Math.pow(2, i)));
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
  return (json.items || [])
    .map((r) => {
      const topics = (r.topics || []).slice(0, 5).join(",");
      return `- ${r.full_name} (${r.html_url}) — ${r.stargazers_count || 0}⭐ · pushed ${(r.pushed_at || "").slice(0, 10)} · ${r.language || ""} · topics: ${topics} · ${(r.description || "").replace(/\s+/g, " ").trim()}`;
    })
    .join("\n");
}
function jsonExtractFromHN(json) {
  return (json.hits || [])
    .map((h) => {
      const url = h.url || `https://news.ycombinator.com/item?id=${h.objectID}`;
      return `- "${h.title || "(no title)"}" (${url}) — ${h.points || 0} pts · ${h.num_comments || 0} comments`;
    })
    .join("\n");
}
function jsonExtractFromReddit(json) {
  return (json?.data?.children || [])
    .map((c) => {
      const d = c.data || {};
      const externalUrl = d.url_overridden_by_dest || d.url || "";
      const code = /github\.com\/[\w.-]+\/[\w.-]+|huggingface\.co\/[\w/.-]+|arxiv\.org/.test(externalUrl + " " + (d.selftext || "")) ? "[has-code-link]" : "";
      return `- "${d.title}" (https://reddit.com${d.permalink}) — ${d.score} pts · external: ${externalUrl} ${code}`;
    })
    .join("\n");
}

// RSS/Atom 공통 파서 (블로그 RSS, GitHub releases.atom)
function parseFeed(xml, max = 12) {
  const clean = (s) => String(s || "").replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
  const blocks = xml.split(/<entry[\s>]|<item[\s>]/i).slice(1, max + 1);
  return blocks
    .map((b) => {
      const title = clean((b.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
      let link = (b.match(/<link[^>]*href=["']([^"']+)["']/i) || [])[1];
      if (!link) link = clean((b.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1]);
      const date = ((b.match(/<(updated|pubDate|published|dc:date)[^>]*>([\s\S]*?)<\/\1>/i) || [])[2] || "").slice(0, 10);
      if (!title) return "";
      return `- ${title} (${(link || "").trim()})${date ? ` · ${date}` : ""}`;
    })
    .filter(Boolean)
    .join("\n");
}

async function fetchSource(s) {
  try {
    // url 없이 repos 목록을 도는 종류 — 각 레포의 releases.atom
    if (s.kind === "github-releases") {
      const parts = await Promise.all(
        (s.repos || []).map(async (repo) => {
          try {
            const res = await fetchWithRetry(`https://github.com/${repo}/releases.atom`);
            const feed = parseFeed(await res.text(), 3);
            return feed ? `[${repo}]\n${feed}` : "";
          } catch {
            return "";
          }
        })
      );
      const text = parts.filter(Boolean).join("\n");
      return { ...s, text: text.slice(0, 8000), ok: !!text };
    }

    let url = s.url.replaceAll("__SINCE__", sinceIso).replaceAll("__SINCE_TS__", String(sinceTs));
    const headers = {};
    if (GITHUB_TOKEN && /api\.github\.com/.test(url)) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
    // Reddit는 'Bot' UA를 403 처리 — Reddit API 가이드 형식 UA로 교체
    if (/reddit\.com/.test(url)) headers["User-Agent"] = "web:dangsun-ai-trends:1.0 (by /u/ghkch5gh-jpg)";

    const res = await fetchWithRetry(url, { headers });
    if (s.kind === "rss") return { ...s, text: parseFeed(await res.text(), 12).slice(0, 8000), ok: true };
    if (s.kind === "html") return { ...s, text: stripHtml(await res.text(), url).slice(0, 8000), ok: true };
    if (s.kind === "json-search") return { ...s, text: jsonExtractFromGithubSearch(await res.json()), ok: true };
    if (s.kind === "json") {
      const json = await res.json();
      const text = /algolia/.test(url) ? jsonExtractFromHN(json) : /reddit\.com/.test(url) ? jsonExtractFromReddit(json) : JSON.stringify(json).slice(0, 4000);
      return { ...s, text: text.slice(0, 8000), ok: true };
    }
    return { ...s, text: "", ok: false };
  } catch (err) {
    console.warn(`수집 실패 ${s.name}: ${err.message}`);
    return { ...s, text: "", ok: false };
  }
}

console.log(`소스 ${sources.length}개 fetch 시작...`);
const fetched = await Promise.all(sources.map(fetchSource));
const okSources = fetched.filter((f) => f.ok && f.text);
console.log(`성공: ${okSources.length}/${sources.length}`);
if (okSources.length === 0) {
  console.error("모든 소스 fetch 실패");
  process.exit(1);
}

const allMd = (await readdir(".")).filter((f) => /^\d{4}-\d{2}-\d{2}.*\.md$/.test(f) && f !== `${slug}.md`);
const priorFiles = allMd.sort().reverse().slice(0, 2);
const priorUrls = new Set();
for (const f of priorFiles) {
  for (const m of (await readFile(f, "utf8")).matchAll(/href="(https?:\/\/[^"]+)"/g)) priorUrls.add(m[1]);
}

const SPEC = await readFile("CURATION_SPEC.md", "utf8");

const prompt = `**중요 — 이 요청은 *채팅 응답* 형식입니다. 도구·검색·파일시스템 사용 금지. 응답은 한 덩어리 JSON만. 첫 글자부터 \`{\` 로 시작. 인사·보고문 금지.**

당신은 한국 개발자를 위한 **AI·개발 데일리 큐레이터**입니다. 오늘(${dateStr}, ${dayOfWeek}요일) 회차를 작성하세요.

# 명세
${SPEC}

# 말투 (이 톤을 그대로 따라하세요 — 실제 레퍼런스 2개)

[예시 A — 릴리스]
본문: "LangGraph 1.2.0이 정식 출시됐어요. 가장 큰 변화는 durable error-handler로, 호스트가 죽어도 에이전트 실행 상태를 복구할 수 있게 됐습니다."
얻는 것: "호스트가 죽어도 에이전트 상태가 날아가지 않아요. set_node_defaults()로 반복 설정을 줄일 수 있습니다."
지금 할 일: "pip install langgraph==1.2.0 으로 업그레이드하고, durable error-handler 문서를 확인해보세요."
왜 지금: "AI 에이전트가 복잡해지면서 서버 장애 시 상태 복구는 필수 기능이 되고 있어요."

[예시 B — 커뮤니티]
본문: "Hacker News에서 1,800점 이상을 받은 글에 따르면, 많은 개발자들이 AI와의 대화에 피로감을 느끼고 있습니다."
얻는 것: "AI 상호작용의 피로감을 이해하고, 더 나은 정보 탐색 방식을 고민할 수 있습니다."
지금 할 일: "AI에게 질문하기 전, 직접 검색하거나 동료에게 물어보는 것을 먼저 시도해보세요."
왜 지금: "AI가 발전할수록 오히려 인간적인 소통과 깊이 있는 정보의 가치가 재조명받고 있습니다."

→ 해요체/합니다체 섞어 간결하게. 과장·영업체 금지. '얻는 것'은 독자 이득, '지금 할 일'은 즉시 실행 가능한 구체 행동(가능하면 명령어), '왜 지금'은 타이밍·의미.

**누구나 이해하게 (가장 중요):** 비전공자·입문자도 읽게 쓰세요. 모든 기술용어·약어는 처음 나올 때 괄호로 쉽게 풀이(예: "MoE(여러 전문가 모델 중 일부만 골라 쓰는 구조)", "추론(AI가 답을 만들어내는 과정)"). 아는 것에 빗대기(엑셀·USB·메모장·번역기 등). 영어 원문 제목은 한국어 제목으로 바꾸고 필요하면 원어 병기. 어려우면 한 번 더 풀어 설명.

# 수집된 소스 (${okSources.length}개)
${okSources.map((f) => `### ${f.name}\n${f.text}`).join("\n\n---\n\n")}

# 직전 회차 URL (중복 금지)
${[...priorUrls].slice(0, 50).map((u) => `- ${u}`).join("\n") || "(없음)"}

# 출력 스키마 (이대로만)
\`\`\`
{
  "edition_note": "오늘 호 한 줄 소개 (~90자) — 무엇이 화제였는지",
  "intro": "맨 처음 흐름 요약 — 반드시 '안녕하세요!' 로 시작. 오늘 AI·개발 소식의 큰 그림을 비전공자도 한 번에 알아먹게 아주 쉽고 재미있게 4~6문장으로. 어려운 말은 괄호로 풀고, 위트 한 스푼.",
  "outro": "맺음말/감상 — 오늘 흐름을 한 발 물러나 본 소회. 큐레이터의 솔직한 감상·전망 2~3문장. 따뜻하게 마무리.",
  "items": [
    {
      "section": "headline | release | repo | gov | paper | tool | community",
      "title": "한국어 제목, 간결하고 구체적으로",
      "url": "원본 링크 (수집된 것 중에서만)",
      "source": "출처태그: hn | github | huggingface | arxiv | reddit | blog",
      "score": 1-10 정수 (실무 임팩트),
      "body": "본문 정확히 3~4문장 (분량 통일 — 너무 짧거나 길지 않게) — 무슨 일이고 핵심이 뭔지",
      "points": ["핵심 요점 1", "2", "3"],
      "gain": "얻는 것 — 독자가 뭘 얻는지 1~2문장",
      "todo": "지금 할 일 — 즉시 행동/명령 (예: pip install …, git clone …)",
      "why_now": "왜 지금 — 타이밍·의미 1~2문장"
    }
  ]
}
\`\`\`

분량·분류 규칙:
- section "headline": **가장 중요한 4~6개** (출처 무관, 오늘의 톱). 나머지 섹션과 중복 게재 금지.
- "release"(릴리스·신모델): GitHub 릴리스/모델 출시(버전 업)일 때. "repo"(핫 레포): 새로 뜬 저장소. "gov"(정부 지원사업): **기업마당 피드의 실제 공고 중 AI·IT·SW·스타트업 관련만**. 농업·제조 등 무관 공고·랜딩페이지 generic 금지. 관련 공고 없으면 이 섹션 비울 것. "paper"(주목할 페이퍼): arXiv. "tool"(개발 툴). "community"(커뮤니티 반응): HN/Reddit 담론. 각각 **2~5개**, 해당 소스 없으면 비워도 됨 (지어내기 금지).
- 전체 16~26개. 수집 안 된 내용 지어내지 말 것. URL은 반드시 위 소스에 등장한 것.`;

console.log(`Prompt: ${(Buffer.byteLength(prompt, "utf8") / 1024).toFixed(1)} KB`);
if (DRY_RUN) {
  console.log("=== DRY RUN ===\n" + prompt.slice(0, 2500) + `\n...(전체 ${prompt.length}자)`);
  process.exit(0);
}

function callClaude(promptText) {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "text", "--allowedTools", "", "--model", CLAUDE_MODEL];
    console.log(`claude -p (${CLAUDE_MODEL}) 호출...`);
    const child = spawn("claude", args, { stdio: ["pipe", "pipe", "inherit"], shell: true });
    let out = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("타임아웃 5분")); }, 5 * 60 * 1000);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`claude exit ${code}`)); });
    child.stdin.write(promptText);
    child.stdin.end();
  });
}

const raw = await callClaude(prompt);
const jm = raw.match(/```json\s*([\s\S]*?)\s*```/) || raw.match(/\{[\s\S]*\}/);
if (!jm) { console.error("JSON 미발견:", raw.slice(0, 600)); process.exit(1); }
let data;
try { data = JSON.parse(jm[1] ?? jm[0]); } catch (e) { console.error("파싱 실패:", e.message, "\n", raw.slice(0, 600)); process.exit(1); }

// ===== 시맨틱 HTML 렌더 (baeksang 레이아웃) =====
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const SECTIONS = [
  ["headline", "오늘의 헤드라인"],
  ["release", "릴리스 · 신모델"],
  ["repo", "핫 레포"],
  ["gov", "정부 지원사업"],
  ["paper", "주목할 페이퍼"],
  ["tool", "개발 툴"],
  ["community", "커뮤니티 반응"],
];
const SRC_LABEL = { hn: "Hacker News", github: "GitHub", huggingface: "HuggingFace", arxiv: "arXiv", reddit: "Reddit", blog: "Blog" };
const isCmd = (s) => /(^\$|pip install|npm |npx |git clone|brew |docker|curl |uv |cargo |huggingface-cli|conda )/i.test(String(s || "").trim());
// 한글이 섞여 있으면 '명령어로 시작하는 산문' — 터미널 블록(white-space:pre)에 넣으면 가로 오버플로.
// 순수 명령어(한글 0)만 $ 블록으로, 나머지는 산문으로 두고 명령어 토큰만 인라인 <code>로 강조한다.
const HANGUL = /[가-힣]/;
const isPureCmd = (s) => isCmd(s) && !HANGUL.test(s.replace(/^\$\s*/, ""));
const CMD_TOKENS = "pipx|pip|npm|npx|pnpm|yarn|git|brew|docker|curl|wget|uvx|uv|cargo|conda|ollama|huggingface-cli|python3|python|node";
const CMD_RUN_RE = new RegExp(`(^|\\s)((?:${CMD_TOKENS})(?=\\s|$)[^\\uAC00-\\uD7A3\\n]*)`, "g");
// esc() 처리된 산문에서 명령어 토큰부터 한글 직전까지를 <code>로 감싼다.
const highlightCmds = (escaped) =>
  escaped.replace(CMD_RUN_RE, (_m, lead, run) => {
    const trail = run.match(/\s*$/)[0]; // 뒤따르는 공백은 <code> 밖으로 (조사 앞 띄어쓰기 보존)
    return `${lead}<code class="ni__code">${run.slice(0, run.length - trail.length)}</code>${trail}`;
  });
// .news 는 raw HTML 블록 — marked 가 내부 마크다운(백틱·볼드)을 처리하지 않으므로 여기서 직접 변환.
const codeSpans = (escaped) =>
  escaped
    .replace(/`([^`\n]+)`/g, (_m, c) => `<code class="ni__code">${c}</code>`)
    .replace(/\*\*([^*\n]+)\*\*/g, (_m, b) => `<strong>${b}</strong>`);
const inlineEsc = (s) => codeSpans(esc(s));                    // 백틱/볼드 → 인라인 (모든 산문)
const todoProse = (s) => highlightCmds(codeSpans(esc(s)));     // todo: 백틱 없는 맨명령어도 칩으로
const stripBackticks = (s) => s.replace(/`/g, "");

const items = Array.isArray(data.items) ? data.items : [];
let n = 0;
function renderItem(it) {
  n += 1;
  const num = String(n).padStart(2, "0");
  const todo = String(it.todo || "").trim();
  const todoHtml = isPureCmd(todo)
    ? `<pre class="ni__cmd"><code>${esc(stripBackticks(todo).replace(/^\$\s*/, ""))}</code></pre>`
    : `<p class="ni__do-text">${todoProse(todo)}</p>`;
  const points = (it.points || []).map((p) => `<li>${inlineEsc(p)}</li>`).join("");
  const src = SRC_LABEL[it.source] || esc(it.source || "");
  const score = Number.isFinite(+it.score) ? `${+it.score}/10` : "";
  return `<article class="ni">
  <header class="ni__h">
    <span class="ni__n">${num}</span>
    <a class="ni__t" href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)} <span class="ni__arrow">↗</span></a>
    <span class="ni__tr">${src ? `<span class="ni__src">${src}</span>` : ""}${score ? `<span class="ni__score">${score}</span>` : ""}</span>
  </header>
  <p class="ni__body">${inlineEsc(it.body)}</p>
  ${points ? `<ul class="ni__pts">${points}</ul>` : ""}
  <div class="ni__meta">
    <div class="ni__row"><dt>얻는 것</dt><dd>${inlineEsc(it.gain)}</dd></div>
    <div class="ni__row ni__row--do"><dt>지금 할 일</dt><dd>${todoHtml}</dd></div>
    <div class="ni__row ni__row--why"><dt>왜 지금</dt><dd>${inlineEsc(it.why_now)}</dd></div>
  </div>
  <footer class="ni__f"><a class="ni__story" href="${esc(it.url)}" target="_blank" rel="noopener">스토리 →</a></footer>
</article>`;
}

let bodyHtml = "";
let total = 0;
for (const [key, label] of SECTIONS) {
  const secItems = items.filter((it) => it.section === key);
  if (!secItems.length) continue;
  total += secItems.length;
  bodyHtml += `<section class="news-sec">\n<h2 class="news-sec__t">${label}</h2>\n${secItems.map(renderItem).join("\n")}\n</section>\n`;
}
// 미분류(섹션값 이상) 항목은 헤드라인 아래 묶기
const orphans = items.filter((it) => !SECTIONS.some(([k]) => k === it.section));
if (orphans.length) {
  bodyHtml += `<section class="news-sec">\n<h2 class="news-sec__t">그 외</h2>\n${orphans.map(renderItem).join("\n")}\n</section>\n`;
  total += orphans.length;
}

const note = String(data.edition_note || "").replaceAll('"', "'").trim();
const introHtml = data.intro ? `<section class="news-flow-sec"><h2 class="news-flow__t">이번 회차 흐름</h2><div class="news-flow"><p>${inlineEsc(data.intro)}</p></div></section>\n` : "";
const outroHtml = data.outro ? `<div class="news-outro"><span class="news-outro__t">맺음말</span><p>${inlineEsc(data.outro)}</p></div>\n` : "";
const md = `---
title: ${dateStr} (${dayOfWeek})
eyebrow: AI · DEV DAILY
hero_title: "${dateStr.replaceAll("-", " · ")} <em>(${dayOfWeek})</em>"
description: "${note}"
summary: ${note}
---

<div class="news">
${introHtml}${bodyHtml}${outroHtml}</div>
`;

await writeFile(`${slug}.md`, md);
console.log(`${slug}.md 저장 — 항목 ${total}개`);

// ===== index.md 재생성 =====
const files = (await readdir(".")).filter((f) => /^\d{4}-\d{2}-\d{2}.*\.md$/.test(f)).sort().reverse();
async function readSummaryOf(file) {
  try {
    const fm = (await readFile(file, "utf8")).replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---/);
    if (!fm) return "";
    const s = fm[1].match(/^summary:\s*(.+)$/m);
    if (s) return s[1].trim();
    const d = fm[1].match(/^description:\s*"?(.+?)"?$/m);
    return d ? d[1].trim() : "";
  } catch { return ""; }
}
const entries = await Promise.all(files.map(async (f) => {
  const slugOnly = f.replace(".md", "");
  const summary = await readSummaryOf(f);
  const mm = slugOnly.match(/^(\d{4}-\d{2}-\d{2})_(.+)$/);
  const label = mm ? `${mm[1]} (${mm[2]})` : slugOnly;
  return summary ? `- [${label} — ${summary}](${slugOnly}.html)` : `- [${label}](${slugOnly}.html)`;
}));

const indexMd = `---
title: AI Trends
eyebrow: AI × DEV · DAILY
hero_title: "AI <em>Trends</em>"
description: 매일 아침, GitHub·Hacker News·arXiv·HuggingFace·Reddit에서 그날의 AI·개발 트렌드를 자동으로 모아 한국어로 정리합니다. 항목마다 '얻는 것 · 지금 할 일 · 왜 지금'으로 바로 써먹게.
stats:
  - num: "매일"
    lbl: "Daily Update"
  - num: "${sources.length}"
    lbl: "Sources"
  - num: "6"
    lbl: "Sections"
  - num: "${files.length}"
    lbl: "회차"
---

## 회차 목록

${entries.join("\n")}
{:.episode-list}

*매일 08:00 KST 새 회차가 자동으로 추가됩니다.*

## 각 회차 구성

- **오늘의 헤드라인** — 출처 무관, 그날의 톱 4~6
- **릴리스 · 신모델 / 핫 레포 / 주목할 페이퍼 / 개발 툴 / 커뮤니티 반응**
- 항목마다 *얻는 것 · 지금 할 일 · 왜 지금* + 실무 점수

## 이 큐레이션은

매일 아침 **GitHub · Hacker News · arXiv · HuggingFace · Reddit** 을 자동으로 돌며 그날 새로 나온 것 중 실제로 써먹을 수 있는 것만 골라 정리합니다. Claude Code 구독으로 로컬 생성하므로 별도 API 비용이 없습니다.
`;

await writeFile("index.md", indexMd);
console.log(`index.md 갱신 (${files.length}회차)`);

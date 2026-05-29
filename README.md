# ai-trends-curation

매일 AI·개발 트렌드를 자동 큐레이션하는 콘텐츠 repo. **dangsun.kr/news** 에서 렌더링됨.

## 구조

- `YYYY-MM-DD_요일.md` — 회차 (frontmatter + 본문 5섹션)
- `index.md` — 회차 목록 (생성기가 자동 재작성)
- `scripts/sources.json` — 수집 소스 (GitHub/HN/arXiv/HF/Reddit)
- `scripts/build-local.mjs` — 생성기

## 생성 방식

기존 arch/ainews 큐레이션과 달리 **GitHub Actions(유료 API)가 아니라 로컬에서 Claude Code 구독(정액제)으로** 생성한다.
PC에서 매일 08:00 KST에 Windows 작업 스케줄러가 `build-local.mjs`를 실행 → `claude -p`로 회차 작성 → commit & push.
Vercel ISR(revalidate 300s)이 새 커밋을 자동 반영한다.

```bash
# 수동 실행
node scripts/build-local.mjs

# 수집 + 프롬프트만 확인 (claude 호출 안 함)
DRY_RUN=1 node scripts/build-local.mjs

# 오늘 회차 강제 재생성 / 모델 변경
FORCE=1 CLAUDE_MODEL=opus node scripts/build-local.mjs
```

## 환경변수 (선택)

- `CLAUDE_MODEL` — 기본 `sonnet`. `opus`로 품질 ↑ (구독 사용량 ↑)
- `GITHUB_TOKEN` — GitHub Search API rate limit 완화용 (없어도 동작)

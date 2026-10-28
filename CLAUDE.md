# 작업 규칙

- 수정 사항은 커밋 후 **main 브랜치에 바로 반영**한다 (사용자 지시, 2026-10). GitHub Pages가 main에서 배포된다.
  - 작업 브랜치에 커밋 → `git push origin HEAD:main` (fast-forward만, 강제 푸시 금지).
  - main이 앞서 있으면 먼저 main을 받아 그 위에서 작업한다.
- 앱 수정 시 `index.html` `<title>`의 버전(vNN.N)을 올린다.
- 반영 전 `index.html`의 `<script>` 문법 검사(node --check)를 한다.

# spotify-bot

Бягучы этап — функцыянальнасць для **OBS** і стрымаў на **Twitch**.

Праект вядзецца разам з Claude і Claude Code. Уся дакументацыя, каментарыі і commit-паведамленні — па-беларуску.

## Дзе што ляжыць

- `CLAUDE.md` — правілы працы Claude Code.
- `docs/PROJECT.md` — актуальны стан і наступная задача.
- `docs/LOG.md` — журнал змен.
- `docs/DECISIONS.md` — рашэнні і іх абгрунтаванне.
- `docs/BACKLOG.md` — ідэі і тэхнічны доўг.
- `docs/SETUP.md` — што трэба наладзіць аўтару.
- `docs/CLAUDE_PROJECT_INSTRUCTIONS.md` — інструкцыя для Claude Project.
- `.env.example` — спіс зменных асяроддзя (сакрэты ў `.env`, які не трапляе ў git).

## Запуск (распрацоўка)

Патрабуецца Node.js 24+.

```bash
npm install
npm run dev      # http://127.0.0.1:5173/ — док і оверлей
npm test         # тэсты
npm run build    # зборка ў dist/
```

Як падключыць да OBS — `docs/SETUP.md`. Усе каманды — `docs/PROJECT.md`.

// Публікацыя зборкі на хостынг (Этап 5, ADR-019): змесціва `dist/` → галіна `gh-pages` асобнага публічнага рэпазіторыя.
// Зыходны код застаецца ў прыватным рэпазіторыі, публічная толькі зборка (у ёй няма сакрэтаў, Client ID — не сакрэт).
// Запуск: `npm run deploy` (спачатку зборка). Адрас рэпазіторыя — `deploy.repo` у package.json або зменная DEPLOY_REPO.
// Гісторыя галіны захоўваецца: кожная публікацыя — асобны commit, без `push --force`.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const repo = process.env.DEPLOY_REPO || pkg.deploy?.repo;
const branch = 'gh-pages';
const dist = join(root, 'dist');

if (!repo) throw new Error('Не зададзены адрас рэпазіторыя: deploy.repo у package.json або DEPLOY_REPO');
if (!existsSync(join(dist, 'dock.html'))) throw new Error('Няма зборкі: спачатку npm run build');

const git = (args, cwd) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();
const source = git(['rev-parse', '--short', 'HEAD'], root);
const work = mkdtempSync(join(tmpdir(), 'spotify-bot-deploy-'));

try {
  // Галіна ўжо ёсць — бярэм яе, каб дадаць новы commit; няма — пачынаем з пустой.
  const exists = git(['ls-remote', '--heads', repo, branch], root) !== '';
  if (exists) git(['clone', '--quiet', '--depth', '1', '--branch', branch, repo, '.'], work);
  else {
    git(['init', '--quiet', '-b', branch], work);
    git(['remote', 'add', 'origin', repo], work);
  }
  for (const name of readdirSync(work)) if (name !== '.git') rmSync(join(work, name), { recursive: true, force: true });
  cpSync(dist, work, { recursive: true });
  // GitHub Pages не павінен апрацоўваць файлы праз Jekyll.
  writeFileSync(join(work, '.nojekyll'), '');
  git(['add', '--all'], work);
  if (git(['status', '--porcelain'], work) === '') {
    console.log('Зменаў няма — публікаваць нічога');
  } else {
    git(['commit', '--quiet', '-m', `зборка з ${source}`], work);
    git(['push', '--quiet', 'origin', branch], work);
    console.log(`Апублікавана: ${repo} (${branch}), зборка з ${source}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

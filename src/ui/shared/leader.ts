// Тэкст «дзе працуе бот» для ўкладкі «Праверка» і debug-оверлея (ADR-015).

import type { LeaderInfo, PageKind } from '../../brain/bus';
import { t } from '../../i18n';

export function leaderText(leader: LeaderInfo | null, selfId: string, selfPage: PageKind): string {
  if (!leader) return t('brain.none');
  if (leader.id === selfId) return t(`brain.here.${selfPage}`);
  if (leader.page === 'dock') return t('brain.in.dock');
  return selfPage === 'overlay' ? t('brain.in.otherOverlay') : t('brain.in.overlay');
}

export const clock = (ms: number) => new Date(ms).toLocaleTimeString('be-BY');

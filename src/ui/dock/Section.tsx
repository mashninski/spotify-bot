// Блок дока: загаловак, дзеянні справа і значок падказкі «?» (ADR-014).

import type { ComponentChildren } from 'preact';
import { t } from '../../i18n';

export function InfoTip({ text }: { text: string }) {
  return (
    <span class="info-tip">
      <button type="button" class="info-tip-icon" aria-label={t('help.label')}>
        ?
      </button>
      <span class="info-tip-text" role="tooltip">
        {text}
      </span>
    </span>
  );
}

interface SectionProps {
  title: string;
  help?: string;
  /** Дадатковыя кнопкі ў загалоўку (злева ад «?»). */
  actions?: ComponentChildren;
  children: ComponentChildren;
}

export function Section({ title, help, actions, children }: SectionProps) {
  return (
    <section>
      <div class="section-head">
        <h2>{title}</h2>
        <div class="section-actions">
          {actions}
          {help && <InfoTip text={help} />}
        </div>
      </div>
      {children}
    </section>
  );
}

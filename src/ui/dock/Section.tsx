// Блок дока: загаловак, дзеянні справа і значок падказкі «?» (ADR-014).

import type { ComponentChildren } from 'preact';
import { t } from '../../i18n';

/**
 * Тэкст падказкі: абзацы раздзелены пустым радком, радкі абзаца (крокі «1. …», пункты) — кожны з новага радка.
 */
function HelpText({ text }: { text: string }) {
  return (
    <>
      {text.split('\n\n').map((block, i) => {
        const lines = block.split('\n');
        const steps = lines.every((l) => /^\d+\. /.test(l));
        return steps ? (
          <ol key={i} class="help-steps">
            {lines.map((l, j) => (
              <li key={j}>{l.replace(/^\d+\. /, '')}</li>
            ))}
          </ol>
        ) : (
          <p key={i} class="help-par">
            {lines.map((l, j) => (
              <span key={j} class="help-line">
                {l}
              </span>
            ))}
          </p>
        );
      })}
    </>
  );
}

export function InfoTip({ text }: { text: string }) {
  return (
    <span class="info-tip">
      <button type="button" class="info-tip-icon" aria-label={t('help.label')}>
        ?
      </button>
      <span class="info-tip-text" role="tooltip">
        <HelpText text={text} />
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

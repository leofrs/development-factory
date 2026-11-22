import { Check, CheckCircle2, ClipboardCheck, Plus, Trash2 } from 'lucide-react';
import type {
  FactoryPlanningApproval,
  FactoryPlanningDecisionChoiceMode,
  FactoryPlanningGate,
} from '@development-factory/shared';

export interface PlanningDecisionDraft {
  readonly id: string;
  readonly question: string;
  readonly options: readonly string[];
  readonly recommendedOption: string;
  readonly mode: FactoryPlanningDecisionChoiceMode;
  readonly selectedOption: string;
  readonly customText: string;
}

export interface PlanningCriterionDraft {
  readonly id: string;
  readonly description: string;
  readonly approved: boolean;
  readonly isCustom: boolean;
}

const MODE_LABELS: Readonly<Record<FactoryPlanningDecisionChoiceMode, string>> = {
  recommended: 'Opção Recomendada',
  alternative: 'Alternativa',
  custom: 'Customizada',
};

/** Inicializa rascunhos interativos das decisões pendentes e critérios de aceite do Bloco 02. */
export function createPlanningGateDrafts(
  planningGate: FactoryPlanningGate | undefined,
  persistedApproval: FactoryPlanningApproval | null | undefined,
): {
  decisions: PlanningDecisionDraft[];
  criteria: PlanningCriterionDraft[];
  notes: string;
} {
  const pendingDecisions = planningGate?.pendingDecisions ?? [];
  const decisions: PlanningDecisionDraft[] = pendingDecisions.map((pending, index) => {
    const id = `D${index + 1}`;
    const saved = persistedApproval?.decisions.find(
      item => item.id === id || item.question === pending.question,
    );
    if (!saved) {
      return {
        id,
        question: pending.question,
        options: pending.options,
        recommendedOption: pending.recommendedOption,
        mode: 'recommended',
        selectedOption: pending.recommendedOption,
        customText: '',
      };
    }

    return {
      id,
      question: pending.question,
      options: pending.options,
      recommendedOption: pending.recommendedOption,
      mode: saved.mode,
      selectedOption: saved.mode === 'custom' ? pending.recommendedOption : saved.selectedOption,
      customText: saved.mode === 'custom' ? saved.selectedOption : (saved.customNote ?? ''),
    };
  });

  const baseCriteria = planningGate?.acceptanceCriteria ?? [];
  const baseCriteriaIds = new Set(baseCriteria.map(criterion => criterion.id));
  const criteria: PlanningCriterionDraft[] =
    persistedApproval && persistedApproval.acceptanceCriteria.length > 0
      ? persistedApproval.acceptanceCriteria.map(criterion => ({
          id: criterion.id,
          description: criterion.description,
          approved: criterion.approved,
          isCustom: !baseCriteriaIds.has(criterion.id),
        }))
      : baseCriteria.map(criterion => ({
          id: criterion.id,
          description: criterion.description,
          approved: true,
          isCustom: false,
        }));

  return {
    decisions,
    criteria,
    notes: persistedApproval?.notes ?? '',
  };
}

/** Gera o próximo identificador sequencial (`CA1`, `CA2`, ...) para um novo critério de aceite. */
export function getNextAcceptanceCriterionId(
  criteria: readonly Pick<PlanningCriterionDraft, 'id'>[],
): string {
  let maxNumber = 0;
  for (const criterion of criteria) {
    const match = /^CA(\d+)$/i.exec(criterion.id.trim());
    if (match?.[1] !== undefined) {
      const value = Number(match[1]);
      if (Number.isInteger(value) && value > maxNumber) {
        maxNumber = value;
      }
    }
  }
  return `CA${Math.max(maxNumber + 1, criteria.length + 1)}`;
}

interface EditablePlanningGateProps {
  editable: true;
  decisions: readonly PlanningDecisionDraft[];
  criteria: readonly PlanningCriterionDraft[];
  notes: string;
  validationError: string | null;
  disabled: boolean;
  onDecisionModeChange: (
    index: number,
    mode: FactoryPlanningDecisionChoiceMode,
    selectedOption: string,
  ) => void;
  onDecisionCustomTextChange: (index: number, customText: string) => void;
  onCriterionToggle: (index: number, approved: boolean) => void;
  onCriterionDescriptionChange: (index: number, description: string) => void;
  onAddCriterion: () => void;
  onRemoveCriterion: (index: number) => void;
  onNotesChange: (notes: string) => void;
}

interface ReadOnlyPlanningGateProps {
  editable: false;
  approval: FactoryPlanningApproval;
}

type FactoryPlanningGatePanelProps = EditablePlanningGateProps | ReadOnlyPlanningGateProps;

/** Renderiza o portão humano estruturado do Bloco 02 em modo editável ou persistido somente leitura. */
export function FactoryPlanningGatePanel(props: FactoryPlanningGatePanelProps) {
  if (!props.editable) {
    const { approval } = props;
    const approvedCriteriaCount = approval.acceptanceCriteria.filter(item => item.approved).length;
    return (
      <div
        role="region"
        aria-label="Decisões e critérios aprovados do planejamento"
        className="mt-3 space-y-2.5 rounded-xl border border-accent/30 bg-selected/35 p-3 text-xs text-primary"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 font-semibold text-accent">
            <CheckCircle2 size={13} className="shrink-0" />
            Decisões e critérios aprovados
          </p>
          <span className="font-mono text-[10px] text-muted">
            {approval.decisions.length}{' '}
            {approval.decisions.length === 1 ? 'decisão' : 'decisões'} · {approvedCriteriaCount}/
            {approval.acceptanceCriteria.length} CAs
          </span>
        </div>

        {approval.decisions.length > 0 && (
          <ul className="space-y-1.5">
            {approval.decisions.map(decision => (
              <li
                key={decision.id}
                className="rounded-lg border border-line bg-page px-2.5 py-2 text-[11px]"
              >
                <div className="flex flex-wrap items-center justify-between gap-1.5">
                  <span className="font-mono font-semibold text-accent">{decision.id}</span>
                  <span className="rounded-full border border-accent/30 bg-selected px-2 py-0.5 font-mono text-[10px] text-accent">
                    {MODE_LABELS[decision.mode]}
                  </span>
                </div>
                <p className="mt-1 font-medium text-primary">{decision.question}</p>
                <p className="mt-0.5 text-secondary">{decision.selectedOption}</p>
                {decision.customNote && (
                  <p className="mt-1 text-[10px] text-muted">
                    Observação: {decision.customNote}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}

        {approval.acceptanceCriteria.length > 0 && (
          <div className="space-y-1">
            <p className="text-[11px] font-medium text-secondary">
              Critérios de aceite revisados:
            </p>
            <ul className="space-y-1">
              {approval.acceptanceCriteria.map(criterion => (
                <li
                  key={criterion.id}
                  className={`flex items-start gap-2 rounded-lg border px-2 py-1.5 text-[11px] ${
                    criterion.approved
                      ? 'border-line bg-page text-primary'
                      : 'border-line-subtle bg-page/50 text-muted line-through'
                  }`}
                >
                  <span
                    className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded border ${
                      criterion.approved
                        ? 'border-accent bg-accent text-on-accent'
                        : 'border-line bg-surface text-muted'
                    }`}
                    aria-hidden="true"
                  >
                    {criterion.approved && <Check size={10} />}
                  </span>
                  <span className="font-mono text-[10px] font-semibold text-accent">
                    {criterion.id}
                  </span>
                  <span className="min-w-0 flex-1 break-words">{criterion.description}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {approval.notes && (
          <div className="rounded-lg border border-line bg-page px-2.5 py-2 text-[11px] text-secondary">
            <p className="font-medium text-primary">Notas adicionais</p>
            <p className="mt-0.5 whitespace-pre-wrap break-words">{approval.notes}</p>
          </div>
        )}
      </div>
    );
  }

  const {
    decisions,
    criteria,
    notes,
    validationError,
    disabled,
    onDecisionModeChange,
    onDecisionCustomTextChange,
    onCriterionToggle,
    onCriterionDescriptionChange,
    onAddCriterion,
    onRemoveCriterion,
    onNotesChange,
  } = props;

  return (
    <div
      role="region"
      aria-label="Portão humano do planejamento"
      className="w-full space-y-3 rounded-xl border border-accent/35 bg-page p-3 text-xs text-primary"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 font-semibold text-accent">
          <ClipboardCheck size={13} className="shrink-0" />
          Portão humano · Decisões e critérios
        </p>
        <span className="font-mono text-[10px] text-muted">Bloco 02 → 03</span>
      </div>

      {decisions.length > 0 ? (
        <div className="space-y-2.5">
          {decisions.map((decision, decisionIndex) => {
            const alternatives = decision.options.filter(
              option => option !== decision.recommendedOption,
            );
            const radioGroupName = `planning-decision-${decisionIndex}-${decision.id}`;

            return (
              <fieldset
                key={decision.id}
                disabled={disabled}
                className="space-y-2 rounded-lg border border-line bg-surface p-2.5"
              >
                <legend className="px-1 text-[11px] font-semibold text-primary">
                  <span className="font-mono text-accent">{decision.id}</span> · {decision.question}
                </legend>

                <div className="space-y-1.5">
                  <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-line-subtle bg-page px-2.5 py-1.5 text-[11px] transition hover:border-accent/40 has-[:checked]:border-accent/50 has-[:checked]:bg-selected/50">
                    <input
                      type="radio"
                      name={radioGroupName}
                      checked={decision.mode === 'recommended'}
                      onChange={() =>
                        onDecisionModeChange(
                          decisionIndex,
                          'recommended',
                          decision.recommendedOption,
                        )
                      }
                      className="mt-0.5 accent-[var(--accent)]"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="inline-flex flex-wrap items-center gap-1.5">
                        <span className="rounded-full border border-accent/30 bg-selected px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide text-accent">
                          Opção Recomendada
                        </span>
                      </span>
                      <span className="mt-1 block break-words text-primary">
                        {decision.recommendedOption}
                      </span>
                    </span>
                  </label>

                  {alternatives.map((alternative, altIndex) => (
                    <label
                      key={`${decision.id}-alt-${altIndex}`}
                      className="flex cursor-pointer items-start gap-2 rounded-lg border border-line-subtle bg-page px-2.5 py-1.5 text-[11px] transition hover:border-accent/40 has-[:checked]:border-accent/50 has-[:checked]:bg-selected/50"
                    >
                      <input
                        type="radio"
                        name={radioGroupName}
                        checked={
                          decision.mode === 'alternative' &&
                          decision.selectedOption === alternative
                        }
                        onChange={() =>
                          onDecisionModeChange(decisionIndex, 'alternative', alternative)
                        }
                        className="mt-0.5 accent-[var(--accent)]"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="rounded-full border border-line bg-surface px-1.5 py-0.5 font-mono text-[9px] font-medium uppercase tracking-wide text-secondary">
                          Alternativa
                        </span>
                        <span className="mt-1 block break-words text-primary">{alternative}</span>
                      </span>
                    </label>
                  ))}

                  <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-line-subtle bg-page px-2.5 py-1.5 text-[11px] transition hover:border-accent/40 has-[:checked]:border-accent/50 has-[:checked]:bg-selected/50">
                    <input
                      type="radio"
                      name={radioGroupName}
                      checked={decision.mode === 'custom'}
                      onChange={() =>
                        onDecisionModeChange(decisionIndex, 'custom', decision.customText)
                      }
                      className="mt-0.5 accent-[var(--accent)]"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="rounded-full border border-warning/35 bg-warning/10 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide text-warning">
                        Customizada
                      </span>
                      <span className="mt-1 block text-muted">
                        Defina uma diretriz personalizada para esta decisão.
                      </span>
                    </span>
                  </label>
                </div>

                <label className="grid gap-1 text-[11px] text-secondary">
                  <span>
                    {decision.mode === 'custom'
                      ? `Decisão customizada (${decision.id})`
                      : `Customização ou observação opcional (${decision.id})`}
                  </span>
                  <input
                    type="text"
                    value={decision.customText}
                    disabled={disabled}
                    maxLength={2000}
                    placeholder={
                      decision.mode === 'custom'
                        ? 'Descreva a decisão aprovada para o Bloco 03...'
                        : 'Opcional: adicione ajuste ou escolha Customizada acima...'
                    }
                    onChange={event => onDecisionCustomTextChange(decisionIndex, event.target.value)}
                    className="rounded-lg border border-line bg-page px-2.5 py-1.5 text-[11px] text-primary focus-visible:outline-2 focus-visible:outline-accent"
                  />
                </label>
              </fieldset>
            );
          })}
        </div>
      ) : (
        <p className="rounded-lg border border-line bg-surface px-2.5 py-2 text-[11px] text-muted">
          Nenhuma decisão arquitetural pendente foi registrada no plano.
        </p>
      )}

      <div className="space-y-2 rounded-lg border border-line bg-surface p-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[11px] font-semibold text-primary">
            Checklist de critérios de aceite
          </span>
          <button
            type="button"
            disabled={disabled}
            onClick={onAddCriterion}
            className="inline-flex items-center gap-1 rounded-md border border-accent/35 bg-page px-2 py-0.5 text-[10px] font-medium text-accent transition hover:bg-selected disabled:opacity-60"
          >
            <Plus size={11} />
            Adicionar critério
          </button>
        </div>

        {criteria.length === 0 ? (
          <p className="text-[11px] text-muted">
            Nenhum critério de aceite herdado da triagem. Adicione critérios se desejar.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {criteria.map((criterion, index) => (
              <li
                key={`${criterion.id}-${index}`}
                className="flex items-start gap-2 rounded-lg border border-line-subtle bg-page p-2"
              >
                <input
                  type="checkbox"
                  checked={criterion.approved}
                  disabled={disabled}
                  aria-label={`Aprovar critério ${criterion.id}`}
                  onChange={event => onCriterionToggle(index, event.target.checked)}
                  className="mt-1.5 accent-[var(--accent)]"
                />
                <span className="mt-1 font-mono text-[10px] font-semibold text-accent">
                  {criterion.id}
                </span>
                <input
                  type="text"
                  value={criterion.description}
                  disabled={disabled}
                  maxLength={2000}
                  aria-label={`Descrição do critério ${criterion.id}`}
                  placeholder="Descreva o critério de aceite..."
                  onChange={event => onCriterionDescriptionChange(index, event.target.value)}
                  className={`min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1 text-[11px] focus-visible:outline-2 focus-visible:outline-accent ${
                    criterion.approved ? 'text-primary' : 'text-muted line-through'
                  }`}
                />
                {criterion.isCustom && (
                  <button
                    type="button"
                    disabled={disabled}
                    aria-label={`Remover critério ${criterion.id}`}
                    onClick={() => onRemoveCriterion(index)}
                    className="mt-0.5 rounded-md p-1 text-muted transition hover:bg-danger/10 hover:text-danger disabled:opacity-60"
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <label className="grid w-full gap-1 text-[11px] text-secondary">
        <span>Notas adicionais para o Desenvolvimento (opcional)</span>
        <textarea
          value={notes}
          rows={2}
          maxLength={4000}
          disabled={disabled}
          placeholder="Instruções complementares opcionais para o Bloco 03..."
          onChange={event => onNotesChange(event.target.value)}
          className="rounded-lg border border-line bg-surface p-2 text-xs text-primary focus-visible:outline-2 focus-visible:outline-accent"
        />
      </label>

      {validationError && (
        <p role="alert" className="text-[11px] font-medium text-danger">
          {validationError}
        </p>
      )}
    </div>
  );
}

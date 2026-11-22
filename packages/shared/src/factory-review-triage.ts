import { z } from 'zod';
import {
  FACTORY_FLOW_CONTRACT_VERSION,
  FactoryFlowSchema,
  FactoryReviewGateSchema,
  type FactoryReviewFindingDecision,
  type FactoryReviewGate,
  type FactoryReviewSidecar,
  type FactoryReviewTriage,
  type FactoryReviewTriageScope,
  type FactoryReviewTriagedFinding,
  type FactoryReviewVerdict,
  type ReturnFactoryTargetStage,
} from './factory.js';

export const SaveFactoryReviewTriageResponseSchema = z.strictObject({
  contractVersion: z.literal(FACTORY_FLOW_CONTRACT_VERSION),
  flow: FactoryFlowSchema,
  reviewGate: FactoryReviewGateSchema,
});
export type SaveFactoryReviewTriageResponse = z.infer<
  typeof SaveFactoryReviewTriageResponseSchema
>;

/** Gera o identificador determinístico de um apontamento do sidecar do Bloco 05 (`F1`, `F2`, ...). */
export function getFactoryReviewFindingId(index: number): string {
  return `F${index + 1}`;
}

/** Valida e normaliza as decisões humanas de triagem em relação aos apontamentos do sidecar do Bloco 05. */
export function validateFactoryReviewTriageDecisions(
  findings: FactoryReviewSidecar['findings'],
  decisions: readonly FactoryReviewFindingDecision[],
):
  | { valid: true; normalizedDecisions: FactoryReviewFindingDecision[] }
  | { valid: false; message: string } {
  const byId = new Map<string, FactoryReviewSidecar['findings'][number]>();
  findings.forEach((finding, index) => {
    byId.set(getFactoryReviewFindingId(index), finding);
  });

  const seen = new Set<string>();
  const normalizedDecisions: FactoryReviewFindingDecision[] = [];

  for (const decision of decisions) {
    if (seen.has(decision.findingId)) {
      return {
        valid: false,
        message: `Decisão duplicada para o apontamento ${decision.findingId}.`,
      };
    }
    seen.add(decision.findingId);

    const finding = byId.get(decision.findingId);
    if (!finding) {
      return {
        valid: false,
        message: `Apontamento ${decision.findingId} não existe no relatório de Code Review atual.`,
      };
    }

    if (decision.action === 'promote_mandatory' && finding.severity !== 'SUGESTÃO') {
      return {
        valid: false,
        message: `Apenas apontamentos [SUGESTÃO] podem ser promovidos a correção obrigatória (${decision.findingId}).`,
      };
    }

    if (decision.action === 'pending') {
      continue;
    }

    const trimmedJustification =
      decision.action === 'dismiss_false_positive' ? decision.justification?.trim() : undefined;

    normalizedDecisions.push({
      findingId: decision.findingId,
      action: decision.action,
      ...(trimmedJustification ? { justification: trimmedJustification } : {}),
    });
  }

  return { valid: true, normalizedDecisions };
}

/** Combina os apontamentos do sidecar do Bloco 05 com a triagem humana persistida. */
export function buildFactoryReviewGate(input: {
  readonly reviewArtifactId: string;
  readonly reviewReportPath: string;
  readonly iteration: number;
  readonly verdict: FactoryReviewVerdict;
  readonly returnTarget: ReturnFactoryTargetStage | null;
  readonly findings: FactoryReviewSidecar['findings'];
  readonly reviewTriage?: FactoryReviewTriage | null;
}): FactoryReviewGate {
  const matchingDecisions = new Map<string, FactoryReviewFindingDecision>();
  if (input.reviewTriage && input.reviewTriage.reviewArtifactId === input.reviewArtifactId) {
    for (const decision of input.reviewTriage.decisions) {
      matchingDecisions.set(decision.findingId, decision);
    }
  }

  let blocking = 0;
  let suggestion = 0;
  let nit = 0;
  let activeBlockers = 0;
  let approvedForFix = 0;
  let promotedMandatory = 0;
  let dismissed = 0;
  let pending = 0;

  const findings: FactoryReviewTriagedFinding[] = input.findings.map((finding, index) => {
    const id = getFactoryReviewFindingId(index);
    const decision = matchingDecisions.get(id);
    const rawAction = decision?.action ?? 'pending';
    const action =
      rawAction === 'promote_mandatory' && finding.severity !== 'SUGESTÃO'
        ? 'pending'
        : rawAction;
    const justification =
      action === 'dismiss_false_positive' ? decision?.justification : undefined;

    if (finding.severity === 'BLOQUEANTE') {
      blocking += 1;
    } else if (finding.severity === 'SUGESTÃO') {
      suggestion += 1;
    } else {
      nit += 1;
    }

    if (action === 'approve_fix') {
      approvedForFix += 1;
    } else if (action === 'promote_mandatory') {
      promotedMandatory += 1;
    } else if (action === 'dismiss_false_positive') {
      dismissed += 1;
    } else {
      pending += 1;
    }

    const effectiveSeverity: FactoryReviewTriagedFinding['effectiveSeverity'] =
      action === 'dismiss_false_positive'
        ? 'DISCARDED'
        : action === 'promote_mandatory'
          ? 'BLOQUEANTE'
          : finding.severity;

    const isActiveBlocker =
      action !== 'dismiss_false_positive' &&
      (finding.severity === 'BLOQUEANTE' || action === 'promote_mandatory');

    if (isActiveBlocker) {
      activeBlockers += 1;
    }

    const includedInReturnScope =
      action !== 'dismiss_false_positive' &&
      (isActiveBlocker || action === 'approve_fix');

    return {
      id,
      index,
      severity: finding.severity,
      file: finding.file,
      line: finding.line,
      explanation: finding.explanation,
      ...(finding.signature !== undefined ? { signature: finding.signature } : {}),
      ...(finding.category !== undefined ? { category: finding.category } : {}),
      action,
      ...(justification !== undefined ? { justification } : {}),
      effectiveSeverity,
      isActiveBlocker,
      includedInReturnScope,
    };
  });

  return {
    reviewArtifactId: input.reviewArtifactId,
    reviewReportPath: input.reviewReportPath,
    iteration: input.iteration,
    verdict: input.verdict,
    returnTarget: input.returnTarget,
    findings,
    counts: {
      total: findings.length,
      blocking,
      suggestion,
      nit,
      activeBlockers,
      approvedForFix,
      promotedMandatory,
      dismissed,
      pending,
    },
    canAdvanceToPr: activeBlockers === 0,
  };
}

/** Constrói o escopo estruturado enviado às etapas de retorno (`development` / `tests`) a partir da triagem. */
export function buildFactoryReviewTriageScope(gate: FactoryReviewGate): FactoryReviewTriageScope {
  const mandatoryFixes: FactoryReviewTriageScope['mandatoryFixes'] = [];
  const dismissedFalsePositives: FactoryReviewTriageScope['dismissedFalsePositives'] = [];
  const deferredSuggestions: FactoryReviewTriageScope['deferredSuggestions'] = [];

  for (const finding of gate.findings) {
    if (finding.action === 'dismiss_false_positive') {
      dismissedFalsePositives.push({
        id: finding.id,
        originalSeverity: finding.severity,
        file: finding.file,
        line: finding.line,
        explanation: finding.explanation,
        ...(finding.justification !== undefined ? { justification: finding.justification } : {}),
      });
      continue;
    }

    if (finding.includedInReturnScope && finding.effectiveSeverity !== 'DISCARDED') {
      mandatoryFixes.push({
        id: finding.id,
        originalSeverity: finding.severity,
        effectiveSeverity: finding.effectiveSeverity,
        file: finding.file,
        line: finding.line,
        explanation: finding.explanation,
        promotedFromSuggestion: finding.action === 'promote_mandatory',
      });
      continue;
    }

    deferredSuggestions.push({
      id: finding.id,
      severity: finding.severity,
      file: finding.file,
      line: finding.line,
      explanation: finding.explanation,
    });
  }

  return {
    reviewArtifactId: gate.reviewArtifactId,
    iteration: gate.iteration,
    mandatoryFixes,
    dismissedFalsePositives,
    deferredSuggestions,
  };
}

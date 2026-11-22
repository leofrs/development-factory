import { extname } from 'node:path';
import {
  FACTORY_FLOW_CONTRACT_VERSION,
  FACTORY_ITERATION_EVIDENCE_LIMIT,
  FACTORY_ITERATION_EVIDENCE_TEXT_LIMIT,
  FactoryFlowIterationComparisonSchema,
  getLatestReadyFactoryStageArtifact,
} from '@development-factory/shared';
import type {
  FactoryFlowDetails,
  FactoryFlowIterationComparison,
  FactoryIterationEvidence,
} from '@development-factory/shared';
import { FactoryStageArtifactError, readFactoryStageSidecar } from './factory-stage-runners.js';
import type { FactoryStageSidecarMap } from './factory-stage-runners.js';

function readIterationSidecar<Stage extends 'tests' | 'review'>(
  stage: Stage,
  artifacts: FactoryFlowDetails['artifacts'],
): FactoryStageSidecarMap[Stage] | null {
  const artifact = getLatestReadyFactoryStageArtifact({ artifacts }, stage);
  if (!artifact || extname(artifact.path).toLowerCase() !== '.md') {
    return null;
  }
  try {
    return readFactoryStageSidecar(stage, artifact.path);
  } catch (error) {
    if (error instanceof FactoryStageArtifactError) {
      return null;
    }
    throw error;
  }
}

function limitText(value: string): string {
  return value.length <= FACTORY_ITERATION_EVIDENCE_TEXT_LIMIT
    ? value
    : `${value.slice(0, FACTORY_ITERATION_EVIDENCE_TEXT_LIMIT - 1)}…`;
}

function readIteration(details: FactoryFlowDetails, iteration: number): FactoryIterationEvidence {
  const artifacts = details.artifacts.filter(artifact => artifact.iteration === iteration);
  const checkpoint = details.checkpoints.filter(item => item.iteration === iteration).at(-1);
  const tests = readIterationSidecar('tests', artifacts);
  const review = readIterationSidecar('review', artifacts);
  const counts = { passed: 0, failed: 0, skipped: 0 };
  for (const testCase of tests?.testCases ?? []) {
    counts[testCase.status] += 1;
  }

  return {
    iteration,
    checkpoint: checkpoint
      ? { id: checkpoint.id, commitSha: checkpoint.commitSha, stage: checkpoint.stage }
      : null,
    tests: tests
      ? {
          ...counts,
          status: tests.status,
          coverage: tests.coverage,
          cases: tests.testCases.slice(0, FACTORY_ITERATION_EVIDENCE_LIMIT).map(testCase => ({
            id: limitText(testCase.id),
            description: limitText(testCase.description),
            status: testCase.status,
          })),
          commandCount: tests.executedCommands.length,
          commands: tests.executedCommands
            .slice(0, FACTORY_ITERATION_EVIDENCE_LIMIT)
            .map(({ command, exitCode }) => ({ command: limitText(command.join(' ')), exitCode })),
        }
      : null,
    review: review
      ? {
          verdict: review.verdict,
          findingCount: review.findings.length,
          findings: review.findings.slice(0, FACTORY_ITERATION_EVIDENCE_LIMIT).map(finding => ({
            severity: finding.severity,
            file: limitText(finding.file),
            line: finding.line,
            explanation: limitText(finding.explanation),
          })),
        }
      : null,
  };
}

export function readFactoryIterationComparison(
  details: FactoryFlowDetails,
  fromIteration: number,
): FactoryFlowIterationComparison {
  return FactoryFlowIterationComparisonSchema.parse({
    contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
    before: readIteration(details, fromIteration),
    after: readIteration(details, fromIteration + 1),
  });
}

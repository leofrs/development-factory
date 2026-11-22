import { extname } from 'node:path';
import {
  buildFactoryTraceabilityMatrix,
  getLatestReadyFactoryStageArtifact,
  getReadyFactoryStageArtifact,
  type FactoryDiffFile,
  type FactoryFlowDetails,
  type FactoryFlowTraceabilityMatrix,
} from '@development-factory/shared';
import {
  FactoryStageArtifactError,
  readFactoryStageSidecar,
  type FactoryStageSidecarMap,
  type HandoffArtifactStage,
} from './factory-stage-runners.js';
import { FactoryWorktreeError } from './factory-worktree.js';
import { readFactoryWorktreeChangedFiles } from './factory-worktree-diff.js';

function readStageSidecar<Stage extends HandoffArtifactStage>(
  stage: Stage,
  details: FactoryFlowDetails,
): FactoryStageSidecarMap[Stage] | null {
  const artifact =
    getReadyFactoryStageArtifact(details, stage) ??
    getLatestReadyFactoryStageArtifact(details, stage);
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

/**
 * Lê os sidecars das etapas 01–05 e os arquivos alterados no worktree do fluxo
 * para compor a Matriz de Rastreabilidade.
 */
export async function readFactoryTraceabilityMatrix(
  details: FactoryFlowDetails,
  signal: AbortSignal,
): Promise<FactoryFlowTraceabilityMatrix> {
  const triage = readStageSidecar('triage', details);
  const planning = readStageSidecar('planning', details);
  const development = readStageSidecar('development', details);
  const tests = readStageSidecar('tests', details);
  const review = readStageSidecar('review', details);

  let worktreeFiles: FactoryDiffFile[] = [];
  let worktreeAvailable = false;
  let worktreeFilesTruncated = false;

  const { flow, checkpoints } = details;
  const baselineSha = checkpoints.find(checkpoint => checkpoint.iteration === 0)?.commitSha;

  if (flow.worktreePath && (flow.baseBranch || baselineSha)) {
    try {
      const result = await readFactoryWorktreeChangedFiles(
        {
          repoPath: flow.target.repoPath,
          worktreePath: flow.worktreePath,
          flowId: flow.id,
          range: {
            baseBranch: flow.baseBranch ?? 'HEAD',
            baselineSha,
          },
        },
        signal,
      );
      worktreeFiles = result.files;
      worktreeAvailable = true;
      worktreeFilesTruncated = result.truncated;
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      if (!(error instanceof FactoryWorktreeError)) {
        throw error;
      }
    }
  }

  return buildFactoryTraceabilityMatrix({
    triage,
    planning,
    planningApproval: flow.planningApproval ?? null,
    development,
    tests,
    review,
    worktreeFiles,
    worktreeAvailable,
    worktreeFilesTruncated,
  });
}

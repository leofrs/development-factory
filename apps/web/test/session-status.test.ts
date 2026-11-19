import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getSessionStatusPresentation,
  isSessionActivelyRunning,
} from '../src/utils/session-status';

test('isSessionActivelyRunning retorna true apenas quando em execução sem artefato salvo', () => {
  assert.equal(isSessionActivelyRunning({ status: 'running', historyState: 'pending' }), true);
  assert.equal(isSessionActivelyRunning({ status: 'running', historyState: 'incomplete' }), true);
  assert.equal(isSessionActivelyRunning({ status: 'running', historyState: 'saved' }), false);
  assert.equal(isSessionActivelyRunning({ status: 'exited', historyState: 'pending' }), false);
  assert.equal(isSessionActivelyRunning({ status: 'exited', historyState: 'saved' }), false);
  assert.equal(isSessionActivelyRunning({ status: 'failed', historyState: 'incomplete' }), false);
  assert.equal(isSessionActivelyRunning({ status: 'cancelled', historyState: 'incomplete' }), false);
});

test('getSessionStatusPresentation reflete cada etapa da execução de review e factory', () => {
  const reviewRunning = getSessionStatusPresentation({
    mode: 'review',
    status: 'running',
    historyState: 'pending',
  });
  assert.equal(reviewRunning.label, 'Em execução');
  assert.match(reviewRunning.dotClass, /animate-pulse/);

  const reviewSavedWhileRunning = getSessionStatusPresentation({
    mode: 'review',
    status: 'running',
    historyState: 'saved',
  });
  assert.equal(reviewSavedWhileRunning.label, 'Parecer salvo');
  assert.doesNotMatch(reviewSavedWhileRunning.dotClass, /animate-pulse/);
  assert.equal(reviewSavedWhileRunning.textClass, 'text-accent');

  const factorySavedWhileRunning = getSessionStatusPresentation({
    mode: 'factory',
    status: 'running',
    historyState: 'saved',
  });
  assert.equal(factorySavedWhileRunning.label, 'Plano salvo');
  assert.doesNotMatch(factorySavedWhileRunning.dotClass, /animate-pulse/);

  const reviewExitedSaved = getSessionStatusPresentation({
    mode: 'review',
    status: 'exited',
    historyState: 'saved',
  });
  assert.equal(reviewExitedSaved.label, 'Concluída');
  assert.equal(reviewExitedSaved.textClass, 'text-accent');

  const reviewExitedIncomplete = getSessionStatusPresentation({
    mode: 'review',
    status: 'exited',
    historyState: 'incomplete',
  });
  assert.equal(reviewExitedIncomplete.label, 'Parecer incompleto');
  assert.equal(reviewExitedIncomplete.textClass, 'text-warning');

  const factoryExitedIncomplete = getSessionStatusPresentation({
    mode: 'factory',
    status: 'exited',
    historyState: 'pending',
  });
  assert.equal(factoryExitedIncomplete.label, 'Plano incompleto');
  assert.equal(factoryExitedIncomplete.textClass, 'text-warning');

  const failed = getSessionStatusPresentation({
    mode: 'review',
    status: 'failed',
    historyState: 'incomplete',
  });
  assert.equal(failed.label, 'Falhou');
  assert.equal(failed.textClass, 'text-danger');

  const cancelled = getSessionStatusPresentation({
    mode: 'factory',
    status: 'cancelled',
    historyState: 'incomplete',
  });
  assert.equal(cancelled.label, 'Cancelada');
  assert.equal(cancelled.textClass, 'text-warning');
});

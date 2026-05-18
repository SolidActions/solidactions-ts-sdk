import type { InvokeResult } from './types';

/**
 * Minimal interface capturing the per-backend policy for what to DO with an InvokeResult.
 *
 * One-shot backends (Daytona) only need exitCodeFor; resident backends (Spec B) only need handle.
 * Both are optional on the base interface so that each concrete impl declares only what it owns,
 * while still conforming to a single named type. Spec B will extend the resident side in its own spec.
 */
export interface RuntimeAdapter {
  exitCodeFor?: (result: InvokeResult) => number;
  handle?: (result: InvokeResult) => InvokeResult;
}

export interface OneShotRuntimeAdapter extends RuntimeAdapter {
  exitCodeFor: (result: InvokeResult) => number;
}

export interface ResidentRuntimeAdapter extends RuntimeAdapter {
  handle: (result: InvokeResult) => InvokeResult;
}

export const oneShotRuntimeAdapter: OneShotRuntimeAdapter = {
  exitCodeFor(result: InvokeResult): number {
    switch (result.status) {
      case 'completed':
        return 0;
      case 'failed':
        return 1;
      case 'suspended':
        return 0;
      default: {
        const _exhaustive: never = result;
        return _exhaustive;
      }
    }
  },
};

export const residentRuntimeAdapter: ResidentRuntimeAdapter = {
  handle(result: InvokeResult): InvokeResult {
    return result;
  },
};

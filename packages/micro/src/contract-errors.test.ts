import { describe, expect, it } from 'vitest';
import { Exception } from '@hile/message-modem';
import { MICRO_CONTRACT_ERROR_STATUS } from '@hile/micro-contract';
import {
  isNeutralMicroError,
  isNonRetryableMicroError,
  MICRO_EXECUTION_FAILED,
} from './contract-errors.js';

describe('Micro contract retry classification', () => {
  it('does not replay an execution failure that may contain a committed nested operation', () => {
    const error = new Exception(MICRO_EXECUTION_FAILED, 'Micro operation failed');
    expect(isNonRetryableMicroError(error)).toBe(true);
    expect(isNeutralMicroError(error)).toBe(false);
  });

  it('preserves native unknown errors for the existing retry policy', () => {
    expect(isNonRetryableMicroError(new Error('native execution error'))).toBe(false);
    expect(isNonRetryableMicroError(new Exception(500, 'native server error'))).toBe(false);
    expect(isNonRetryableMicroError(new Exception('ETIMEDOUT', 'native timeout'))).toBe(false);
  });

  it('preserves validation failure classification', () => {
    for (const status of Object.values(MICRO_CONTRACT_ERROR_STATUS)) {
      const error = new Exception(status, 'Micro contract validation failed');
      expect(isNonRetryableMicroError(error)).toBe(true);
      expect(isNeutralMicroError(error)).toBe(status === MICRO_CONTRACT_ERROR_STATUS.invalidRequest);
    }
  });
});

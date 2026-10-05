/**
 * A message that cannot be applied because of what it says (unknown patient,
 * order mismatch, slot taken), as opposed to a bug or an outage. The integration
 * monitor stores `code` and `message` against the message so an operator can
 * see why it was rejected.
 */
export class ProcessingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProcessingError';
  }
}

/** Thrown by a worker command for bad arguments; reported as `invalid_request`, not committed. */
export class InvalidCommandArgumentsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCommandArgumentsError";
  }
}

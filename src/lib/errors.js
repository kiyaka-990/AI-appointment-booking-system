export class AppError extends Error {
  constructor(code, userMessage, options = {}) {
    super(options.technicalMessage ?? userMessage);
    this.name = 'AppError';
    this.code = code;
    this.userMessage = userMessage;
    this.status = options.status ?? 400;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? null;
    this.expose = options.expose ?? true;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.userMessage,
      retryable: this.retryable,
      details: this.details
    };
  }
}

export const ERROR_CODES = {
  MISSING_INFORMATION: 'MISSING_INFORMATION',
  INVALID_DATETIME: 'INVALID_DATETIME',
  OUTSIDE_WORKING_HOURS: 'OUTSIDE_WORKING_HOURS',
  TOO_SOON: 'TOO_SOON',
  TOO_FAR_AHEAD: 'TOO_FAR_AHEAD',
  NO_AVAILABILITY: 'NO_AVAILABILITY',
  SLOT_TAKEN: 'SLOT_TAKEN',
  DUPLICATE_BOOKING: 'DUPLICATE_BOOKING',
  BOOKING_NOT_FOUND: 'BOOKING_NOT_FOUND',
  BOOKING_ALREADY_CANCELLED: 'BOOKING_ALREADY_CANCELLED',
  CALENDAR_UNAVAILABLE: 'CALENDAR_UNAVAILABLE',
  CRM_UNAVAILABLE: 'CRM_UNAVAILABLE',
  NOTIFICATION_FAILED: 'NOTIFICATION_FAILED',
  OUT_OF_SCOPE: 'OUT_OF_SCOPE',
  UNKNOWN_SERVICE: 'UNKNOWN_SERVICE',
  AI_UNAVAILABLE: 'AI_UNAVAILABLE',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHORISED: 'UNAUTHORISED',
  NOT_FOUND: 'NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  WEBHOOK_UNAVAILABLE: 'WEBHOOK_UNAVAILABLE'
};

export function missingInformation(fields) {
  const labels = fields.map((field) => field.label).join(', ');
  return new AppError(
    ERROR_CODES.MISSING_INFORMATION,
    `I still need ${labels} before I can book that in.`,
    { details: { fields: fields.map((field) => field.key) } }
  );
}

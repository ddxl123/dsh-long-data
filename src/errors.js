/**
 * The one error type the Host halves share.
 *
 * A `DataError` is an expected, reportable failure: an unreachable service, a
 * refused password, a rejected statement. It carries a stable machine `code`
 * (the browser and the tools branch on it) plus optional `details` (the field
 * that failed validation, the SQLSTATE the server returned, the stderr tail).
 *
 * Anything else that escapes a service module is a bug: the ops layer reports
 * it as `internal_error` and logs it, without leaking a stack trace to the
 * caller.
 *
 * @module dsh-long-data/src/errors
 */

/**
 * An expected failure with a machine-readable reason.
 */
export class DataError extends Error {
  /**
   * @param {string} code - stable machine-readable reason, e.g. `redis_unreachable`.
   * @param {string} message - one human-readable line.
   * @param {Record<string, unknown>} [details] - structured context.
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'DataError'
    this.code = code
    this.details = details !== null && typeof details === 'object' ? details : {}
  }
}

/**
 * @param {unknown} error - a thrown value.
 * @returns {error is DataError} whether this is one of ours.
 */
export function isDataError(error) {
  return error instanceof DataError
}

/**
 * @param {unknown} error - a thrown value.
 * @returns {string} a one-line description safe for a notice.
 */
export function describeError(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Wrap an arbitrary failure as a `DataError`, preserving it when it already is one.
 *
 * @param {unknown} error - the thrown value.
 * @param {string} fallbackCode - code to use when `error` is not a `DataError`.
 * @param {string} [context] - prefix for a non-DataError message.
 * @returns {DataError} the wrapped failure.
 */
export function asDataError(error, fallbackCode, context) {
  if (isDataError(error)) return error
  const message = describeError(error)
  return new DataError(fallbackCode, context === undefined ? message : `${context}: ${message}`)
}

/**
 * Reject a request payload that is not a plain object.
 *
 * @param {unknown} payload - the value the caller sent.
 * @param {string} [what] - label used in the message.
 * @returns {Record<string, unknown>} the same value, typed as a record.
 */
export function requireObject(payload, what = 'payload') {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new DataError('invalid_payload', `${what} must be an object`, { field: what })
  }
  return /** @type {Record<string, unknown>} */ (payload)
}

/**
 * Read a required non-empty string field.
 *
 * @param {Record<string, unknown>} payload - the request payload.
 * @param {string} field - property name.
 * @param {number} [maxLength] - upper bound after trimming.
 * @returns {string} the trimmed value.
 */
export function requireString(payload, field, maxLength = 4096) {
  const value = payload[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DataError('invalid_payload', `"${field}" must be a non-empty string`, { field })
  }
  const trimmed = value.trim()
  if (trimmed.length > maxLength) {
    throw new DataError('invalid_payload', `"${field}" must be at most ${maxLength} characters`, {
      field,
      limit: maxLength,
      length: trimmed.length,
    })
  }
  return trimmed
}

/**
 * Read an optional integer field with bounds.
 *
 * @param {Record<string, unknown>} payload - the request payload.
 * @param {string} field - property name.
 * @param {number} fallback - value used when the field is absent.
 * @param {number} min - inclusive lower bound.
 * @param {number} max - inclusive upper bound.
 * @returns {number} the bounded integer.
 */
export function optionalInteger(payload, field, fallback, min, max) {
  const value = payload[field]
  if (value === undefined || value === null || value === '') return fallback
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new DataError('invalid_payload', `"${field}" must be an integer between ${min} and ${max}`, { field, min, max })
  }
  return number
}

/**
 * Read an optional boolean field.
 *
 * @param {Record<string, unknown>} payload - the request payload.
 * @param {string} field - property name.
 * @param {boolean} [fallback] - value used when the field is absent.
 * @returns {boolean} the switch.
 */
export function optionalBoolean(payload, field, fallback = false) {
  const value = payload[field]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') {
    throw new DataError('invalid_payload', `"${field}" must be a boolean`, { field })
  }
  return value
}

export default { DataError, describeError, asDataError, isDataError, requireObject, requireString, optionalInteger, optionalBoolean }

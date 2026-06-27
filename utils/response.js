export const sendSuccess = (res, statusCode, message, data = null) => {
  if (process.env.NODE_ENV !== "production") {
    console.log("[API]", statusCode, message)
  }
  return res.status(statusCode).json({
    success: true,
    message,
    data,
  })
}

export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next)

export const createError = (statusCode, message, details = null) => {
  const error = new Error(message)
  error.statusCode = statusCode
  if (details) {
    error.details = details
  }
  return error
}

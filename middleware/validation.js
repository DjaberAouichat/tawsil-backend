import { createError } from "../utils/response.js"

export const validateRequest = (schema) => {
  return (req, res, next) => {
    try {
      const payload = {
        body: req.body,
        params: req.params,
        query: req.query,
      }

      const schemaShape = getSchemaShape(schema)
      const expectsRequestShape =
        schemaShape &&
        (Object.prototype.hasOwnProperty.call(schemaShape, "body") ||
          Object.prototype.hasOwnProperty.call(schemaShape, "params") ||
          Object.prototype.hasOwnProperty.call(schemaShape, "query"))

      const result = expectsRequestShape ? schema.safeParse(payload) : schema.safeParse(req.body)

      if (!result.success) {
        const issues = result.error.issues || result.error.errors || []
        const errors = issues.map((err) => ({
          field: err.path.join("."),
          message: err.message,
        }))

        const failureReason =
          errors.length > 0
            ? errors.map((err) => `${err.field ? `${err.field}: ` : ""}${err.message}`).join("; ")
            : "Validation error"

        return next(createError(400, failureReason, errors))
      }

      if (expectsRequestShape) {
        if (result.data.body) {
          req.body = result.data.body
        }
        if (result.data.params) {
          req.params = result.data.params
        }
        if (result.data.query) {
          Object.assign(req.query, result.data.query)
        }
      } else {
        req.body = result.data
      }

      next()
    } catch (error) {
      next(createError(500, "Validation error"))
    }
  }
}

const getSchemaShape = (schema) => {
  if (!schema || !schema._def) {
    return null
  }

  const shape = schema._def.shape
  if (typeof shape === "function") {
    return shape()
  }

  if (shape && typeof shape === "object") {
    return shape
  }

  if (schema.shape && typeof schema.shape === "object") {
    return schema.shape
  }

  return null
}



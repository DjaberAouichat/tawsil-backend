import path from "path"

import { sendSuccess, createError } from "../utils/response.js"

const toPublicUrl = (req, relativeFilePath) => {
  const safeRelativePath = String(relativeFilePath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")

  return `${req.protocol}://${req.get("host")}/${safeRelativePath}`
}

export const uploadImage = async (req, res, next) => {
  try {
    if (!req.file) {
      return next(createError(400, "No image file provided"))
    }

    const fallbackRelativePath = path.posix.join("uploads", path.basename(req.file.path || ""))
    const imageRelativePath = req.uploadRelativePath || fallbackRelativePath
    const imageUrl = toPublicUrl(req, imageRelativePath)

    return sendSuccess(res, 201, "Image uploaded successfully", {
      imageUrl,
    })
  } catch (error) {
    next(error)
  }
}

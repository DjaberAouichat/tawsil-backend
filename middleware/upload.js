import fs from "fs"
import path from "path"
import multer from "multer"
import { fileURLToPath } from "url"

import { createError } from "../utils/response.js"

const currentFilePath = fileURLToPath(import.meta.url)
const currentDir = path.dirname(currentFilePath)
const uploadsRoot = path.resolve(currentDir, "..", "uploads")

const allowedImageTypes = new Map([
  ["image/jpeg", new Set([".jpg", ".jpeg"])],
  ["image/png", new Set([".png"])],
  ["image/gif", new Set([".gif"])],
  ["image/webp", new Set([".webp"])],
])

const defaultExtensionByMimeType = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
])

const allowedImageExtensions = new Set(
  [...allowedImageTypes.values()].flatMap((extensions) => [...extensions]),
)

const ensureDirectory = (targetPath) => {
  if (!fs.existsSync(targetPath)) {
    fs.mkdirSync(targetPath, { recursive: true })
  }
}

const sanitizeFolder = (value) => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()

  if (!normalized) {
    return "misc"
  }

  return normalized.replace(/[^a-z0-9_-]/g, "") || "misc"
}

const storage = multer.diskStorage({
destination: (req, _file, cb) => {
  // req.body قد يكون فارغاً مع multipart قبل المعالجة
  // لذا الأفضل الاعتماد على req.query فقط أو تمريره في URL
  const folder = sanitizeFolder(req.query?.folder)
    const targetPath = path.join(uploadsRoot, folder)
    ensureDirectory(targetPath)

    req.uploadFolder = folder
    cb(null, targetPath)
  },
  filename: (req, file, cb) => {
    const originalExtension = path.extname(file.originalname || "").toLowerCase()
    const mimeType = String(file.mimetype || "").toLowerCase()
    const extension = allowedImageExtensions.has(originalExtension)
      ? originalExtension
      : defaultExtensionByMimeType.get(mimeType) || ".jpg"
    const fileName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`
    req.uploadRelativePath = path.posix.join("uploads", req.uploadFolder || "misc", fileName)
    cb(null, fileName)
  },
})

const imageFileFilter = (_req, file, cb) => {
  const mimeType = String(file.mimetype || "").toLowerCase()
  const extension = path.extname(file.originalname || "").toLowerCase()
  const allowedExtensions = allowedImageTypes.get(mimeType)

  if (allowedExtensions && (!extension || allowedExtensions.has(extension))) {
    cb(null, true)
    return
  }

  if (mimeType === "application/octet-stream" && allowedImageExtensions.has(extension)) {
    cb(null, true)
    return
  }

  cb(createError(400, "Only matching JPG, PNG, GIF, or WEBP image uploads are allowed"))
}

const upload = multer({
  storage,
  fileFilter: imageFileFilter,
  limits: {
    fileSize: 8 * 1024 * 1024,
  },
}).single("image")

export const runImageUpload = (req, res, next) => {
  upload(req, res, (error) => {
    if (!error) {
      next()
      return
    }

    if (error instanceof multer.MulterError) {
      if (error.code === "LIMIT_FILE_SIZE") {
        next(createError(400, "Image size exceeds 8MB limit"))
        return
      }

      next(createError(400, "Invalid image upload request", { code: error.code }))
      return
    }

    next(error)
  })
}

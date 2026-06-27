import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"

const currentFilePath = fileURLToPath(import.meta.url)
const currentDir = path.dirname(currentFilePath)
const uploadsRoot = path.resolve(currentDir, "..", "uploads")

export const buildPublicUploadUrl = (req, relativeFilePath) => {
  const safeRelativePath = String(relativeFilePath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")

  return `${req.protocol}://${req.get("host")}/${safeRelativePath}`
}

export const resolveLocalUploadPath = (uploadUrl) => {
  if (!uploadUrl) {
    return null
  }

  try {
    const pathname = decodeURIComponent(new URL(String(uploadUrl)).pathname || "")
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")

    if (!pathname.startsWith("uploads/")) {
      return null
    }

    const relativePath = pathname.slice("uploads/".length)
    const absolutePath = path.resolve(uploadsRoot, relativePath)
    const relativeToRoot = path.relative(uploadsRoot, absolutePath)

    if (!relativeToRoot || relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
      return null
    }

    return absolutePath
  } catch {
    return null
  }
}

export const deleteLocalUploadFile = async (uploadUrl) => {
  const filePath = resolveLocalUploadPath(uploadUrl)
  if (!filePath) {
    return false
  }

  try {
    await fs.unlink(filePath)
    return true
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false
    }

    throw error
  }
}

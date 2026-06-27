const PRO_TRANSPORTER_KEYWORDS = [
  "frigo", "réfrigérateur", "fridge", "refrigerator",
  "machine à laver", "lave-linge", "washing machine",
  "canapé", "sofa", "divan", "meuble", "furniture",
  "armoire", "wardrobe", "cabinet", "buffet",
  "matelas", "mattress",
  "ciment", "cement", "brique", "brick", "sable", "sand", "gravier", "gravel",
  "matériaux", "materials", "construction",
  "climatiseur", "clim", "air conditioner", "air conditioning",
  "chauffe-eau", "water heater",
  "cuisinière", "gazinière", "cooker", "oven", "stove",
  "table", "table en verre", "glass table",
  "vélo", "bicycle", "bike",
  "moteur", "engine", "moto", "motorcycle",
  "piano", "instrument",
  "déménagement", "moving", "demenagement",
]

const PRO_TRANSPORTER_PACKAGE_TYPES = new Set([
  "heavy", "large", "furniture", "appliance",
])

const isSizeCategoryProTransporter = (sizeCategory) => {
  const size = String(sizeCategory || "").trim().toLowerCase()
  return size === "large" || size === "xlarge"
}

const isWeightProTransporter = (weightKg) => {
  if (weightKg == null) return false
  const w = Number(weightKg)
  return Number.isFinite(w) && w > 20
}

const isDescriptionProTransporter = (description) => {
  const text = String(description || "").trim().toLowerCase()
  if (!text) return false
  return PRO_TRANSPORTER_KEYWORDS.some((keyword) => text.includes(keyword))
}

const isPackageTypeProTransporter = (packageType) => {
  return PRO_TRANSPORTER_PACKAGE_TYPES.has(String(packageType || "").trim().toLowerCase())
}

export const determineDeliveryMode = ({ sizeCategory, weightKg, packageType, description }) => {
  const checks = {
    sizeCategory: isSizeCategoryProTransporter(sizeCategory),
    weight: isWeightProTransporter(weightKg),
    packageType: isPackageTypeProTransporter(packageType),
    description: isDescriptionProTransporter(description),
  }

  const isPro = checks.sizeCategory || checks.weight || checks.packageType || checks.description

  if (process.env.NODE_ENV !== 'production') {
    console.log("[Matching] determineDeliveryMode:", {
      sizeCategory,
      weightKg,
      packageType,
      checks,
      result: isPro ? "pro_transporter" : "standard",
    })
  }

  return {
    deliveryMode: isPro ? "pro_transporter" : "standard",
    pricingMode: isPro ? "PROFESSIONAL_DELIVERY" : "CROSS_SHIPPING",
    reasons: Object.entries(checks)
      .filter(([, v]) => v)
      .map(([k]) => k),
    isProTransporter: isPro,
  }
}

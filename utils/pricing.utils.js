
const SIZE_SURCHARGE = { small: 0, medium: 150, large: 400, xlarge: 900 }

const roundToNearest50 = (value) => Math.round(value / 50) * 50

const weightFee = (weightKg) => {
  const w = Math.max(0, Number(weightKg) || 0)
  if (w <= 2) return 0
  return (w - 2) * 20
}

export const calculateCrossShippingPrice = ({
  distanceKm,
  deviationKm = 0,
  sizeCategory,
  weightKg = 0,
  isInterWilaya = true,
}) => {
  const sd = Math.max(0, Number(distanceKm) || 0)
  const dd = Math.max(0, Number(deviationKm) || 0)

  const platformFee = 300
  const deviationCost = dd * 50
  const symbolicTrip = sd * 0.4
  const sizeSurcharge = SIZE_SURCHARGE[sizeCategory] || 0
  const weightSurcharge = weightFee(weightKg)
  const colisCost = sizeSurcharge + weightSurcharge

  const dynamicFloor = isInterWilaya ? 600 + colisCost : 400 + colisCost

  let rawPrice = platformFee + deviationCost + symbolicTrip + colisCost
  if (rawPrice < dynamicFloor) {
    rawPrice = dynamicFloor
  }

  const estimatedPrice = roundToNearest50(rawPrice)

  return {
    baseFee: platformFee,
    distanceFee: roundToNearest50(symbolicTrip),
    sizeSurcharge,
    weightSurcharge,
    deviationCost: roundToNearest50(deviationCost),
    urgentSurcharge: 0,
    estimatedPrice,
    mode: 'CROSS_SHIPPING',
    isBestDeal: dd <= 3,
  }
}

export const calculateProfessionalDeliveryPrice = ({
  distanceKm,
  sizeCategory,
  weightKg = 0,
  isUrgent = false,
}) => {
  const sd = Math.max(0, Number(distanceKm) || 0)

  const baseFee = 600
  const distanceFee = sd * 18
  const sizeSurcharge = SIZE_SURCHARGE[sizeCategory] || 0
  const weightSurcharge = Math.max(0, (Number(weightKg) || 0) - 2) * 45

  let rawPrice = baseFee + distanceFee + sizeSurcharge + weightSurcharge

  if (isUrgent) {
    rawPrice = rawPrice * 1.30
  }

  const minPrice = 1200
  if (rawPrice < minPrice) {
    rawPrice = minPrice
  }

  const estimatedPrice = roundToNearest50(rawPrice)

  return {
    baseFee,
    distanceFee: roundToNearest50(distanceFee),
    sizeSurcharge,
    weightSurcharge: roundToNearest50(weightSurcharge),
    urgentSurcharge: isUrgent ? roundToNearest50(rawPrice - (rawPrice / 1.30)) : 0,
    deviationCost: 0,
    estimatedPrice,
    mode: 'PROFESSIONAL_DELIVERY',
    isBestDeal: false,
  }
}

export const calculateDriverScore = ({
  routeEfficiency = 0,
  rating = 0,
  acceptanceRate = 0,
  completionRate = 0,
}) => {
  return (routeEfficiency * 0.5) * (rating * 0.3) * (acceptanceRate * 0.1) * (completionRate * 0.1)
}

export const selectBestDriver = (drivers) => {
  if (!drivers || drivers.length === 0) return null
  let best = null
  let bestScore = -1
  for (const d of drivers) {
    const score = calculateDriverScore({
      routeEfficiency: d.routeEfficiency || 0,
      rating: d.rating || 0,
      acceptanceRate: d.acceptanceRate || 0,
      completionRate: d.completionRate || 0,
    })
    if (score > bestScore) {
      bestScore = score
      best = { ...d, score }
    }
  }
  return best
}

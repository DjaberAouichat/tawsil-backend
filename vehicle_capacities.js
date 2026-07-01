export const VEHICLE_CATEGORIES = {
  // ── Personal vehicles (for normal_driver) ──
  city_car: {
    id: 'city_car',
    group: 'personal',
    labelFr: 'Voiture citadine',
    maxWeightKg: 80,
    maxSizeLevel: 2,
    maxSizeLabel: 'Moyenne',
    maxVolumeL: 400,
  },
  sedan: {
    id: 'sedan',
    group: 'personal',
    labelFr: 'Berline',
    maxWeightKg: 120,
    maxSizeLevel: 2,
    maxSizeLabel: 'Moyenne',
    maxVolumeL: 500,
  },
  suv: {
    id: 'suv',
    group: 'personal',
    labelFr: 'SUV',
    maxWeightKg: 180,
    maxSizeLevel: 3,
    maxSizeLabel: 'Grande',
    maxVolumeL: 650,
  },
  estate: {
    id: 'estate',
    group: 'personal',
    labelFr: 'Break',
    maxWeightKg: 250,
    maxSizeLevel: 3,
    maxSizeLabel: 'Grande',
    maxVolumeL: 700,
  },
  minivan: {
    id: 'minivan',
    group: 'personal',
    labelFr: 'Monospace',
    maxWeightKg: 350,
    maxSizeLevel: 3,
    maxSizeLabel: 'Grande',
    maxVolumeL: 900,
  },
  light_pickup: {
    id: 'light_pickup',
    group: 'personal',
    labelFr: 'Pick-up léger',
    maxWeightKg: 500,
    maxSizeLevel: 4,
    maxSizeLabel: 'Très grande',
    maxVolumeL: 1200,
  },

  // ── Professional vehicles (for pro_transporter) ──
  van: {
    id: 'van',
    group: 'professional',
    labelFr: 'Fourgon',
    maxWeightKg: 1500,
    maxSizeLevel: 4,
    maxSizeLabel: 'Très grande',
    maxVolumeL: 8000,
  },
  light_truck: {
    id: 'light_truck',
    group: 'professional',
    labelFr: 'Camionnette',
    maxWeightKg: 2500,
    maxSizeLevel: 4,
    maxSizeLabel: 'Très grande',
    maxVolumeL: 12000,
  },
  truck_3_5t: {
    id: 'truck_3_5t',
    group: 'professional',
    labelFr: 'Camion 3.5T',
    maxWeightKg: 3500,
    maxSizeLevel: 4,
    maxSizeLabel: 'Très grande',
    maxVolumeL: 18000,
  },
  truck_7_5t: {
    id: 'truck_7_5t',
    group: 'professional',
    labelFr: 'Camion 7.5T',
    maxWeightKg: 7500,
    maxSizeLevel: 4,
    maxSizeLabel: 'Très grande',
    maxVolumeL: 35000,
  },
  semi_trailer: {
    id: 'semi_trailer',
    group: 'professional',
    labelFr: 'Semi-remorque',
    maxWeightKg: 25000,
    maxSizeLevel: 4,
    maxSizeLabel: 'Très grande',
    maxVolumeL: 90000,
  },
  refrigerated_truck: {
    id: 'refrigerated_truck',
    group: 'professional',
    labelFr: 'Camion frigorifique',
    maxWeightKg: 7500,
    maxSizeLevel: 4,
    maxSizeLabel: 'Très grande',
    maxVolumeL: 35000,
  },
  flatbed_truck: {
    id: 'flatbed_truck',
    group: 'professional',
    labelFr: 'Camion plateau',
    maxWeightKg: 12000,
    maxSizeLevel: 4,
    maxSizeLabel: 'Très grande',
    maxVolumeL: 40000,
  },
  dump_truck: {
    id: 'dump_truck',
    group: 'professional',
    labelFr: 'Camion benne',
    maxWeightKg: 15000,
    maxSizeLevel: 4,
    maxSizeLabel: 'Très grande',
    maxVolumeL: 20000,
  },
  container_carrier: {
    id: 'container_carrier',
    group: 'professional',
    labelFr: 'Porte-conteneurs',
    maxWeightKg: 30000,
    maxSizeLevel: 4,
    maxSizeLabel: 'Très grande',
    maxVolumeL: 70000,
  },
  car_carrier: {
    id: 'car_carrier',
    group: 'professional',
    labelFr: 'Porte-voitures',
    maxWeightKg: 20000,
    maxSizeLevel: 4,
    maxSizeLabel: 'Très grande',
    maxVolumeL: 50000,
  },
}

export const PERSONAL_VEHICLE_IDS = Object.values(VEHICLE_CATEGORIES)
  .filter((v) => v.group === 'personal')
  .map((v) => v.id)

export const PROFESSIONAL_VEHICLE_IDS = Object.values(VEHICLE_CATEGORIES)
  .filter((v) => v.group === 'professional')
  .map((v) => v.id)

export const PERSONAL_VEHICLES = Object.values(VEHICLE_CATEGORIES).filter((v) => v.group === 'personal')
export const PROFESSIONAL_VEHICLES = Object.values(VEHICLE_CATEGORIES).filter((v) => v.group === 'professional')

export const getVehiclesForDriverType = (driverType) => {
  if (driverType === 'pro_transporter') return PROFESSIONAL_VEHICLES
  return PERSONAL_VEHICLES
}

export const getVehicleCategory = (vehicleTypeId) => {
  return VEHICLE_CATEGORIES[vehicleTypeId] || null
}

export const validateVehicleType = (vehicleTypeId, driverType) => {
  const vehicle = getVehicleCategory(vehicleTypeId)
  if (!vehicle) {
    return { valid: false, error: 'Le véhicule sélectionné n\'est pas autorisé pour votre type de compte.' }
  }
  const allowedIds = driverType === 'pro_transporter' ? PROFESSIONAL_VEHICLE_IDS : PERSONAL_VEHICLE_IDS
  if (!allowedIds.includes(vehicleTypeId)) {
    return { valid: false, error: 'Le véhicule sélectionné n\'est pas autorisé pour votre type de compte.' }
  }
  return { valid: true, vehicle }
}

const PACKAGE_SIZE_LEVEL = { small: 1, medium: 2, large: 3, xlarge: 4 }
const LEVEL_TO_LABEL = { 1: 'small', 2: 'medium', 3: 'large', 4: 'xlarge' }

export const getMaxSizeLabel = (vehicleTypeId) => {
  const vehicle = getVehicleCategory(vehicleTypeId)
  return vehicle ? vehicle.maxSizeLabel : 'Moyenne'
}

export { PACKAGE_SIZE_LEVEL, LEVEL_TO_LABEL }

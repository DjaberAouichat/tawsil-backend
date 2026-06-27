export const DELIVERY_STATUS = {
  DRAFT: "Draft",
  PENDING: "Pending",
  ACCEPTED: "Accepted",
  DRIVER_ARRIVED_PICKUP: "DriverArrivedPickup",
  PICKED_UP: "PickedUp",
  IN_TRANSIT: "InTransit",
  ARRIVED_DROPOFF: "ArrivedDropoff",
  DELIVERED: "Delivered",
  CANCELLED_BY_USER: "CancelledByUser",
  CANCELLED_BY_DRIVER: "CancelledByDriver",
  REJECTED: "Rejected",
  FAILED_DELIVERY: "FailedDelivery",
  REFUNDED: "Refunded",
}

const ALLOWED_TRANSITIONS = {
  [DELIVERY_STATUS.DRAFT]: [DELIVERY_STATUS.PENDING, DELIVERY_STATUS.CANCELLED_BY_USER],
  // Per-driver rejections must use delivery.rejectedBy while keeping status Pending.
  // Global Rejected transition is intentionally disabled until a dedicated internal flow exists.
  [DELIVERY_STATUS.PENDING]: [
    DELIVERY_STATUS.ACCEPTED,
    DELIVERY_STATUS.CANCELLED_BY_USER,
  ],
  [DELIVERY_STATUS.ACCEPTED]: [
    DELIVERY_STATUS.DRIVER_ARRIVED_PICKUP,
    DELIVERY_STATUS.CANCELLED_BY_DRIVER,
    DELIVERY_STATUS.CANCELLED_BY_USER,
    DELIVERY_STATUS.FAILED_DELIVERY,
  ],
  [DELIVERY_STATUS.DRIVER_ARRIVED_PICKUP]: [
    DELIVERY_STATUS.PICKED_UP,
    DELIVERY_STATUS.CANCELLED_BY_DRIVER,
    DELIVERY_STATUS.FAILED_DELIVERY,
  ],
  [DELIVERY_STATUS.PICKED_UP]: [
    DELIVERY_STATUS.IN_TRANSIT,
    DELIVERY_STATUS.FAILED_DELIVERY,
  ],
  [DELIVERY_STATUS.IN_TRANSIT]: [
    DELIVERY_STATUS.ARRIVED_DROPOFF,
    DELIVERY_STATUS.FAILED_DELIVERY,
  ],
  [DELIVERY_STATUS.ARRIVED_DROPOFF]: [
    DELIVERY_STATUS.DELIVERED,
    DELIVERY_STATUS.FAILED_DELIVERY,
  ],
  [DELIVERY_STATUS.DELIVERED]: [DELIVERY_STATUS.REFUNDED],
  [DELIVERY_STATUS.CANCELLED_BY_USER]: [],
  [DELIVERY_STATUS.CANCELLED_BY_DRIVER]: [],
  [DELIVERY_STATUS.REJECTED]: [],
  [DELIVERY_STATUS.FAILED_DELIVERY]: [DELIVERY_STATUS.REFUNDED],
  [DELIVERY_STATUS.REFUNDED]: [],
}

export const canTransitionDeliveryStatus = (fromStatus, toStatus) => {
  const allowed = ALLOWED_TRANSITIONS[fromStatus] || []
  return allowed.includes(toStatus)
}

export const isTerminalDeliveryStatus = (status) => {
  return [
    DELIVERY_STATUS.DELIVERED,
    DELIVERY_STATUS.CANCELLED_BY_USER,
    DELIVERY_STATUS.CANCELLED_BY_DRIVER,
    DELIVERY_STATUS.REJECTED,
    DELIVERY_STATUS.FAILED_DELIVERY,
    DELIVERY_STATUS.REFUNDED,
  ].includes(status)
}

export const STATUS_DISPLAY_LABELS = {
  Draft: "Draft",
  Pending: "Pending",
  Accepted: "Accepted",
  DriverArrivedPickup: "Driver Arrived Pickup",
  PickedUp: "Picked Up",
  InTransit: "In Transit",
  ArrivedDropoff: "Arrived Dropoff",
  Delivered: "Delivered",
  CancelledByUser: "Cancelled by User",
  CancelledByDriver: "Cancelled by Driver",
  Rejected: "Rejected",
  FailedDelivery: "Failed Delivery",
  Refunded: "Refunded",
}

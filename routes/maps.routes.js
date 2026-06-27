import express from 'express';
import { 
  getDistance, 
  getDirections, 
  geocodeAddress, 
  reverseGeocode
} from '../utils/maps.js';

const router = express.Router();

const sendRouteError = (res, error, fallbackMessage) => {
  const statusCode = error?.statusCode || 500
  return res.status(statusCode).json({
    success: false,
    message: error?.message || fallbackMessage,
    details: error?.details || null,
  })
}

const withPublicMapHandler = (label, fallbackMessage, handler) => {
  return async (req, res) => {
    try {
      await handler(req, res)
    } catch (error) {
      console.error(`Error in ${label} route:`, error)
      return sendRouteError(res, error, fallbackMessage)
    }
  }
}

router.post('/distance', withPublicMapHandler('distance', 'Failed to calculate distance', async (req, res) => {
    const { origin, destination } = req.body;
    
    if (!origin || !destination) {
      return res.status(400).json({
        success: false,
        message: 'Origin and destination are required'
      });
    }

    const result = await getDistance(origin, destination);
    
    res.json({
      success: true,
      data: result
    });
  }))

// Get directions between two points
router.post('/directions', withPublicMapHandler('directions', 'Failed to get directions', async (req, res) => {
  const { origin, destination, waypoints = [], includeStates, statesMinDistanceMeters, statesMaxSamples, alternatives } = req.body;
  
    if (!origin || !destination) {
      console.error(`[ROUTE STEP 0 ERROR] Missing origin or destination`)
      return res.status(400).json({
        success: false,
        message: 'Origin and destination are required'
      });
    }

    const result = await getDirections(origin, destination, waypoints, {
      includeStates: includeStates === true,
      minDistanceMeters: Number(statesMinDistanceMeters) || undefined,
      maxSamples: Number(statesMaxSamples) || undefined,
      alternatives: alternatives === true,
    });
    res.json({
      success: true,
      data: result
    });
  }))

// Geocode an address
router.post('/geocode', withPublicMapHandler('geocode', 'Failed to geocode address', async (req, res) => {
    const { address } = req.body;
    
    if (!address) {
      return res.status(400).json({
        success: false,
        message: 'Address is required'
      });
    }

    const result = await geocodeAddress(address);
    
    res.json({
      success: true,
      data: result
    });
  }))

// Reverse geocode coordinates
router.post('/reverse-geocode', withPublicMapHandler('reverse geocode', 'Failed to reverse geocode coordinates', async (req, res) => {
    const { coordinates } = req.body;
    
    if (!coordinates || !Array.isArray(coordinates) || coordinates.length !== 2) {
      return res.status(400).json({
        success: false,
        message: 'Valid coordinates [lng, lat] are required'
      });
    }

    const [lng, lat] = coordinates;
    const result = await reverseGeocode(lat, lng);
    
    res.json({
      success: true,
      data: result
    });
  }))


export default router;

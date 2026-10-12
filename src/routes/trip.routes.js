const router = require('express').Router();
const { query, body, param } = require('express-validator');
const validate = require('../middleware/validate');
const { success } = require('../utils/response');
const { isValidDate, todayIST } = require('../utils/time');
const tripService = require('../services/trip.service');
const seatService = require('../services/seat.service');

const tripId = param('id').isInt({ min: 1 }).withMessage('Invalid trip').toInt();

// GET /api/trips/search?from=&to=&date=
router.get('/search', validate([
  query('from').notEmpty().withMessage('Please select where you are travelling from'),
  query('to').notEmpty().withMessage('Please select your destination'),
  query('date').custom(v => isValidDate(v)).withMessage('Please select a valid travel date')
    .custom(v => v >= todayIST()).withMessage('Travel date cannot be in the past'),
  query('to').custom((v, { req }) => String(v) !== String(req.query.from)).withMessage('From and To cannot be the same'),
]), async (req, res, next) => {
  try {
    const result = await tripService.searchTrips(req.query);
    return success(res, result, result.trips.length ? 'Trips found' : 'No trips found for this route');
  } catch (err) { next(err); }
});

// GET /api/trips/:id - trip detail with stops (trip times) and segment fares
router.get('/:id', validate([tripId]), async (req, res, next) => {
  try { return success(res, await tripService.getTripDetail(req.params.id)); } catch (err) { next(err); }
});

// GET /api/trips/:id/fare?boarding_stop_id=&dropping_stop_id= - server-side fare for a segment
router.get('/:id/fare', validate([
  tripId,
  query('boarding_stop_id').isInt({ min: 1 }).withMessage('Select a boarding point').toInt(),
  query('dropping_stop_id').isInt({ min: 1 }).withMessage('Select a dropping point').toInt(),
]), async (req, res, next) => {
  try {
    const trip = await tripService.getTripCore(req.params.id);
    tripService.assertTripBookable(trip);
    const seg = await tripService.resolveSegment(trip, req.query.boarding_stop_id, req.query.dropping_stop_id);
    return success(res, {
      boarding_stop_id: seg.boarding.id, dropping_stop_id: seg.dropping.id,
      boarding_at: seg.boarding.departure_at, dropping_at: seg.dropping.arrival_at,
      fare_per_seat: seg.fare_per_seat,
    });
  } catch (err) { next(err); }
});

// GET /api/trips/:id/seats?lock_token=
router.get('/:id/seats', validate([tripId]), async (req, res, next) => {
  try { return success(res, await seatService.getSeatMap(req.params.id, req.query.lock_token || null)); } catch (err) { next(err); }
});

// POST /api/trips/:id/seats/lock { seat_ids, lock_token? }
router.post('/:id/seats/lock', validate([
  tripId,
  body('seat_ids').isArray({ min: 1 }).withMessage('Select at least one seat'),
]), async (req, res, next) => {
  try {
    const result = await seatService.lockSeats(req.params.id, req.body.seat_ids, req.body.lock_token);
    return success(res, result, 'Seats held for you');
  } catch (err) { next(err); }
});

// POST /api/trips/:id/seats/release { lock_token }
router.post('/:id/seats/release', validate([tripId]), async (req, res, next) => {
  try {
    const released = await seatService.releaseLocks(req.params.id, req.body.lock_token);
    return success(res, { released });
  } catch (err) { next(err); }
});

module.exports = router;

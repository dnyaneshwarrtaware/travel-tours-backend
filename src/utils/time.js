/**
 * Time helpers for route stop schedules.
 *
 * Route stops store reference arrival/departure TIMEs. A trip may depart at a
 * different time (and take longer/shorter), so stop times for a trip are
 * derived from the stop offsets relative to the first stop, shifted to the
 * trip's departure and scaled to the trip's arrival time when one is set.
 * Overnight routes are handled by rolling times over midnight.
 */

const toMinutes = (t) => {
  if (!t) return null;
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + (m || 0);
};

const fromMinutes = (mins) => {
  const m = ((Math.round(mins) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`;
};

// Adds minutes to a 'YYYY-MM-DD' + 'HH:MM:SS' pair, returns 'YYYY-MM-DD HH:MM:SS'
const addMinutesToDateTime = (date, time, minutes) => {
  const [y, mo, d] = date.split('-').map(Number);
  const base = Date.UTC(y, mo - 1, d) + (toMinutes(time) + minutes) * 60000;
  const dt = new Date(base);
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())} ${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:00`;
};

/**
 * Monotonic offsets (minutes from the first stop's departure) for ordered stops.
 * Returns [{ arrival_offset, departure_offset }] aligned with `stops`.
 */
const stopOffsets = (stops) => {
  let prev = null;
  let base = null;
  const roll = (t) => {
    let m = toMinutes(t);
    if (m === null) return null;
    if (prev !== null) { while (m < prev) m += 1440; }
    prev = m;
    return m;
  };
  return stops.map((s, i) => {
    const arr = roll(s.arrival_time || (i === 0 ? s.departure_time : null));
    const dep = roll(s.departure_time || s.arrival_time);
    if (base === null) base = dep ?? arr ?? 0;
    return {
      arrival_offset: arr === null ? null : arr - base,
      departure_offset: dep === null ? null : dep - base,
    };
  });
};

/**
 * Trip-specific schedule for each stop.
 * trip: { travel_date, departure_time, arrival_time? }
 * stops: ordered route stops (with arrival_time/departure_time)
 */
const tripStopSchedule = (trip, stops) => {
  if (!stops.length) return [];
  const offsets = stopOffsets(stops);
  const routeDuration = offsets[offsets.length - 1].arrival_offset ?? offsets[offsets.length - 1].departure_offset ?? 0;

  let scale = 1;
  if (trip.arrival_time && routeDuration > 0) {
    let tripDuration = toMinutes(trip.arrival_time) - toMinutes(trip.departure_time);
    while (tripDuration <= 0) tripDuration += 1440;
    // Only rescale for plausible durations (protects against bad data)
    if (tripDuration < 3 * 1440) scale = tripDuration / routeDuration;
  }

  return stops.map((s, i) => {
    const o = offsets[i];
    const arr = o.arrival_offset === null ? null : Math.round(o.arrival_offset * scale);
    const dep = o.departure_offset === null ? null : Math.round(o.departure_offset * scale);
    return {
      ...s,
      arrival_offset: arr,
      departure_offset: dep,
      arrival_at: arr === null || i === 0 ? null : addMinutesToDateTime(trip.travel_date, trip.departure_time, arr),
      departure_at: dep === null || i === stops.length - 1 ? null : addMinutesToDateTime(trip.travel_date, trip.departure_time, dep),
    };
  });
};

// Current date/time in IST as 'YYYY-MM-DD HH:MM:SS' (comparable with schedule strings)
const nowIST = () => {
  const d = new Date(Date.now() + 330 * 60000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
};

const todayIST = () => nowIST().slice(0, 10);

const isValidDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const isValidTime = (s) => /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(s);
const normalizeTime = (s) => (s && s.length === 5 ? `${s}:00` : s);

module.exports = {
  toMinutes, fromMinutes, addMinutesToDateTime, stopOffsets, tripStopSchedule,
  nowIST, todayIST, isValidDate, isValidTime, normalizeTime,
};

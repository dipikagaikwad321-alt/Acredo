'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const helmet = require('helmet');

const CITIES = new Set([
  'Pune', 'Mumbai', 'Nashik', 'Satara', 'Kolhapur', 'Nagpur',
  'Ahmedabad', 'Bengaluru', 'Hyderabad',
]);
const STATUSES = new Set(['MATCHING', 'MATCHED', 'PICKED_UP', 'IN_TRANSIT', 'ARRIVED', 'DELIVERED']);
const TRACKING_PAGE = path.resolve(__dirname, 'Acredo_Traveller (1).html');
const DEMO_TRAVELLERS = [
  ['rohan-deshmukh', 'Rohan Deshmukh', 95, 94, 128, 4.9, 'Hyundai Creta, white', 'Boot, 2 free bags', '07:30'],
  ['sneha-kulkarni', 'Sneha Kulkarni', 92, 88, 74, 4.8, 'Maruti Baleno, grey', 'Back seat and boot', '11:15'],
  ['aditya-joshi', 'Aditya Joshi', 88, 81, 52, 4.7, 'Honda City, silver', 'Boot, 1 free bag', '06:50'],
];

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest();
}

function sameHash(left, right) {
  const a = sha256(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function createDatabase(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS travellers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      route_from TEXT NOT NULL,
      route_to TEXT NOT NULL,
      match_score INTEGER NOT NULL,
      trust_score INTEGER NOT NULL,
      completed_deliveries INTEGER NOT NULL,
      rating REAL NOT NULL,
      vehicle TEXT NOT NULL,
      available_space TEXT NOT NULL,
      departure_time TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      tracking_id TEXT NOT NULL UNIQUE,
      pickup_city TEXT NOT NULL,
      destination_city TEXT NOT NULL,
      pickup_address TEXT NOT NULL,
      delivery_address TEXT NOT NULL,
      parcel_name TEXT NOT NULL,
      category TEXT NOT NULL,
      weight REAL NOT NULL,
      length REAL NOT NULL,
      width REAL NOT NULL,
      height REAL NOT NULL,
      deadline TEXT NOT NULL,
      reward INTEGER NOT NULL,
      notes TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('MATCHING', 'MATCHED', 'PICKED_UP', 'IN_TRANSIT', 'ARRIVED', 'DELIVERED')),
      traveller_id TEXT REFERENCES travellers(id),
      pickup_otp_hash BLOB,
      delivery_otp_hash BLOB,
      pickup_attempts INTEGER NOT NULL DEFAULT 0,
      delivery_attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS booking_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id TEXT NOT NULL REFERENCES bookings(id),
      status TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trips (
      id TEXT PRIMARY KEY,
      pickup_city TEXT NOT NULL,
      destination_city TEXT NOT NULL,
      travel_date TEXT NOT NULL,
      departure_time TEXT NOT NULL,
      space INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL UNIQUE REFERENCES bookings(id),
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      tags TEXT NOT NULL,
      comment TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  const travellerColumns = new Set(db.prepare('PRAGMA table_info(travellers)').all().map((column) => column.name));
  if (!travellerColumns.has('route_from')) {
    db.exec("ALTER TABLE travellers ADD COLUMN route_from TEXT NOT NULL DEFAULT 'Pune'");
  }
  if (!travellerColumns.has('route_to')) {
    db.exec("ALTER TABLE travellers ADD COLUMN route_to TEXT NOT NULL DEFAULT 'Mumbai'");
  }

  const insertTraveller = db.prepare(`
    INSERT OR IGNORE INTO travellers
      (id, name, route_from, route_to, match_score, trust_score, completed_deliveries, rating, vehicle, available_space, departure_time)
    VALUES (?, ?, 'Pune', 'Mumbai', ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const traveller of DEMO_TRAVELLERS) insertTraveller.run(...traveller);
  return db;
}

function makeError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function requiredString(value, label, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    throw makeError(400, `${label} is required and must be at most ${maxLength} characters.`);
  }
  return value.trim();
}

function validDate(value, label, allowPast = false) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw makeError(400, `${label} must use YYYY-MM-DD format.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw makeError(400, `${label} is not a valid date.`);
  }
  const today = new Date().toISOString().slice(0, 10);
  if (!allowPast && value < today) throw makeError(400, `${label} cannot be in the past.`);
  return value;
}

function finiteNumber(value, label, min, max, integer = false) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) {
    throw makeError(400, `${label} must be between ${min} and ${max}${integer ? ' (whole number)' : ''}.`);
  }
  return number;
}

function bookingFromRow(row) {
  return {
    id: row.id,
    trackingId: row.tracking_id,
    pickupCity: row.pickup_city,
    destinationCity: row.destination_city,
    parcelName: row.parcel_name,
    category: row.category,
    weight: row.weight,
    dimensions: { length: row.length, width: row.width, height: row.height },
    deadline: row.deadline,
    reward: row.reward,
    status: row.status,
    travellerId: row.traveller_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createApp(options = {}) {
  const db = createDatabase(options.dbPath || process.env.DATABASE_PATH || path.join(__dirname, 'data', 'acredo.sqlite'));
  const app = express();
  const isProduction = process.env.NODE_ENV === 'production';
  const now = () => new Date().toISOString();

  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  }));
  app.use(express.json({ limit: '100kb', type: 'application/json' }));
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/') && ['POST', 'PUT', 'PATCH'].includes(req.method)) {
      if (!req.is('application/json')) return res.status(415).json({ error: 'Send this request as application/json.' });
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        return res.status(400).json({ error: 'A JSON object request body is required.' });
      }
    }
    next();
  });

  function findBooking(trackingId) {
    const row = db.prepare('SELECT * FROM bookings WHERE tracking_id = ?').get(trackingId);
    if (!row) throw makeError(404, 'Booking not found.');
    return row;
  }

  function addEvent(bookingId, status, detail) {
    db.prepare('INSERT INTO booking_events (booking_id, status, detail, created_at) VALUES (?, ?, ?, ?)')
      .run(bookingId, status, detail, now());
  }

  function otpResponse(code) {
    return isProduction ? {} : { debugOtp: code };
  }

  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

  app.get('/api/travellers', (req, res) => {
    const from = req.query.from;
    const to = req.query.to;
    if (from && !CITIES.has(from)) throw makeError(400, 'Unknown pickup city.');
    if (to && !CITIES.has(to)) throw makeError(400, 'Unknown destination city.');
    const travellers = db.prepare(`
      SELECT * FROM travellers
      WHERE (? IS NULL OR route_from = ?) AND (? IS NULL OR route_to = ?)
      ORDER BY match_score DESC
    `).all(from || null, from || null, to || null, to || null);
    res.json({ travellers });
  });

  app.get('/api/trips', (req, res) => {
    const from = req.query.from;
    const to = req.query.to;
    if (from && !CITIES.has(from)) throw makeError(400, 'Unknown pickup city.');
    if (to && !CITIES.has(to)) throw makeError(400, 'Unknown destination city.');
    const rows = db.prepare(`
      SELECT * FROM trips
      WHERE (? IS NULL OR pickup_city = ?) AND (? IS NULL OR destination_city = ?)
      ORDER BY travel_date, departure_time
    `).all(from || null, from || null, to || null, to || null);
    res.json({
      trips: rows.map((trip) => ({
        id: trip.id,
        from: trip.pickup_city,
        to: trip.destination_city,
        travelDate: trip.travel_date,
        departureTime: trip.departure_time,
        space: trip.space,
        createdAt: trip.created_at,
      })),
    });
  });

  app.post('/api/trips', (req, res) => {
    const from = requiredString(req.body.from, 'From city', 40);
    const to = requiredString(req.body.to, 'To city', 40);
    if (!CITIES.has(from) || !CITIES.has(to)) throw makeError(400, 'Choose cities from the supported list.');
    if (from === to) throw makeError(400, 'From and destination cities must be different.');
    const travelDate = validDate(req.body.travelDate, 'Travel date');
    const departureTime = requiredString(req.body.departureTime, 'Departure time', 5);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(departureTime)) throw makeError(400, 'Departure time must use HH:MM format.');
    const space = finiteNumber(req.body.space, 'Space', 1, 3, true);
    const id = crypto.randomUUID();
    const createdAt = now();
    db.prepare(`
      INSERT INTO trips (id, pickup_city, destination_city, travel_date, departure_time, space, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, from, to, travelDate, departureTime, space, createdAt);
    res.status(201).json({ trip: { id, from, to, travelDate, departureTime, space, createdAt } });
  });

  app.post('/api/bookings', (req, res) => {
    const body = req.body;
    const pickupCity = requiredString(body.pickupCity, 'Pickup city', 40);
    const destinationCity = requiredString(body.destinationCity, 'Destination city', 40);
    if (!CITIES.has(pickupCity) || !CITIES.has(destinationCity)) throw makeError(400, 'Choose cities from the supported list.');
    if (pickupCity === destinationCity) throw makeError(400, 'Pickup and destination cities must be different.');
    const pickupAddress = requiredString(body.pickupAddress, 'Pickup address', 300);
    const deliveryAddress = requiredString(body.deliveryAddress, 'Delivery address', 300);
    const parcelName = requiredString(body.parcelName, 'Parcel name', 100);
    const category = requiredString(body.category, 'Category', 80);
    const weight = finiteNumber(body.weight, 'Weight', 0.1, 15);
    const dimensions = body.dimensions || {};
    const length = finiteNumber(dimensions.length, 'Length', 1, 100);
    const width = finiteNumber(dimensions.width, 'Width', 1, 100);
    const height = finiteNumber(dimensions.height, 'Height', 1, 100);
    const deadline = validDate(body.deadline, 'Deadline');
    const reward = finiteNumber(body.reward, 'Reward', 100, 100000, true);
    const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 1000) : '';
    const id = crypto.randomUUID();
    const trackingId = `ACR-${crypto.randomBytes(12).toString('hex').toUpperCase()}`;
    const createdAt = now();
    db.prepare(`
      INSERT INTO bookings (
        id, tracking_id, pickup_city, destination_city, pickup_address, delivery_address,
        parcel_name, category, weight, length, width, height, deadline, reward, notes,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'MATCHING', ?, ?)
    `).run(
      id, trackingId, pickupCity, destinationCity, pickupAddress, deliveryAddress,
      parcelName, category, weight, length, width, height, deadline, reward, notes, createdAt, createdAt,
    );
    addEvent(id, 'MATCHING', 'Booking created');
    res.status(201).json({ booking: bookingFromRow(findBooking(trackingId)) });
  });

  app.get('/api/bookings/:trackingId', (req, res) => {
    const row = findBooking(req.params.trackingId);
    const events = db.prepare('SELECT status, detail, created_at AS createdAt FROM booking_events WHERE booking_id = ? ORDER BY id')
      .all(row.id);
    res.json({ booking: bookingFromRow(row), events });
  });

  app.get('/api/bookings/:trackingId/matches', (req, res) => {
    const booking = findBooking(req.params.trackingId);
    if (!['MATCHING', 'MATCHED'].includes(booking.status)) throw makeError(409, 'Traveller matching is no longer available.');
    const travellers = db.prepare(`
      SELECT * FROM travellers WHERE route_from = ? AND route_to = ? ORDER BY match_score DESC
    `).all(booking.pickup_city, booking.destination_city);
    res.json({ travellers });
  });

  app.post('/api/bookings/:trackingId/accept', (req, res) => {
    const booking = findBooking(req.params.trackingId);
    if (booking.status !== 'MATCHING') throw makeError(409, 'This booking already has a traveller or has progressed.');
    const travellerId = requiredString(req.body.travellerId, 'Traveller ID', 80);
    const traveller = db.prepare('SELECT id, name FROM travellers WHERE id = ?').get(travellerId);
    if (!traveller) throw makeError(404, 'Traveller not found.');
    const pickupOtp = String(crypto.randomInt(0, 10000)).padStart(4, '0');
    const updatedAt = now();
    db.prepare(`
      UPDATE bookings SET status = 'MATCHED', traveller_id = ?, pickup_otp_hash = ?, updated_at = ? WHERE id = ?
    `).run(travellerId, sha256(pickupOtp), updatedAt, booking.id);
    addEvent(booking.id, 'MATCHED', `Traveller ${traveller.name} accepted`);
    res.json({ booking: bookingFromRow(findBooking(req.params.trackingId)), ...otpResponse(pickupOtp) });
  });

  app.post('/api/bookings/:trackingId/pickup', (req, res) => {
    const booking = findBooking(req.params.trackingId);
    if (booking.status !== 'MATCHED') throw makeError(409, 'A traveller must accept the booking before pickup.');
    if (booking.pickup_attempts >= 3) throw makeError(429, 'Pickup OTP attempts are exhausted.');
    const code = typeof req.body.code === 'string' ? req.body.code : '';
    if (!/^\d{4}$/.test(code) || !sameHash(code, booking.pickup_otp_hash)) {
      const attempts = booking.pickup_attempts + 1;
      db.prepare('UPDATE bookings SET pickup_attempts = ?, updated_at = ? WHERE id = ?').run(attempts, now(), booking.id);
      throw makeError(attempts >= 3 ? 429 : 400, attempts >= 3 ? 'Pickup OTP attempts are exhausted.' : `Pickup code is incorrect. ${3 - attempts} attempt(s) left.`);
    }
    const updatedAt = now();
    db.prepare(`UPDATE bookings SET status = 'PICKED_UP', pickup_otp_hash = NULL, updated_at = ? WHERE id = ?`)
      .run(updatedAt, booking.id);
    addEvent(booking.id, 'PICKED_UP', 'Pickup OTP verified');
    res.json({ booking: bookingFromRow(findBooking(req.params.trackingId)) });
  });

  app.post('/api/bookings/:trackingId/pickup/verify', (req, res) => {
    const booking = findBooking(req.params.trackingId);
    if (booking.status !== 'MATCHED') throw makeError(409, 'A traveller must accept the booking before pickup.');
    if (booking.pickup_attempts >= 3) throw makeError(429, 'Pickup OTP attempts are exhausted.');
    const code = typeof req.body.code === 'string' ? req.body.code : '';
    if (!/^\d{4}$/.test(code) || !sameHash(code, booking.pickup_otp_hash)) {
      const attempts = booking.pickup_attempts + 1;
      db.prepare('UPDATE bookings SET pickup_attempts = ?, updated_at = ? WHERE id = ?').run(attempts, now(), booking.id);
      throw makeError(attempts >= 3 ? 429 : 400, attempts >= 3 ? 'Pickup OTP attempts are exhausted.' : `Pickup code is incorrect. ${3 - attempts} attempt(s) left.`);
    }
    res.json({ verified: true });
  });

  app.post('/api/bookings/:trackingId/status', (req, res) => {
    const booking = findBooking(req.params.trackingId);
    const nextStatus = req.body.status;
    if (!STATUSES.has(nextStatus)) throw makeError(400, 'Unsupported booking status.');
    const allowed = { IN_TRANSIT: 'PICKED_UP', ARRIVED: 'IN_TRANSIT' };
    if (!allowed[nextStatus] || booking.status !== allowed[nextStatus]) {
      throw makeError(409, `Cannot change booking status from ${booking.status} to ${nextStatus}.`);
    }
    const updatedAt = now();
    db.prepare('UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?').run(nextStatus, updatedAt, booking.id);
    addEvent(booking.id, nextStatus, nextStatus === 'IN_TRANSIT' ? 'Parcel is in transit' : 'Parcel arrived at destination');
    if (nextStatus === 'ARRIVED') {
      const deliveryOtp = String(crypto.randomInt(0, 10000)).padStart(4, '0');
      db.prepare('UPDATE bookings SET delivery_otp_hash = ? WHERE id = ?').run(sha256(deliveryOtp), booking.id);
      res.json({ booking: bookingFromRow(findBooking(req.params.trackingId)), ...otpResponse(deliveryOtp) });
      return;
    }
    res.json({ booking: bookingFromRow(findBooking(req.params.trackingId)) });
  });

  app.post('/api/bookings/:trackingId/delivery', (req, res) => {
    const booking = findBooking(req.params.trackingId);
    if (booking.status !== 'ARRIVED') throw makeError(409, 'The parcel must arrive before delivery can be confirmed.');
    if (booking.delivery_attempts >= 3) throw makeError(429, 'Delivery OTP attempts are exhausted.');
    if (req.body.proofConfirmed !== true) throw makeError(400, 'Confirm delivery proof before completing the handover.');
    const receiverName = requiredString(req.body.receiverName, 'Receiver name', 100);
    const code = typeof req.body.code === 'string' ? req.body.code : '';
    const attempts = booking.delivery_attempts + 1;
    db.prepare('UPDATE bookings SET delivery_attempts = ?, updated_at = ? WHERE id = ?').run(attempts, now(), booking.id);
    if (!/^\d{4}$/.test(code) || !sameHash(code, booking.delivery_otp_hash)) {
      throw makeError(attempts >= 3 ? 429 : 400, attempts >= 3 ? 'Delivery OTP attempts are exhausted.' : `Delivery code is incorrect. ${3 - attempts} attempt(s) left.`);
    }
    const updatedAt = now();
    db.prepare(`UPDATE bookings SET status = 'DELIVERED', delivery_otp_hash = NULL, updated_at = ? WHERE id = ?`)
      .run(updatedAt, booking.id);
    addEvent(booking.id, 'DELIVERED', `Delivery confirmed by ${receiverName}`);
    res.json({ booking: bookingFromRow(findBooking(req.params.trackingId)), paymentStatus: 'ESCROW_PENDING' });
  });

  app.post('/api/bookings/:trackingId/delivery/verify', (req, res) => {
    const booking = findBooking(req.params.trackingId);
    if (booking.status !== 'ARRIVED') throw makeError(409, 'The parcel must arrive before delivery can be confirmed.');
    if (booking.delivery_attempts >= 3) throw makeError(429, 'Delivery OTP attempts are exhausted.');
    const code = typeof req.body.code === 'string' ? req.body.code : '';
    if (!/^\d{4}$/.test(code) || !sameHash(code, booking.delivery_otp_hash)) {
      const attempts = booking.delivery_attempts + 1;
      db.prepare('UPDATE bookings SET delivery_attempts = ?, updated_at = ? WHERE id = ?').run(attempts, now(), booking.id);
      throw makeError(attempts >= 3 ? 429 : 400, attempts >= 3 ? 'Delivery OTP attempts are exhausted.' : `Delivery code is incorrect. ${3 - attempts} attempt(s) left.`);
    }
    res.json({ verified: true });
  });

  app.post('/api/bookings/:trackingId/reviews', (req, res) => {
    const booking = findBooking(req.params.trackingId);
    if (booking.status !== 'DELIVERED') throw makeError(409, 'A review can be submitted after delivery.');
    const rating = finiteNumber(req.body.rating, 'Rating', 1, 5, true);
    const tags = Array.isArray(req.body.tags)
      ? req.body.tags.slice(0, 4).map((tag) => requiredString(tag, 'Review tag', 40))
      : [];
    const comment = typeof req.body.comment === 'string' ? req.body.comment.trim().slice(0, 400) : '';
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO reviews (id, booking_id, rating, tags, comment, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, booking.id, rating, JSON.stringify(tags), comment, now());
    res.status(201).json({ review: { id, rating, tags, comment } });
  });

  app.get('/', (req, res, next) => {
    res.sendFile(TRACKING_PAGE, (error) => {
      if (error) next(makeError(404, 'The Acredo Traveller HTML file is missing.'));
    });
  });

  app.use((req, res) => res.status(404).json({ error: 'Route not found.' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = Number.isInteger(error.status) ? error.status : 500;
    if (status >= 500) console.error(error);
    res.status(status).json({ error: status === 500 ? 'An unexpected server error occurred.' : error.message });
  });

  return { app, db };
}

if (require.main === module) {
  const { app } = createApp();
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`Acredo API ready at http://localhost:${port}`));
}

module.exports = { createApp };

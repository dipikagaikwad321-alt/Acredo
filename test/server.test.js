'use strict';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { createApp } = require('../server');

let server;
let db;
let baseUrl;

before(async () => {
  const instance = createApp({ dbPath: ':memory:' });
  db = instance.db;
  server = instance.app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  db.close();
});

async function request(url, options) {
  const response = await fetch(`${baseUrl}${url}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...options?.headers },
  });
  return { response, body: await response.json() };
}

test('health and traveller directory are available', async () => {
  const health = await request('/api/health');
  assert.equal(health.response.status, 200);
  assert.equal(health.body.status, 'ok');

  const travellers = await request('/api/travellers?from=Pune&to=Mumbai');
  assert.equal(travellers.body.travellers.length, 3);
  assert.equal(travellers.body.travellers[0].id, 'rohan-deshmukh');
  const noRouteMatch = await request('/api/travellers?from=Mumbai&to=Pune');
  assert.equal(noRouteMatch.body.travellers.length, 0);
});

test('booking lifecycle enforces OTPs and ordered status transitions', async () => {
  const create = await request('/api/bookings', {
    method: 'POST',
    body: JSON.stringify({
      pickupCity: 'Pune',
      destinationCity: 'Mumbai',
      pickupAddress: 'Hinjewadi Phase 1, Pune',
      deliveryAddress: 'Bandra East, Mumbai',
      parcelName: 'Laptop charger',
      category: 'Documents & electronics',
      weight: 1.2,
      dimensions: { length: 32, width: 24, height: 8 },
      deadline: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
      reward: 450,
      notes: 'Call before delivery',
    }),
  });
  assert.equal(create.response.status, 201);
  const trackingId = create.body.booking.trackingId;
  assert.match(trackingId, /^ACR-[A-F0-9]{24}$/);
  assert.equal('pickupAddress' in create.body.booking, false);
  assert.equal(create.body.booking.status, 'MATCHING');

  const premature = await request(`/api/bookings/${trackingId}/status`, {
    method: 'POST',
    body: JSON.stringify({ status: 'IN_TRANSIT' }),
  });
  assert.equal(premature.response.status, 409);

  const accepted = await request(`/api/bookings/${trackingId}/accept`, {
    method: 'POST',
    body: JSON.stringify({ travellerId: 'rohan-deshmukh' }),
  });
  assert.equal(accepted.body.booking.status, 'MATCHED');
  assert.match(accepted.body.debugOtp, /^\d{4}$/);

  const pickupVerified = await request(`/api/bookings/${trackingId}/pickup/verify`, {
    method: 'POST',
    body: JSON.stringify({ code: accepted.body.debugOtp }),
  });
  assert.equal(pickupVerified.body.verified, true);

  const wrongPickupOtp = String((Number(accepted.body.debugOtp) + 1) % 10000).padStart(4, '0');
  const rejectedPickup = await request(`/api/bookings/${trackingId}/pickup`, {
    method: 'POST',
    body: JSON.stringify({ code: wrongPickupOtp }),
  });
  assert.equal(rejectedPickup.response.status, 400);

  const pickedUp = await request(`/api/bookings/${trackingId}/pickup`, {
    method: 'POST',
    body: JSON.stringify({ code: accepted.body.debugOtp }),
  });
  assert.equal(pickedUp.response.status, 200);
  assert.equal(pickedUp.body.booking.status, 'PICKED_UP');

  const inTransit = await request(`/api/bookings/${trackingId}/status`, {
    method: 'POST',
    body: JSON.stringify({ status: 'IN_TRANSIT' }),
  });
  assert.equal(inTransit.body.booking.status, 'IN_TRANSIT');

  const arrived = await request(`/api/bookings/${trackingId}/status`, {
    method: 'POST',
    body: JSON.stringify({ status: 'ARRIVED' }),
  });
  assert.equal(arrived.body.booking.status, 'ARRIVED');
  assert.match(arrived.body.debugOtp, /^\d{4}$/);

  const deliveryVerified = await request(`/api/bookings/${trackingId}/delivery/verify`, {
    method: 'POST',
    body: JSON.stringify({ code: arrived.body.debugOtp }),
  });
  assert.equal(deliveryVerified.body.verified, true);

  const delivered = await request(`/api/bookings/${trackingId}/delivery`, {
    method: 'POST',
    body: JSON.stringify({ code: arrived.body.debugOtp, receiverName: 'Meera Iyer', proofConfirmed: true }),
  });
  assert.equal(delivered.body.booking.status, 'DELIVERED');
  assert.equal(delivered.body.paymentStatus, 'ESCROW_PENDING');

  const review = await request(`/api/bookings/${trackingId}/reviews`, {
    method: 'POST',
    body: JSON.stringify({ rating: 5, tags: ['Careful handling'], comment: 'Arrived safely.' }),
  });
  assert.equal(review.response.status, 201);
  assert.equal(review.body.review.rating, 5);

  const tracking = await request(`/api/bookings/${trackingId}`);
  assert.deepEqual(tracking.body.events.map((event) => event.status), [
    'MATCHING', 'MATCHED', 'PICKED_UP', 'IN_TRANSIT', 'ARRIVED', 'DELIVERED',
  ]);
});

test('invalid booking payloads and incorrect OTPs are rejected', async () => {
  const wrongContentType = await request('/api/bookings', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: '{}',
  });
  assert.equal(wrongContentType.response.status, 415);

  const invalid = await request('/api/bookings', {
    method: 'POST',
    body: JSON.stringify({ pickupCity: 'Pune', destinationCity: 'Pune' }),
  });
  assert.equal(invalid.response.status, 400);

  const create = await request('/api/bookings', {
    method: 'POST',
    body: JSON.stringify({
      pickupCity: 'Pune', destinationCity: 'Mumbai',
      pickupAddress: 'Pickup address', deliveryAddress: 'Delivery address',
      parcelName: 'Books', category: 'Books', weight: 1,
      dimensions: { length: 20, width: 10, height: 5 },
      deadline: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
      reward: 100, notes: '',
    }),
  });
  const trackingId = create.body.booking.trackingId;
  const accepted = await request(`/api/bookings/${trackingId}/accept`, {
    method: 'POST',
    body: JSON.stringify({ travellerId: 'rohan-deshmukh' }),
  });
  const incorrectCode = String((Number(accepted.body.debugOtp) + 1) % 10000).padStart(4, '0');
  const incorrect = await request(`/api/bookings/${trackingId}/pickup`, {
    method: 'POST',
    body: JSON.stringify({ code: incorrectCode }),
  });
  assert.equal(incorrect.response.status, 400);
  const secondIncorrect = await request(`/api/bookings/${trackingId}/pickup`, {
    method: 'POST',
    body: JSON.stringify({ code: incorrectCode }),
  });
  assert.equal(secondIncorrect.response.status, 400);
  const exhausted = await request(`/api/bookings/${trackingId}/pickup`, {
    method: 'POST',
    body: JSON.stringify({ code: incorrectCode }),
  });
  assert.equal(exhausted.response.status, 429);
});

test('trip listings are validated and persisted', async () => {
  const response = await request('/api/trips', {
    method: 'POST',
    body: JSON.stringify({
      from: 'Pune', to: 'Mumbai',
      travelDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
      departureTime: '07:30', space: 2,
    }),
  });
  assert.equal(response.response.status, 201);
  assert.equal(response.body.trip.from, 'Pune');
  assert.equal(response.body.trip.space, 2);
  const listings = await request('/api/trips?from=Pune&to=Mumbai');
  assert.equal(listings.body.trips.length, 1);
  assert.equal(listings.body.trips[0].id, response.body.trip.id);
});

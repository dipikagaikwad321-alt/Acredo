# Acredo Traveller backend

This project adds a Node.js/Express REST API with persistent SQLite storage to the standalone Acredo Traveller demo. The API stores parcel bookings, trip listings, status events, and reviews; it also enforces pickup and delivery OTP checks and ordered status transitions.

## Requirements

- Node.js 22.13 or newer (the backend uses Node's built-in `node:sqlite` module).
- npm.

## Run locally

```powershell
npm.cmd install
npm.cmd start
```

Open [http://localhost:3000](http://localhost:3000). The SQLite database is created at `data/acredo.sqlite`; set `DATABASE_PATH` to change its location and `PORT` to change the port.

Run the API tests with `npm.cmd test`.

## API

- `GET /api/health`
- `GET /api/travellers?from=Pune&to=Mumbai`
- `GET /api/trips?from=Pune&to=Mumbai`
- `POST /api/trips`
- `POST /api/bookings`
- `GET /api/bookings/:trackingId`
- `GET /api/bookings/:trackingId/matches`
- `POST /api/bookings/:trackingId/accept`
- `POST /api/bookings/:trackingId/pickup/verify`
- `POST /api/bookings/:trackingId/pickup`
- `POST /api/bookings/:trackingId/status` (`IN_TRANSIT`, then `ARRIVED`)
- `POST /api/bookings/:trackingId/delivery/verify`
- `POST /api/bookings/:trackingId/delivery`
- `POST /api/bookings/:trackingId/reviews`

Booking status order: `MATCHING` → `MATCHED` → `PICKED_UP` → `IN_TRANSIT` → `ARRIVED` → `DELIVERED`. OTP attempts are limited to three per handover. Booking payloads and responses use JSON; invalid requests return a JSON error and an appropriate HTTP status.
The page keeps the current demo booking in tab-scoped `sessionStorage` and reloads its status from SQLite when the same tab is refreshed.

Create a booking with `POST /api/bookings`:

```json
{
  "pickupCity": "Pune",
  "destinationCity": "Mumbai",
  "pickupAddress": "Pickup address",
  "deliveryAddress": "Delivery address",
  "parcelName": "Books",
  "category": "Books & stationery",
  "weight": 1.2,
  "dimensions": { "length": 30, "width": 20, "height": 10 },
  "deadline": "2026-10-12",
  "reward": 450,
  "notes": ""
}
```

Trip posts use `from`, `to`, `travelDate`, `departureTime` (`HH:MM`), and `space` (`1`–`3`). Accept a match with `{ "travellerId": "rohan-deshmukh" }`. OTP verification bodies use `{ "code": "1234" }`.

## Demo and production boundaries

Three example travellers are seeded for the Pune → Mumbai route. In non-production environments, OTPs appear as `debugOtp` in match acceptance and arrival responses so the demo can be exercised without SMS. They are never returned when `NODE_ENV=production`; an SMS provider and authenticated user/role checks must be integrated before enabling real bookings. This API is a local prototype and has no user authentication: do not expose it publicly or enter real personal information.

The API records delivery confirmation and reports `paymentStatus: "ESCROW_PENDING"`. It does not collect money, hold funds, or release payments. A regulated payment/escrow provider must be integrated for real transactions. Photo uploads and identity verification are still demo-only and are not stored by this API.

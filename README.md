# SteadySight

SteadySight is a dark, green-accented smart camera prototype with live subject detection, framing guidance, subject locking, canvas-based video reframing, and a persistent personal capture library.

## Features

- Existing camera, object detection, optional face detection, subject lock, framing guidance, photo capture and reframed video recording.
- Registration and login with bcrypt password hashes and server-side SQLite sessions.
- Persistent photo/video uploads and SQLite metadata.
- Capture listing, detail pages, create, edit, owner-only delete, like and bookmark actions.
- Search by title/description, type/category filters and date sorting.
- Profile statistics and responsive dark UI.
- Stabilization remains a prototype indicator; it does not stabilize the media.

## Stack and structure

- Frontend: existing HTML, CSS and vanilla JavaScript (`index.html`, `style.css`, `script.js`) plus `library.js` / `library.css`.
- Backend: Node.js and Express (`server/server.js`).
- Database: SQLite via Node's built-in `node:sqlite`; tables and session storage are created on first start.
- Uploads: `uploads/`; database and session files: `data/`.

## Install and run

Install Node.js 22.13 or newer (the app uses Node's built-in SQLite module). In the project directory:

```sh
npm install
```

Copy `.env.example` to `.env`, set a long random `SESSION_SECRET`, then start the server:

```sh
npm start
```

Open <http://localhost:3000>. Camera access requires HTTPS or localhost and browser permission. Create an account in the app; there is no shared demo login. Passwords are never stored in plaintext. Do not use the development fallback session secret in a deployed environment.

SQLite data persists across application restarts in `data/steadysight.sqlite`. Uploaded media persists in `uploads/`. Back up both directories together. Each account sees its own captures; direct record access requires an authenticated session, and edits/deletes enforce record ownership.

## API

All endpoints are same-origin under `/api`. JSON errors use `{ "error": "..." }`; protected endpoints return 401 without a session.

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/auth/register` | Create an account and log in |
| POST | `/auth/login` | Start a session |
| POST | `/auth/logout` | End the session |
| GET | `/auth/me` | Current account, or `null` |
| GET | `/profile` | User information and activity statistics |
| GET | `/captures?q=&type=&category=&sort=` | List own captures with search and filters |
| POST | `/captures` | Multipart create (`media`, `title`, `category`, `description`, `tags`) |
| GET | `/captures/:id` | View a capture |
| PUT | `/captures/:id` | Update owned capture metadata |
| DELETE | `/captures/:id` | Delete owned capture and media |
| POST | `/captures/:id/like` | Toggle like |
| POST | `/captures/:id/bookmark` | Toggle bookmark |

Uploads are limited to 100 MB and JPEG, PNG, WebP, WebM, MP4 and QuickTime MIME types. Browser recording commonly produces WebM. SQLite enforces unique likes/bookmarks per user and capture.

## Assignment checklist

1. Home page: original SteadySight home screen remains.
2. Listing/details: Library grid and dedicated detail view.
3. Create/update: save captured media and edit metadata.
4. Delete: confirmation and owner-only deletion also removes uploaded media.
5. Interaction: persistent like/unlike and bookmark/unbookmark.
6. Search/filter: title/description search, type/category filters, newest/oldest sort.
7. Profile: account details, capture counts, likes/bookmarks and saved captures.
8. Backend API: Express REST endpoints listed above.
9. Database: SQLite persistence for users, records, sessions and interactions.
10. Validation/errors: server validation, upload validation, request errors and loading/empty states.
11. Responsive UI: desktop, tablet and mobile layouts.

## Limitations

- Detection libraries and models are loaded from public CDNs, so actual detection needs network access; the UI distinguishes demo fallback from detector output.
- Stabilization is only an explicitly labeled demo indicator.
- Sessions use SQLite storage; configure a strong secret and HTTPS in production. The project is intended as an internship assignment app, not hardened for public multi-tenant deployment.

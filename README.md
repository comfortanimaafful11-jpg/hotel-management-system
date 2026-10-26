# Grand Hotel Management System

A secure, role-based hotel management system built as a course project at MVP level.

**Author:** [your name] | **Course:** [course and lecturer]
**Live showcase (demo data only):** https://YOUR-PROJECT.vercel.app

## Features
- Login with username, password and two-factor authentication (authenticator app)
- Three roles with their own pages: **Admin**, **Manager**, **Receptionist**
- Admin: manage users, roles and permissions, hotel information, all records, system activity, security settings, backups and restore points
- Manager: room availability, bookings, staff tasks, reports, payments, complaints, decisions
- Receptionist: register guests, reservations, room availability, check-in and check-out, payments, guest records, enquiries

## Security design
| Requirement | How it is done |
|---|---|
| Hashing with salt and pepper | HMAC-SHA256 with a secret pepper (kept in `.env`), then scrypt with a random salt per user |
| Two-factor authentication | TOTP codes; secrets encrypted with AES-256-GCM |
| Authorization | Role checks plus a permissions table enforced by a server gatekeeper |
| SQL injection protection | Every query is parameterized |
| Brute-force protection | Account lockout after 5 failures and rate limiting |
| Audit log | Every action recorded; database triggers block edits and deletes |
| Deleted data | Copied to a separate database (`hotel_deleted_db`) before removal |
| Backups | AES-256 encrypted, SHA-256 checksum, automatic every 24 hours, uploaded to Dropbox through its API |
| Restore points | Save and restore settings only, never guest or booking data |

## Tech stack
Node.js, Express, MySQL (Laragon), plain HTML, CSS and JavaScript.

## Run it locally
1. Install Laragon and Node.js, then start MySQL.
2. In MySQL Workbench, run `database/hotel_db.sql`. It creates the `hotel_app` user with the demo password that matches `.env.demo`, so do not change it for the demo.
3. `npm install`
4. Copy `.env.demo` to `.env`. These are throwaway demo values. For real use, make your own keys with:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
5. `node createAdmin.js` to create the first Admin.
6. `node server.js`, then open http://localhost:3000/login.html

## Demo accounts (showcase site only, fictional)
| Username | Role | Demo password |
|---|---|---|
| amensah | Admin | Demo-Admin#2026 |
| kboateng | Manager | Demo-Manager#2026 |
| eowusu | Receptionist | Demo-Reception#2026 |

These exist only on the showcase page. The real system has no default accounts.

## Project structure
- `server.js`, `security.js`: server, routes, hashing and encryption
- `Public/`: the pages for each role
- `database/hotel_db.sql`: database script
- `showcase/`: static demo site deployed on Vercel
- `createAdmin.js`, `resetPassword.js`, `decryptBackup.js`: command-line tools
-`hotel-mobile-app/`: mobile app(work in progress)

## Known limitations
- Sessions are kept in server memory, so a restart signs everyone out
- Runs on localhost over HTTP; real use needs HTTPS
- Old backups are not deleted automatically

## Not in this repository (secrets)
`.env`, backups, the real pepper, the real keys and tokens, and real accounts.
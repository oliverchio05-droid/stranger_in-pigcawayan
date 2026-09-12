# Stranger in Pigcawayan

Free, unlimited anonymous text/video chat. Built and founded by C TECH.
Skip button to jump to the next stranger, report button for safety, and
auto-ban after repeated reports.

## How it's built
- **Backend**: Node.js + Express + Socket.io — matching queue, WebRTC
  signaling relay, and moderation (reports/bans).
- **Frontend**: plain HTML/CSS/JS (no framework/build step) — WebRTC for
  the video call, Socket.io client for signaling.
- **Storage**: a simple `db.json` file on the backend. Fine for an MVP;
  swap for a real database once you have real traffic.
- **Admin page** (`admin.html`): a private, password-protected moderation
  view — see report counts, ban or unban someone. Not linked from the
  public site; keep this URL to yourself.

## Running it locally
```bash
cd backend
npm install
cp .env.example .env    # then edit .env with your ADMIN_SECRET
npm start
```
Then open `public/index.html` in a browser (or serve the `public` folder
with any static server). Update `FRONTEND_ORIGIN` in `.env` to match
wherever you're serving the frontend from.

## Deploying for free
1. **Backend** → Render or Railway free tier. Set the environment
   variables from `.env.example`. Free tiers sleep after inactivity —
   the first request after a gap can take 30–50+ seconds to wake up.
2. **Frontend** → Vercel or Netlify free tier, pointing at the `public`
   folder. Update `API_BASE` in `app.js` and the Socket.io `<script src>`
   in `index.html` to match your backend URL if they're not on the same
   domain.
3. **Domain**: launch on the free subdomain, buy a real domain later.

## TURN server (important for call reliability)
STUN alone (already wired up) fails to connect roughly 10–20% of calls —
usually people on mobile data or behind strict routers. See the earlier
setup notes for running a free `coturn` TURN server on Oracle Cloud's
Always Free tier, then add it to `ICE_SERVERS` in `app.js`.

## Moderation
- Report threshold: 3 reports auto-bans an account. Adjust in
  `server.js` (`reported.reportCount >= 3`).
- Use `admin.html` to review reports and reverse a ban if it was unfair,
  or manually ban someone you hear about through another channel.
- Keep `reports.json` and `db.json` backed up — if a serious incident
  happens, you'll want the records.

## Safety — please don't skip this
Random-stranger video chat has a well-documented history of misuse
against minors. The age gate here only checks a self-reported birth
year — reasonable for now, not a substitute for real ID verification if
this grows. Seriously consider an AI content-moderation API (Hive
Moderation, Google Cloud Vision SafeSearch, AWS Rekognition) to scan for
nudity/CSAM in real time once you have real usage.

## What's NOT built yet
- Real database (currently a JSON file)
- Real ID/age verification
- Content moderation on video streams
- Admin notifications (you have to check `admin.html` yourself; no
  alerts when a report comes in)

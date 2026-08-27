# Stranger in Pigcawayan

Anonymous random text/video chat, MVP build. Free tier: 5 conversations.
Paid membership (₱100, configurable): 50 conversations. Skip button to jump
to the next stranger, report button for safety.

## How it's built
- **Backend**: Node.js + Express + Socket.io — handles the matching queue,
  WebRTC signaling relay, membership limits, and payment endpoints.
- **Frontend**: plain HTML/CSS/JS (no framework/build step) — WebRTC for the
  actual video call, Socket.io client for signaling.
- **Storage**: a simple `db.json` file on the backend. Fine for an MVP; swap
  for a real database once you have real traffic.

## Running it locally
```bash
cd backend
npm install
cp .env.example .env    # then edit .env with your details
npm start
```
Then open `public/index.html` in a browser (or serve the `public` folder
with any static server — e.g. VS Code's "Live Server" extension). Update
`FRONTEND_ORIGIN` in `.env` to match wherever you're serving the frontend
from.

## Deploying for free
1. **Backend** → [Render](https://render.com) or [Railway](https://railway.app)
   free tier. Set the environment variables from `.env.example` in their
   dashboard. Free tiers sleep after inactivity — fine while you're testing,
   worth upgrading once you have paying members who expect instant matches.
2. **Frontend** → [Vercel](https://vercel.com) or [Netlify](https://netlify.com)
   free tier, pointing at the `public` folder. Update `API_BASE` in `app.js`
   if the frontend and backend aren't on the same domain, and point
   `<script src="/socket.io/socket.io.js">` in `index.html` at your backend
   URL instead.
3. **Domain**: launch on the free subdomain Render/Vercel give you
   (e.g. `stranger-in-pigcawayan.vercel.app`). Buy a real domain later.

## TURN server (important for call reliability)
STUN alone (already wired up, using Google's free public STUN) fails to
connect roughly 10–20% of calls — usually people on mobile data or behind
strict routers. A TURN server relays that traffic. To keep this free:
1. Sign up for [Oracle Cloud "Always Free"](https://www.oracle.com/cloud/free/)
   and spin up the free-tier VM.
2. Install [coturn](https://github.com/coturn/coturn) (open source TURN
   server) on it — there are many step-by-step guides for this.
3. Add the TURN URL/username/credential to `ICE_SERVERS` in `app.js`.

## Payments
By default (no `PAYMONGO_SECRET_KEY` set) the app runs in **manual GCash
mode**: it shows your GCash name/number and a reference code, and you
upgrade the member yourself by calling `/api/admin/upgrade` with your
`ADMIN_SECRET` once you've confirmed the payment.

To automate this with PayMongo (GCash checkout, auto-upgrade via webhook):
1. Create a free [PayMongo](https://paymongo.com) account and get your
   secret key from the dashboard.
2. Set `PAYMONGO_SECRET_KEY` in `.env`.
3. In the PayMongo dashboard, add a webhook pointing to
   `https://your-backend-url/api/payment-webhook`.
4. **Before going live**, add real webhook signature verification in
   `/api/payment-webhook` (currently a simplified stub) — see PayMongo's
   webhook docs for the verification steps, otherwise anyone could fake a
   "payment succeeded" call.

Important: PayMongo (and any proper gateway) is meant for **business**
accounts, not personal GCash. Collecting payments through a personal GCash
number for an ongoing business is against GCash's own terms and creates tax
headaches — worth registering as a sole proprietor (DTI + BIR) once this
gets real traction.

## Safety and legal — please don't skip this
Random-stranger video chat has a well-documented history of misuse against
minors (it's part of why Omegle shut down in 2023 after lawsuits). Before
opening this to the public:
- The age gate here only checks a self-reported birth year. That's a
  reasonable MVP starting point, **not** a substitute for real verification
  once you have real traffic — look into ID/KYC providers (Persona, Onfido,
  or local options) for that stage.
- Keep the report system aggressive early on — the current threshold bans an
  account after 3 reports; tune this based on what you see.
- Seriously consider adding an AI content-moderation API (Hive Moderation,
  Google Cloud Vision SafeSearch, AWS Rekognition) to scan for nudity/CSAM in
  real time. Free tiers exist but this is one area worth paying for once you
  have any real usage — the legal exposure of not having it is significant
  under the Philippines' Anti-Child Pornography Act and Anti-OSAEC laws.
- Keep `reports.json` and `db.json` backed up somewhere — if a serious
  incident happens, you'll want records.

## What's NOT built yet (left for you to add as you grow)
- Real database (currently a JSON file — will not survive server restarts
  well if written to concurrently at scale)
- Real ID/age verification
- Content moderation on video streams
- Membership expiry (currently a one-time flag — decide if ₱100 = lifetime
  50 chats, or a monthly renewal, and adjust `server.js` accordingly)
- Admin dashboard (right now you'd check `db.json`/`reports.json` by hand,
  or call `/api/admin/upgrade` manually)

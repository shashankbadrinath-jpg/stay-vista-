# StayDesk

A reservation desk for boutique stays that runs on the customer's own Claude over MCP. **No AI inside**: no AI keys, no AI SDKs, nothing to pay per use. Claude checks availability, holds dates and writes the guest quote. StayDesk saves it, lets a human edit it, expires holds on a timer, and serves a live guest page.

Run `npm run check:no-ai` to prove it: it fails if any AI vendor key or endpoint appears in the code.

## Deploy (about 10 minutes, Railway)
1. Push this folder to a GitHub repo.
2. Railway: New Project, Deploy from GitHub repo (it detects the Dockerfile).
3. Add a **Volume** mounted at `/data` so bookings survive restarts.
4. Variables: `PUBLIC_URL` = your Railway URL (https, no trailing slash), `DEMO_MCP_KEY` = any long random string you choose (so the demo link never changes).
5. Settings, Networking, Generate Domain. Open it and sign in with the demo login.

Fly.io or any Docker host also works: mount a volume at `/data`, set the same two variables.

## What to send Volopay
- **Live app:** your URL. Test login: `demo@staydesk.app` / `demo1234` (pre-filled on the sign-in page).
- **MCP link:** `https://YOUR-URL/mcp/YOUR_DEMO_MCP_KEY`
- **Connect steps:** Claude, Settings, Connectors, Add custom connector, name it StayDesk, paste the MCP link, leave OAuth empty, Add. Then in a new chat enable StayDesk from the tools menu.

## Try it in Claude
- "What's free in Coorg from 26 to 29 December for 6 people?"
- "Hold the best option for Priya, 98450 12345, for 48 hours and write her a quote."
- "Add a property, Cedar Nest in Wayanad, two cottages sleeping 4 at ₹6,500 a night."
- "Sales summary for this month."

The dashboard refreshes every 5 seconds, so the hold appears while you watch. Open the guest link from the booking to see what the customer sees.

## Run locally
`npm install && npm start`, then open http://localhost:3000. The demo MCP link is printed in the console. `npm test -- <mcp url>` runs an end-to-end tool test.

## Tools Claude gets
list_properties, add_property, check_availability, hold_dates, confirm_booking, cancel_booking, list_bookings, sales_summary.

## Known limits (v1)
Link-based MCP auth (rotate it from the Connect tab), no payments, no OTP, no Airbnb sync, no login rate limiting.

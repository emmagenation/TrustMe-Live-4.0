# Trust Me backend

Node.js 18+, no dependencies. Run `node server.js`, then open http://localhost:3000 (it serves the app at `/`).
Data is saved to `db.json`. Sign-in is by phone and a 6-digit code.

**Environment:** `PORT`, `DB_FILE`, `ORIGIN` (your site's address), `SHOW_OTP=0` (stop returning the code in the API), `PAYSTACK_SECRET_KEY` (turns on real bank payments and payouts), `APP_URL` (your public address, optional), `MIN_WITHDRAW` (smallest withdrawal in naira, default 1000), `FRONTEND` (the app file to serve, default `TrustMe_1_1_2.html`).

**Endpoints** (send `Authorization: Bearer <token>` on everything except the first two):

| | |
|---|---|
| `POST /api/auth/request-otp` `{phone}` | Sends a code. Returns `devCode` while `SHOW_OTP` is on |
| `POST /api/auth/verify` `{phone, code, role, name, camp, batch, stream, cat, pkgName, pkgFee}` | Signs in or creates the account. Returns `{token, user}` |
| `POST /api/auth/pin` `{pin, oldPin}` | Set or change the login PIN (the app-open PIN). `oldPin` is required only if one is already set |
| `POST /api/auth/pin/verify` `{pin}` | Checks the login PIN, e.g. to unlock the app on reopen |
| `POST /api/auth/pin/reset` `{phone, code, pin}` | Forgot the login PIN: verifies a fresh OTP to the registered phone and sets a new one. Returns a new `{token}` |
| `GET/PATCH /api/me` | Your profile (name, camp, batch, stream, needs, pic). Vendors can also set `callPhone`; leave it out or send an empty value to fall back to the number they registered with |
| `POST/PUT/DELETE /api/me/packages[/:id]` | Vendor packages |
| `GET /api/vendors?cat=&camp=&q=` · `GET /api/vendors/:id` | Browse vendors |
| `POST /api/bookings` `{vendorId, pkgId, when, where}` · `GET /api/bookings` | Corps member books; each side sees its own |
| `POST /api/bookings/:id/review` `{rating, text}` | Corps member reviews a finished job. Jobs done, rating and reviews on the vendor update from it |
| `POST /api/payments/verify` `{reference}` · `POST /api/paystack/webhook` | Confirms the bank payment. The booking only reaches the vendor once it succeeds |
| `POST /api/bookings/:id/advance` | Vendor: accept, then finished. Corps member: release payment |
| `GET /api/wallet` | Vendor: available balance, money held on open jobs, totals, payout account, history |
| `GET /api/banks` | Vendor: list of Nigerian banks with their codes |
| `POST /api/wallet/bank/otp` · `PUT /api/wallet/bank` `{bank, account, code}` | Vendor: save the payout account. A code is texted to their phone first |
| `POST /api/wallet/withdraw` `{amount, pin}` or `{all:true, pin}` | Vendor: send money from the balance to the saved account. `pin` is the withdrawal PIN — a 409 with `needPin:true` means none is set yet |
| `POST /api/wallet/pin` `{pin, oldPin}` | Vendor: set or change the withdrawal PIN. `oldPin` is required only if one is already set. This PIN is separate from the login PIN and from the bank-change code — it is the one thing a phone (and SIM) thief still would not have |
| `GET /api/messages` · `GET/POST /api/messages/:userId` | Inbox, thread, send `{to, text, img, replyTo}` — `text` or `img` (a data URL, one photo per message), `replyTo` quotes an earlier message id from the same thread |

**PINs:** both PINs are 4 to 6 digits, stored as a salted hash (never in plain text), and lock out for 5 minutes after 5 wrong tries in a row. The login PIN gates opening the app on a given phone; the withdrawal PIN gates only `POST /api/wallet/withdraw`. Losing the login PIN is recoverable through `POST /api/auth/pin/reset` (a fresh OTP to the registered phone), which is the same trust level the rest of the app already relies on — it is not a defense against someone who has both the phone and the SIM and knows this, only against someone who has picked up an already-open phone.

**Before real users:** add an SMS provider where the code is generated (Termii is a common Nigerian one) and set `SHOW_OTP=0`.
On Render's free plan the disk is wiped on restart, so use a persistent disk or a database. Payments are not real yet.

**Payments (Paystack):** set `PAYSTACK_SECRET_KEY` (start with a `sk_test_` key), and in the Paystack dashboard set the webhook URL to `https://YOUR-APP/api/paystack/webhook`. Without the key the app runs in test mode and no real money moves. Paying vendors out after release is not built yet.


**Vendor earnings and withdrawals:** when a corps member releases a payment, the vendor is credited the price minus the 8% fee. Balance = credits minus payouts that were sent or are on their way. A withdrawal is taken off the balance before the bank is called and returned only if the bank refuses it, so the same money cannot be withdrawn twice. Only one payout can be on its way at a time. Money can only go to the saved payout account, and changing that account needs a code texted to the vendor's phone.
Live payouts use Paystack Transfers: the account is checked with Paystack's account-name lookup, then a transfer is sent. In the Paystack dashboard: (1) switch on Transfers for your business, (2) **turn off "Confirm transfers before sending" (transfer OTP)**, because the server cannot type that code, (3) add a webhook URL as above (it now also receives `transfer.success`, `transfer.failed` and `transfer.reversed`), (4) keep enough balance in Paystack to cover payouts. The customer's payment lands in that balance after Paystack settles it. Payouts stuck without a webhook are re-checked when the vendor opens the Earnings screen. Test mode and real-money entries are kept apart, so pretend jobs never become real payouts.
Paystack charges a small fee per transfer (₦10 to ₦50 by amount). Right now Trust Me absorbs it.

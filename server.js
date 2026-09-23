'use strict';
/* Trust Me backend. No dependencies: `node server.js` (Node 18+). Data lives in db.json. */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'db.json');
const ORIGIN = process.env.ORIGIN || '*';                 // set to your site's address once it is live
const SHOW_OTP = process.env.SHOW_OTP !== '0';            // returns the code in the API until a real SMS provider is added
const PAY_KEY = process.env.PAYSTACK_SECRET_KEY || '';        // payments are switched on when this is set
const PAY_BASE = process.env.PAYSTACK_BASE || 'https://api.paystack.co';
const MIN_WITHDRAW = Math.max(1, Math.floor(+process.env.MIN_WITHDRAW || 1000));   // smallest withdrawal, in naira
const paystack = async (method, p, body) => {
  const r = await fetch(PAY_BASE + p, { method, headers: { Authorization: 'Bearer ' + PAY_KEY, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.status) { const e = new Error(j.message || 'Payment provider error'); e.api = true; e.code = r.status; throw e; }   // e.api: Paystack answered and said no
  return j.data;                                                                                                      // no e.api (timeout, network): we do not know if it went through
};
const FRONTEND = path.join(__dirname, process.env.FRONTEND || 'TrustMe_1_1_2.html');

let db = { users: {}, sessions: {}, otps: {}, bookings: {}, messages: [], ledger: [], payouts: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch (e) {}
let timer;
const flush = () => { fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db)); fs.renameSync(DB_FILE + '.tmp', DB_FILE); };
const save = () => { clearTimeout(timer); timer = setTimeout(flush, 150); };
['SIGINT', 'SIGTERM'].forEach(s => process.on(s, () => { try { flush(); } catch (e) {} process.exit(0); }));

const rid = () => crypto.randomBytes(6).toString('hex');
const fail = (c, m, extra) => { throw Object.assign({ c, m }, extra); };
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const phoneOf = p => {
  let d = String(p || '').replace(/\D/g, ''); if (d.startsWith('234')) d = '0' + d.slice(3);
  if (!/^0\d{10}$/.test(d)) fail(400, 'Enter a valid Nigerian phone number.'); return d;
};
const short = n => { const p = String(n || '').trim().split(/\s+/); return (p[0] || 'Corps member') + (p[1] ? ' ' + p[1][0] + '.' : ''); };
const stats = id => {     // jobs done, rating and reviews are worked out from finished bookings
  const done = Object.values(db.bookings).filter(b => b.vendorId === id && b.stage === 4), rs = done.filter(b => b.rating);
  return { jobs: done.length, rate: rs.length ? Math.round(rs.reduce((a, b) => a + b.rating, 0) / rs.length * 10) / 10 : 0,
    revs: rs.sort((a, b) => b.reviewed - a.reviewed).slice(0, 20).map(b => ({ n: short((db.users[b.corperId] || {}).name), s: b.rating, t: b.text,
      w: '₦' + b.price.toLocaleString('en-NG') + ' · ' + b.what })) };
};
const pub = u => ({ id: u.id, name: u.name, role: u.role, camp: u.camp, batch: u.batch, pic: u.pic || null,
  ...(u.role === 'vendor' ? Object.assign({ cat: u.cat, pkgs: u.pkgs, verified: !!u.verified, callPhone: u.callPhone || u.phone }, stats(u.id)) : {}) });
const me = u => Object.assign(pub(u), { phone: u.phone, stream: u.stream || '', needs: u.needs || [], setup: !!u.setup, hasPin: !!u.pinHash });
const auth = req => {
  const s = db.sessions[(req.headers.authorization || '').replace(/^Bearer /, '')];
  if (!s || !db.users[s.uid]) fail(401, 'Please sign in.'); return db.users[s.uid];
};
const vendorOnly = u => { if (u.role !== 'vendor') fail(403, 'Vendors only.'); };
const pkgIn = b => {
  const nm = str(b.nm, 60), price = Math.round(+b.price);
  if (nm.length < 2) fail(400, 'Give the package a name.'); if (!(price > 0)) fail(400, 'Add the fee in naira.');
  return { nm, price, desc: str(b.desc, 200), dur: str(b.dur, 30) };
};
const bview = b => Object.assign({}, b, { rated: !!b.rating, vendor: pub(db.users[b.vendorId]), corper: pub(db.users[b.corperId]) });
const quoteOf = id => { const q = db.messages.find(x => x.id === id); return q ? { from: q.from, text: q.text || '', img: !!q.img } : null; };
const mview = m => m.replyTo ? Object.assign({}, m, { quote: quoteOf(m.replyTo) }) : m;


/* ---- Vendor money: earnings, balance, payouts ----
   A vendor is credited (booking price minus the 8% fee) once the corps member releases the payment (stage 4).
   Balance = credits - payouts that are sent or still on their way. A payout is taken off the balance BEFORE the bank is called,
   and put back only if the bank refuses it, so the same money cannot be withdrawn twice.
   Test-mode and real-money entries are kept apart (`live`), so pretend jobs can never turn into a real payout. */
const net = price => Math.round(price * 92 / 100);
const isLive = b => !!(b.ref && b.paidAt);
const sum = a => a.reduce((t, x) => t + x.amt, 0);
const credit = b => {
  if (b.credited) return; b.credited = true;
  db.ledger.push({ id: rid(), uid: b.vendorId, bookingId: b.id, what: b.what, amt: net(b.price), live: isLive(b), at: Date.now() });
};
Object.values(db.bookings).forEach(b => { if (b.stage === 4) credit(b); }); save();      // brings older finished jobs into the ledger once
const wallet = uid => {
  const live = !!PAY_KEY, mine = x => x.uid === uid && x.live === live;
  const earn = db.ledger.filter(mine), pays = Object.values(db.payouts).filter(mine);
  const sent = sum(pays.filter(p => p.status === 'success')), going = sum(pays.filter(p => p.status === 'processing'));
  const held = Object.values(db.bookings).filter(b => b.vendorId === uid && b.stage >= 1 && b.stage < 4 && isLive(b) === live).reduce((t, b) => t + net(b.price), 0);
  return { balance: sum(earn) - sent - going, held, earned: sum(earn), withdrawn: sent, processing: going, earn, pays };
};
const walletView = u => {
  const w = wallet(u.id), bk = u.bank;
  const history = w.earn.map(e => ({ kind: 'earning', id: e.id, amt: e.amt, what: e.what, at: e.at }))
    .concat(w.pays.map(p => ({ kind: 'payout', id: p.id, amt: p.amt, status: p.status, to: p.to, at: p.at })))
    .sort((a, b) => b.at - a.at).slice(0, 40);
  return { balance: w.balance, held: w.held, earned: w.earned, withdrawn: w.withdrawn, processing: w.processing, min: MIN_WITHDRAW, live: !!PAY_KEY,
    bank: bk ? { bank: bk.name, last4: bk.acct.slice(-4), name: bk.acctName } : null, hasWPin: !!u.wPinHash, history };
};
const DONE = ['failed', 'reversed', 'abandoned', 'blocked', 'rejected', 'otp'];       // 'otp' = the Paystack account still asks for a code on transfers; we cannot answer it
const applyTransfer = (p, st) => {
  if (st === 'success' && p.status === 'processing') p.status = 'success';
  else if (DONE.includes(st) && (p.status === 'processing' || (st === 'reversed' && p.status === 'success'))) p.status = 'failed';
  else return false;
  p.updated = Date.now(); return true;
};
const reconcile = async uid => {       // settles payouts whose webhook never arrived
  if (!PAY_KEY) return; let ch = false;
  for (const p of Object.values(db.payouts)) {
    if (p.uid !== uid || p.status !== 'processing' || !p.live || Date.now() - p.at < 60000) continue;
    try { const d = await paystack('GET', '/transfer/verify/' + encodeURIComponent(p.ref)); ch = applyTransfer(p, d.status) || ch; }
    catch (e) { if (e.api && e.code === 404 && Date.now() - p.at > 600000) { p.status = 'failed'; p.updated = Date.now(); ch = true; } }   // never reached Paystack
  }
  if (ch) save();
};
const BANKS = [['Access Bank', '044'], ['Fidelity Bank', '070'], ['First Bank of Nigeria', '011'], ['FCMB', '214'], ['Guaranty Trust Bank', '058'], ['Kuda', '50211'],
  ['Moniepoint MFB', '50515'], ['OPay', '999992'], ['PalmPay', '999991'], ['Polaris Bank', '076'], ['Stanbic IBTC Bank', '221'], ['Sterling Bank', '232'],
  ['Union Bank', '032'], ['United Bank for Africa', '033'], ['Wema Bank', '035'], ['Zenith Bank', '057']].map(([name, code]) => ({ name, code }));
let bankCache = null;
const bankList = async () => {        // the live list comes from Paystack, so the codes are always the ones it accepts
  if (!PAY_KEY) return BANKS;
  if (!bankCache || Date.now() - bankCache.at > 6 * 3600e3) {
    try {
      const seen = {}, d = await paystack('GET', '/bank?country=nigeria&currency=NGN&perPage=200');
      bankCache = { at: Date.now(), list: d.filter(b => b.code && b.name && b.active !== false && !seen[b.code] && (seen[b.code] = 1)).map(b => ({ name: b.name, code: String(b.code) }))
        .sort((a, b) => a.name.localeCompare(b.name)) };
    } catch (e) { if (!bankCache) return BANKS; }
  }
  return bankCache.list;
};
const sendCode = (key, phone) => {     // one place that makes and sends codes; add the SMS provider here (e.g. Termii)
  const o = db.otps[key];
  if (o && Date.now() - o.sent < 30000) fail(429, 'Wait 30 seconds before asking for another code.');
  const code = String(crypto.randomInt(100000, 1000000));
  db.otps[key] = { code, sent: Date.now(), exp: Date.now() + 300000, tries: 0 }; save();
  if (SHOW_OTP) console.log('[otp]', phone, code);
  return SHOW_OTP ? code : null;
};
const checkCode = (key, code) => {
  const o = db.otps[key];
  if (!o || Date.now() > o.exp) fail(400, 'That code has expired. Ask for a new one.');
  if (++o.tries > 5) { delete db.otps[key]; save(); fail(429, 'Too many tries. Ask for a new code.'); }
  if (String(code) !== o.code) { save(); fail(400, 'That code is not right.'); }
  delete db.otps[key]; save();
};

/* ---- PINs: a login PIN (opens the app on this phone) and, for vendors, a separate withdrawal PIN
   (needed to move money out). Neither is the phone OTP, so having the SIM alone is not enough for either. */
const PIN_MAX_TRIES = 5, PIN_LOCK_MS = 5 * 60000;
const hashPin = (pin, salt) => crypto.scryptSync(String(pin), salt, 32).toString('hex');
const setPin = pin => { const salt = crypto.randomBytes(8).toString('hex'); return { salt, hash: hashPin(pin, salt), tries: 0, lockUntil: 0 }; };
const checkPin = (rec, pin) => {
  if (!rec) fail(400, 'No PIN is set.');
  if (rec.lockUntil && Date.now() < rec.lockUntil) fail(429, 'Too many tries. Wait a few minutes and try again.');
  if (hashPin(pin, rec.salt) !== rec.hash) {
    rec.tries = (rec.tries || 0) + 1;
    if (rec.tries >= PIN_MAX_TRIES) { rec.lockUntil = Date.now() + PIN_LOCK_MS; rec.tries = 0; }
    save(); fail(400, 'Wrong PIN.');
  }
  if (rec.tries) { rec.tries = 0; save(); }
};
const pinOf = raw => { const p = str(raw, 6); if (!/^\d{4,6}$/.test(p)) fail(400, 'Choose a 4 to 6 digit PIN.'); return p; };

/* [method, path, handler, needs sign-in]. Booking stages match the app: 1 paid and waiting, 2 accepted,
   3 work finished, 4 released and done. The vendor moves 1>2>3, the corps member moves 3>4. */
const routes = [
  ['GET', /^\/api\/health$/, () => ({ ok: true, payments: !!PAY_KEY }), false],

  ['POST', /^\/api\/auth\/request-otp$/, c => {
    const p = phoneOf(c.body.phone), code = sendCode(p, p);
    return { ok: true, ...(code ? { devCode: code } : {}) };
  }, false],

  ['POST', /^\/api\/auth\/verify$/, c => {
    const b = c.body, p = phoneOf(b.phone), o = db.otps[p];
    if (!o || Date.now() > o.exp) fail(400, 'That code has expired. Ask for a new one.');
    if (++o.tries > 5) { delete db.otps[p]; save(); fail(429, 'Too many tries. Ask for a new code.'); }
    if (String(b.code) !== o.code) { save(); fail(400, 'That code is not right.'); }
    delete db.otps[p];
    let u = Object.values(db.users).find(x => x.phone === p); const isNew = !u;
    if (!u) {
      const role = b.role === 'vendor' ? 'vendor' : 'corper';
      u = { id: rid(), phone: p, role, name: str(b.name, 40), camp: str(b.camp, 60), batch: str(b.batch, 20),
            stream: str(b.stream, 10), needs: [], pic: null, setup: true, created: Date.now() };
      if (role === 'vendor') {
        Object.assign(u, { cat: str(b.cat, 30), verified: false, jobs: 0, pkgs: [] });
        if (str(b.pkgName, 60) && +b.pkgFee > 0) u.pkgs.push({ id: rid(), nm: str(b.pkgName, 60), price: Math.round(+b.pkgFee), desc: '', dur: '' });
      }
      db.users[u.id] = u;
    }
    const token = crypto.randomBytes(24).toString('hex'); db.sessions[token] = { uid: u.id, at: Date.now() }; save();
    return { token, isNew, user: me(u) };
  }, false],

  /* Login PIN: opens the app on this phone. Separate from the phone OTP on purpose — a stolen phone
     usually means the SIM is gone too, so anything that only needs the SIM (like OTP) is not enough here. */
  ['POST', /^\/api\/auth\/pin$/, c => {
    const u = c.u, pin = pinOf(c.body.pin);
    if (u.pinHash) checkPin(u.pinHash, str(c.body.oldPin, 6));
    u.pinHash = setPin(pin); save(); return { ok: true };
  }, true],
  ['POST', /^\/api\/auth\/pin\/verify$/, c => { checkPin(c.u.pinHash, str(c.body.pin, 6)); return { ok: true }; }, true],
  ['POST', /^\/api\/auth\/pin\/reset$/, c => {         // forgot the PIN: same trust level as signing in in the first place
    const p = phoneOf(c.body.phone), u = Object.values(db.users).find(x => x.phone === p); if (!u) fail(404, 'Account not found.');
    checkCode(p, c.body.code); const pin = pinOf(c.body.pin);
    u.pinHash = setPin(pin);
    const token = crypto.randomBytes(24).toString('hex'); db.sessions[token] = { uid: u.id, at: Date.now() }; save();
    return { ok: true, token };
  }, false],

  ['GET', /^\/api\/me$/, c => me(c.u), true],
  ['PATCH', /^\/api\/me$/, c => {
    const b = c.body, u = c.u;
    for (const [k, n] of [['name', 40], ['camp', 60], ['batch', 20], ['stream', 10]]) if (k in b) u[k] = str(b[k], n);
    if (Array.isArray(b.needs)) u.needs = b.needs.slice(0, 20).map(x => str(x, 30));
    if ('pic' in b) {
      if (b.pic && (typeof b.pic !== 'string' || b.pic.length > 400000)) fail(413, 'That photo is too large.');
      if (b.pic && !/^data:image\/[a-z+]+;base64,[A-Za-z0-9+\/=]+$/.test(b.pic)) fail(400, 'That photo is not valid.');
      u.pic = b.pic || null;
    }
    if (u.setup && (b.role === 'vendor' || b.role === 'corper')) {          // role can be chosen until setup is finished
      u.role = b.role; if (b.role === 'vendor') Object.assign(u, { cat: u.cat || '', verified: false, jobs: u.jobs || 0, pkgs: u.pkgs || [] });
    }
    if (u.role === 'vendor') {
      if ('cat' in b) u.cat = str(b.cat, 30);
      if ('callPhone' in b) u.callPhone = b.callPhone ? phoneOf(b.callPhone) : null;   // corps members call this; falls back to the registered number when cleared
      if (Array.isArray(b.pkgs)) u.pkgs = b.pkgs.slice(0, 20).map(p => Object.assign({ id: str(p.id, 20).replace(/\W/g, '') || rid() }, pkgIn(p)));
    }
    if (b.done === true) u.setup = false;
    save(); return me(u);
  }, true],

  ['POST', /^\/api\/me\/packages$/, c => { vendorOnly(c.u); const p = Object.assign({ id: rid() }, pkgIn(c.body)); c.u.pkgs.push(p); save(); return p; }, true],
  ['PUT', /^\/api\/me\/packages\/(\w+)$/, c => {
    vendorOnly(c.u); const i = c.u.pkgs.findIndex(p => p.id === c.m[1]); if (i < 0) fail(404, 'Package not found.');
    c.u.pkgs[i] = Object.assign({ id: c.m[1] }, pkgIn(c.body)); save(); return c.u.pkgs[i];
  }, true],
  ['DELETE', /^\/api\/me\/packages\/(\w+)$/, c => {
    vendorOnly(c.u); if (c.u.pkgs.length < 2) fail(400, 'Keep at least one package.');
    c.u.pkgs = c.u.pkgs.filter(p => p.id !== c.m[1]); save(); return { ok: true };
  }, true],

  ['GET', /^\/api\/vendors$/, c => {
    const { cat, camp, q } = c.q, s = (q || '').toLowerCase();
    return Object.values(db.users).filter(v => v.role === 'vendor' && v.pkgs.length && (!cat || v.cat === cat) && (!camp || v.camp === camp)
      && (!s || (v.name + ' ' + v.pkgs.map(p => p.nm).join(' ')).toLowerCase().includes(s))).map(pub);
  }, true],
  ['GET', /^\/api\/vendors\/(\w+)$/, c => {
    const v = db.users[c.m[1]]; if (!v || v.role !== 'vendor') fail(404, 'Vendor not found.'); return pub(v);
  }, true],

  ['POST', /^\/api\/bookings$/, async c => {
    if (c.u.role !== 'corper') fail(403, 'Only corps members can book.');
    const v = db.users[c.body.vendorId]; if (!v || v.role !== 'vendor') fail(404, 'Vendor not found.');
    const p = v.pkgs.find(x => x.id === c.body.pkgId); if (!p) fail(404, 'Package not found.');
    const b = { id: rid(), corperId: c.u.id, vendorId: v.id, what: p.nm, price: p.price, stage: 1,
                when: str(c.body.when, 60), where: str(c.body.where, 80), rated: false, created: Date.now() };
    if (!PAY_KEY) { db.bookings[b.id] = b; save(); return bview(b); }        // test mode: no real money, held straight away
    b.stage = 0; b.ref = 'tm_' + b.id;                                       // stage 0 = waiting for the bank payment
    const base = process.env.APP_URL || ((c.req.headers['x-forwarded-proto'] || 'http') + '://' + c.req.headers.host);
    let d; try {
      d = await paystack('POST', '/transaction/initialize', { email: c.u.phone + '@trustme.app', amount: b.price * 100, reference: b.ref,
        callback_url: base.replace(/\/$/, '') + '/', channels: ['bank', 'bank_transfer', 'ussd', 'card'], metadata: { bookingId: b.id } });
    } catch (e) { fail(502, 'Could not reach the payment provider. Try again.'); }
    db.bookings[b.id] = b; save(); return Object.assign(bview(b), { payUrl: d.authorization_url });
  }, true],
  ['POST', /^\/api\/payments\/verify$/, async c => {
    const b = Object.values(db.bookings).find(x => x.ref && x.ref === c.body.reference && x.corperId === c.u.id); if (!b) fail(404, 'Payment not found.');
    if (b.stage === 0) {
      let d; try { d = await paystack('GET', '/transaction/verify/' + encodeURIComponent(b.ref)); } catch (e) { fail(502, 'Could not check the payment. Try again.'); }
      if (d.status !== 'success' || d.amount < b.price * 100) fail(402, 'That payment was not completed.');
      b.stage = 1; b.paidAt = Date.now(); save();
    }
    return bview(b);
  }, true],
  ['POST', /^\/api\/paystack\/webhook$/, c => {      // Paystack tells us the moment a payment succeeds, even if the app was closed
    const sig = crypto.createHmac('sha512', PAY_KEY || 'x').update(c.raw || '').digest('hex');
    if (!PAY_KEY || sig !== c.req.headers['x-paystack-signature']) fail(401, 'Bad signature.');
    const d = c.body.data || {}, b = Object.values(db.bookings).find(x => x.ref && x.ref === d.reference);
    if (c.body.event === 'charge.success' && b && b.stage === 0 && d.amount >= b.price * 100) { b.stage = 1; b.paidAt = Date.now(); save(); }
    const ev = String(c.body.event || '');
    if (ev.startsWith('transfer.')) {         // a payout to a vendor's bank finished, failed, or was sent back
      const p = Object.values(db.payouts).find(x => x.ref && x.ref === d.reference);
      if (p && applyTransfer(p, ev.slice(9))) save();
    }
    return { ok: true };
  }, false],
  ['GET', /^\/api\/bookings$/, c => Object.values(db.bookings)
    .filter(b => b[c.u.role === 'vendor' ? 'vendorId' : 'corperId'] === c.u.id && (b.stage > 0 || c.u.role !== 'vendor'))
    .sort((a, b) => b.created - a.created).map(bview), true],
  ['POST', /^\/api\/bookings\/(\w+)\/advance$/, c => {
    const b = db.bookings[c.m[1]]; if (!b || (b.vendorId !== c.u.id && b.corperId !== c.u.id)) fail(404, 'Booking not found.');
    const v = c.u.role === 'vendor';
    if (!((v && (b.stage === 1 || b.stage === 2)) || (!v && b.stage === 3))) fail(409, 'That step is not available right now.');
    b.stage++; b.updated = Date.now();
    if (b.stage === 4) { db.users[b.vendorId].jobs = (db.users[b.vendorId].jobs || 0) + 1; credit(b); }
    save(); return bview(b);
  }, true],

  ['POST', /^\/api\/bookings\/(\w+)\/review$/, c => {
    const b = db.bookings[c.m[1]]; if (!b || b.corperId !== c.u.id) fail(404, 'Booking not found.');
    if (b.stage !== 4) fail(409, 'You can review once the job is done.'); if (b.rating) fail(409, 'You already reviewed this job.');
    const r = Math.round(+c.body.rating); if (!(r >= 1 && r <= 5)) fail(400, 'Pick a rating from 1 to 5.');
    b.rating = r; b.text = str(c.body.text, 300) || 'Booked through Trust Me.'; b.reviewed = Date.now(); save(); return bview(b);
  }, true],

  ['GET', /^\/api\/banks$/, async c => { vendorOnly(c.u); return bankList(); }, true],
  ['GET', /^\/api\/wallet$/, async c => { vendorOnly(c.u); await reconcile(c.u.id); return walletView(c.u); }, true],
  ['POST', /^\/api\/wallet\/pin$/, c => {         // the withdrawal PIN: needed to move money out, on top of everything else
    vendorOnly(c.u); const u = c.u, pin = pinOf(c.body.pin);
    if (u.wPinHash) checkPin(u.wPinHash, str(c.body.oldPin, 6));
    u.wPinHash = setPin(pin); save(); return walletView(u);
  }, true],
  ['POST', /^\/api\/wallet\/bank\/otp$/, c => {          // changing where money goes needs a code sent to the vendor's phone
    vendorOnly(c.u); const code = sendCode('bank:' + c.u.phone, c.u.phone); return { ok: true, ...(code ? { devCode: code } : {}) };
  }, true],
  ['PUT', /^\/api\/wallet\/bank$/, async c => {
    vendorOnly(c.u);
    const acct = String(c.body.account || '').replace(/\s/g, ''); if (!/^\d{10}$/.test(acct)) fail(400, 'Enter the 10-digit account number.');
    const bk = (await bankList()).find(x => x.code === String(c.body.bank)); if (!bk) fail(400, 'Choose your bank.');
    let acctName = str(c.u.name, 40).toUpperCase() || 'ACCOUNT HOLDER', recipient = 'test';
    if (PAY_KEY) {
      try { acctName = (await paystack('GET', '/bank/resolve?account_number=' + acct + '&bank_code=' + encodeURIComponent(bk.code))).account_name; }
      catch (e) { fail(e.api ? 422 : 502, e.api ? 'We could not find that account. Check the number and the bank.' : 'Could not check the account. Try again.'); }
    }
    checkCode('bank:' + c.u.phone, c.body.code);
    if (PAY_KEY) {
      try { recipient = (await paystack('POST', '/transferrecipient', { type: 'nuban', name: acctName, account_number: acct, bank_code: bk.code, currency: 'NGN' })).recipient_code; }
      catch (e) { fail(502, 'Could not save the account. Try again.'); }
    }
    c.u.bank = { code: bk.code, name: bk.name, acct, acctName, recipient, at: Date.now() }; save(); return walletView(c.u);
  }, true],
  ['POST', /^\/api\/wallet\/withdraw$/, async c => {
    vendorOnly(c.u); const u = c.u, bk = u.bank; if (!bk) fail(400, 'Add your bank account first.');
    if (!u.wPinHash) fail(409, 'Set a withdrawal PIN first.', { needPin: true });
    checkPin(u.wPinHash, str(c.body.pin, 6));
    if (Object.values(db.payouts).some(p => p.uid === u.id && p.status === 'processing' && p.live === !!PAY_KEY)) fail(409, 'You have a payout on its way. Wait for it to finish.');
    const bal = wallet(u.id).balance, amt = c.body.all ? bal : Math.floor(+c.body.amount);
    if (!(amt >= MIN_WITHDRAW)) fail(400, 'The smallest withdrawal is ₦' + MIN_WITHDRAW.toLocaleString('en-NG') + '.');
    if (amt > bal) fail(409, 'That is more than your available balance.');
    const id = rid(), p = db.payouts[id] = { id, uid: u.id, amt, status: 'processing', ref: 'tmw_' + id, live: !!PAY_KEY, at: Date.now(),
      to: bk.name + ' ••••' + bk.acct.slice(-4) };
    save();                                       // the money leaves the balance here, before the bank is called
    if (!PAY_KEY) { p.status = 'success'; p.updated = Date.now(); save(); return walletView(u); }        // test mode: pretend it was sent
    try {
      const t = await paystack('POST', '/transfer', { source: 'balance', amount: amt * 100, recipient: bk.recipient, reference: p.ref, reason: 'Trust Me payout' });
      p.code = t.transfer_code; applyTransfer(p, t.status); save();
      if (p.status === 'failed') { console.error('[payout] not accepted', p.ref, t.status); fail(502, 'The payout could not be sent. Your money is back in your balance.'); }
    } catch (e) {
      if (e && e.c) throw e;
      if (e.api) { p.status = 'failed'; p.updated = Date.now(); save(); console.error('[payout] refused', p.ref, e.message); fail(502, 'The payout could not be sent. Your money is back in your balance.'); }
      console.error('[payout] no answer, will re-check', p.ref, e.message);      // unknown outcome: it stays "on its way" until the webhook or a re-check settles it
    }
    return walletView(u);
  }, true],

  ['POST', /^\/api\/messages$/, c => {
    const to = db.users[c.body.to]; if (!to || to.role === c.u.role) fail(400, 'You can only message the other side.');
    const text = str(c.body.text, 1000);
    let img = null;
    if (c.body.img) {
      img = String(c.body.img);
      if (img.length > 900000) fail(413, 'That photo is too large.');
      if (!/^data:image\/[a-z+]+;base64,[A-Za-z0-9+\/=]+$/.test(img)) fail(400, 'That photo is not valid.');
    }
    if (!text && !img) fail(400, 'Write a message first.');
    let replyTo = null;
    if (c.body.replyTo) {
      const q = db.messages.find(x => x.id === str(c.body.replyTo, 20)
        && ((x.from === c.u.id || x.to === c.u.id) && (x.from === to.id || x.to === to.id)));   // only messages from this same thread
      if (q) replyTo = q.id;
    }
    const m = { id: rid(), from: c.u.id, to: to.id, text, img, replyTo, at: Date.now() };
    db.messages.push(m); save(); return mview(m);
  }, true],
  ['GET', /^\/api\/messages$/, c => {
    const last = {}; db.messages.forEach(m => { if (m.from === c.u.id || m.to === c.u.id) last[m.from === c.u.id ? m.to : m.from] = m; });
    return Object.entries(last).map(([o, m]) => ({ with: pub(db.users[o]), last: mview(m) })).sort((a, b) => b.last.at - a.last.at);
  }, true],
  ['GET', /^\/api\/messages\/(\w+)$/, c => db.messages.filter(m => (m.from === c.u.id && m.to === c.m[1]) || (m.to === c.u.id && m.from === c.m[1])).map(mview), true],
];

const readBody = req => new Promise((ok, no) => {
  let s = ''; req.on('data', d => { s += d; if (s.length > 3e6) { no({ c: 413, m: 'Request too large.' }); req.destroy(); } });
  req.on('end', () => { req.rawBody = s; try { ok(s ? JSON.parse(s) : {}); } catch (e) { no({ c: 400, m: 'Bad JSON.' }); } });
});

http.createServer(async (req, res) => {
  const cors = { 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS' };
  const send = (code, obj) => { res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, cors)); res.end(JSON.stringify(obj)); };
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {          // serves the app itself at /
    return fs.readFile(FRONTEND, (e, d) => {
      if (e) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d);
    });
  }
  try {
    const body = (req.method === 'GET' || req.method === 'DELETE') ? {} : await readBody(req);
    for (const [method, re, fn, needAuth] of routes) {
      const m = req.method === method && url.pathname.match(re); if (!m) continue;
      const c = { body, m, req, raw: req.rawBody, q: Object.fromEntries(url.searchParams) }; if (needAuth) c.u = auth(req);
      return send(200, await fn(c));
    }
    send(404, { error: 'Not found' });
  } catch (e) {
    if (e && e.c) { const { c: code, m, ...extra } = e; return send(code, Object.assign({ error: m }, extra)); }
    console.error(e); send(500, { error: 'Something went wrong.' });
  }
}).listen(PORT, () => console.log('Trust Me backend on port ' + PORT));

# Light Bearers Child Care Centre — portal

Two pages, no build step:

| File | Who it's for |
| --- | --- |
| `index.html` | Parents — sign in, enrol a child, upload documents, pay fees, read notices |
| `admin.html` | Staff — approve applications, issue student numbers, publish notices, track fees |

Data lives in **Supabase** (Postgres + Auth + Storage), so a parent on their phone
and the office on a PC see the **same** records, live.

```
index.html ─┐
            ├─► lb-store.js ─► Supabase (Postgres · Auth · Storage · Realtime)
admin.html ─┘        ▲
                     └── config.js (your project URL + anon key)
```

---

## 1. Set up Supabase (once, ~5 minutes)

1. Create a project at <https://supabase.com> (free tier is fine).
2. **SQL Editor → New query** → paste the whole of `supabase/schema.sql` → **Run**.
   This creates every table, security rule, storage bucket and function. It is
   safe to run more than once.
3. **Project Settings → API** → copy **Project URL** and the **anon public** key
   into `config.js`:

   ```js
   window.LB_CONFIG = {
     supabaseUrl: "https://abcdefgh.supabase.co",
     supabaseAnonKey: "eyJhbGciOi..."
   };
   ```

4. **Authentication → URL Configuration** → add your site to *Redirect URLs*, e.g.
   - `https://stifmaster.vercel.app/`
   - `https://stifmaster.vercel.app/admin.html`
   - `http://localhost:8123/` (for local testing)

### Sign-in options

- **Email + password** works out of the box.
- **Continue with Google**: *Authentication → Providers → Google* → paste a Google
  Cloud OAuth client ID/secret. In Google Cloud, set the authorised redirect URI to
  `https://YOUR-PROJECT-REF.supabase.co/auth/v1/callback`.
- **Student number → one-time sign-in link**: needs email delivery. The built-in
  Supabase mailer works but is rate-limited; add your own SMTP under
  *Project Settings → Auth → SMTP* for production.

> Tip for testing: *Authentication → Providers → Email* → turn **Confirm email**
> off so new accounts can sign in immediately.

### Make yourself staff

Sign in to `admin.html` once (this creates your profile row), then run in the SQL
editor:

```sql
update public.profiles set role = 'admin' where email = 'YOUR-EMAIL@example.com';
```

After that you can promote colleagues from **admin.html → Settings → Staff access**.

---

## 2. Run it

Because both pages share one origin, serve the folder over HTTP (not `file://`):

```powershell
python -m http.server 8123 --directory .
# then open http://127.0.0.1:8123/
```

On Vercel it's already static — just push. `main` deploys to production; any other
branch gets a preview URL.

---

## 3. What works

- Parent signs in (Google, email+password, or student-number link) and submits the
  enrolment form with real name, full address, children and emergency contact.
- **Multiple children / multiple applications.** A parent can enrol another child at
  any time — even while one child is already enrolled. Student numbers, invoices,
  messages and the dashboard all aggregate across every application.
- Parent uploads **ID** and **proof of address**; files go to a **private** storage
  bucket and are only visible to that parent and staff. If they can't attach them yet
  (foreign documents, a bill in someone else's name…), they type **why** in a box on
  the form and can still submit — the note is shown to staff.
- Staff see new applications **without refreshing** (Realtime) and approve or dismiss.
- Approving issues a unique student number (`LB26-1001`, `LB26-1002`, …), creates the
  month's invoice and posts a welcome notice.
- **Child photos.** After approval the parent is *promptly but never forced* to upload
  two photos of each child. They show up as round avatars next to the account, in the
  header, and on the learner card.
- Fees: pay in full, pay half now and settle the rest in N days, or clear the balance.
  Every payment is recorded with a reference.
- Notices: trips, menu changes, parties, farewells, educational, uniform, hygiene,
  emergency and fees — targeted to everyone, a programme, or one learner, with unread
  badges.
- **Personal messages.** From a learner's card, staff pick a category, type a subject
  and body, and send. A greeting, the child's name and their student number are added
  automatically; the message lands in the parent's portal **and** their inbox.
- **Broadcast.** One button posts an on-site notice to every approved parent and emails
  them all at once.
- Dismissal: the portal locks for that family; they get **one** appeal, which staff can
  uphold or accept (undismiss). Undismissing restores access and keeps the student number.
- Every email is logged in **admin.html → Emails** as `queued → sent / failed`, with the
  delivery error kept on the row. SMS is only ever sent when it's free of charge; with no
  free gateway configured, SMS attempts are logged as `skipped` and email is used instead.

---

## 4. Real email (Resend)

Email is delivered by the Supabase Edge Function `supabase/functions/send-email`
(which calls [Resend](https://resend.com)). The API key never touches the browser:
only a signed-in **staff** account can invoke the function.

1. Create a Resend account and verify a sending domain (or use their test sender
   `onboarding@resend.dev` while you try it out).
2. **Dashboard → Edge Functions → Create function**, name it **`send-email`**, and paste
   the contents of `supabase/functions/send-email/index.ts`. Deploy it.
3. **Edge Functions → send-email → Secrets** (or `supabase secrets set`) and add:
   - `RESEND_API_KEY` = `re_...`
   - `MAIL_FROM` = `Light Bearers <hello@yourdomain.co.za>` (optional)
4. In **admin.html → Settings**, set the **Email “from”** address to the same verified
   sender, then save.

That's it — approvals, dismissals, appeals, personal messages and broadcasts now send
real mail and appear in the Outbox.

---

## 5. Security notes

- `config.js` holds the **anon** key only. It's public by design; Row Level Security
  enforces what each signed-in user can read or write. Never put the `service_role`
  key in this repo.
- Parents can only ever see their own application, children, documents, invoices and
  the notices addressed to them.
- Everything privileged (approving, student numbers, settings, outbox, sending email)
  runs through Postgres functions or the Edge Function that check `is_admin()`.

## 6. Still to do for real money

The pay button records payments but does **not** talk to Yoco yet. Going live needs a
small backend so the Yoco **secret key** and **webhook** stay off the browser:

1. `POST /api/checkout` — creates a Yoco checkout for an invoice and returns its URL.
2. Parent pays on Yoco; Yoco calls your **webhook**.
3. Webhook verifies the signature, then calls `record_payment(...)` server-side and
   marks the invoice paid.

The database side (`record_payment`, `invoices`, `payments`) is already in place for that.

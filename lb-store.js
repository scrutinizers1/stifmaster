/* ============================================================================
   Light Bearers — shared Supabase data layer  (lb-store.js)
   ----------------------------------------------------------------------------
   Loaded by BOTH index.html and admin.html.  It talks to Supabase and hands the
   pages back the same "DB" object shape the original localStorage build used, so
   the views barely changed — only saving/loading moved to the server.

   Needs, in this order, before this file:
       <script src=".../supabase-js@2"></script>
       <script src="config.js"></script>
       <script src="lb-store.js"></script>

   Then:   await LB.ready;            // session restored + first load done
           LB.db                      // the DB snapshot
           await LB.load();           // refresh the snapshot
   ============================================================================ */
(function () {
  'use strict';

  var cfg = window.LB_CONFIG || {};
  var url = String(cfg.supabaseUrl || '').trim();
  var key = String(cfg.supabaseAnonKey || '').trim();
  var lib = (window.supabase && window.supabase.createClient) ? window.supabase : null;
  var looksReal = /^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i.test(url.replace(/\/+$/, ''));
  var configured = !!(lib && looksReal && key.length > 20 && url.indexOf('YOUR-') === -1 && key.indexOf('YOUR-') === -1);

  var sb = configured
    ? lib.createClient(url, key, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      })
    : null;

  function emptyDB() {
    return { users: {}, apps: [], docs: {}, photos: {}, invoices: [], settings: {},
             messages: [], outbox: [], read: {}, profiles: [] };
  }

  var state = { session: null, user: null, profile: null, ready: false };
  var listeners = [];
  var db = emptyDB();
  var appById = {};
  var appIdForUser = null;
  var channel = null;
  var reloadTimer = null;

  function err(e) {
    if (!e) return new Error('Unknown error');
    if (typeof e === 'string') return new Error(e);
    return new Error(e.message || e.error_description || e.hint || JSON.stringify(e));
  }
  function need() {
    if (!sb) throw new Error('Supabase is not configured. Add your Project URL and anon key to config.js.');
  }

  /* ------------------------------------------------------------------ fees */
  function fees() {
    var out = {};
    /* PROGRAMS is declared with `const` in the pages, so it lives in the global
       lexical scope, not on `window`. Try the binding first, then window. */
    var P = (typeof PROGRAMS !== 'undefined' && PROGRAMS) ? PROGRAMS : (window.PROGRAMS || {});
    Object.keys(P).forEach(function (k) { out[k] = P[k].fee; });
    return out;
  }

  /* ------------------------------------------------------------- hydrate */
  async function load() {
    if (!sb) { db = emptyDB(); return db; }

    var sres = await sb.auth.getSession();
    var session = sres && sres.data ? sres.data.session : null;
    state.session = session || null;
    state.user = session ? session.user : null;
    state.profile = null;

    if (!session) { db = emptyDB(); return db; }

    var res = await Promise.all([
      sb.from('profiles').select('id,email,name,picture,role,created_at'),
      sb.from('applications').select('*, children(*)').order('submitted_at', { ascending: true }),
      sb.from('documents').select('*'),
      sb.from('invoices').select('*, payments(*)').order('period', { ascending: true }),
      sb.from('messages').select('*').order('at', { ascending: true }),
      sb.from('message_reads').select('message_id'),
      sb.from('outbox').select('*').order('at', { ascending: false }),
      sb.from('settings').select('key,value')
    ]);

    var names = ['profiles', 'applications', 'documents', 'invoices', 'messages', 'message_reads', 'outbox', 'settings'];
    for (var i = 0; i < res.length; i++) {
      if (res[i].error) throw new Error('Could not load ' + names[i] + ': ' + res[i].error.message +
        ' — have you run supabase/schema.sql?');
    }

    var profiles = res[0].data || [];
    var apps = res[1].data || [];
    var docs = res[2].data || [];
    var invoices = res[3].data || [];
    var messages = res[4].data || [];
    var reads = res[5].data || [];
    var outbox = res[6].data || [];
    var settings = res[7].data || [];

    /* --- users --- */
    var users = {};
    profiles.forEach(function (p) {
      users[p.email] = { id: p.id, email: p.email, name: p.name, picture: p.picture,
                         role: p.role, createdAt: p.created_at };
    });

    /* --- applications + children --- */
    appById = {};
    var appsArr = apps.map(function (a) {
      var app = {
        id: a.id, userId: a.user_id, email: a.email,
        parentName: a.parent_name, phone: a.phone, altPhone: a.alt_phone, relation: a.relation,
        address: a.address || {}, emergency: a.emergency || {},
        status: a.status, submittedAt: a.submitted_at, reviewedAt: a.reviewed_at,
        reviewNote: a.review_note || '', appeal: a.appeal || null, appealStatus: a.appeal_status || 'none',
        documentsNote: a.documents_note || '',
        children: (a.children || []).map(function (c) {
          return { id: c.id, name: c.name, dob: c.dob, gender: c.gender,
                   program: c.program, medical: c.medical, studentNo: c.student_no };
        }).sort(function (x, y) { return String(x.name).localeCompare(String(y.name)); })
      };
      appById[app.id] = app;
      return app;
    });

    var childOwner = {};
    var childById = {};
    appsArr.forEach(function (a) {
      a.children.forEach(function (c) { childOwner[c.id] = a; childById[c.id] = { child: c, app: a }; });
    });

    /* --- invoices + payments --- */
    var invArr = invoices.map(function (v) {
      var owner = childOwner[v.child_id] || {};
      return {
        id: v.id, childId: v.child_id, childName: v.child_name, program: v.program,
        period: v.period, amount: Number(v.amount || 0), paid: Number(v.paid || 0),
        status: v.status, plan: !!v.plan, dueDate: v.due_date, createdAt: v.created_at,
        email: owner.email || '',
        payments: (v.payments || []).map(function (p) {
          return { at: p.at, amount: Number(p.amount || 0), method: p.method, ref: p.ref };
        }).sort(function (a, b) { return new Date(a.at) - new Date(b.at); })
      };
    });

    /* --- messages --- */
    var msgArr = messages.map(function (m) {
      return { id: m.id, title: m.title, body: m.body, category: m.category,
               audience: m.audience, target: m.target, important: !!m.important,
               author: m.author, at: m.at,
               kind: m.kind || 'broadcast', childId: m.child_id || null,
               childName: m.child_name || '', studentNo: m.student_no || '',
               recipient: m.recipient || '', greeting: m.greeting || '',
               channel: m.channel || 'site' };
    });

    /* --- read receipts (only mine come back) --- */
    var read = {};
    if (state.user) read[state.user.email] = reads.map(function (r) { return r.message_id; });

    /* --- outbox --- */
    var outArr = outbox.map(function (e) {
      return { id: e.id, to: e.to_email, subject: e.subject, body: e.body,
               status: e.status, provider: e.provider, at: e.at,
               channel: e.channel || 'email', kind: e.kind || 'transactional',
               messageId: e.message_id || null, error: e.error || '' };
    });

    /* --- settings (flat) --- */
    var set = {};
    settings.forEach(function (r) { set[r.key] = r.value; });

    /* --- documents -> signed URLs, grouped by parent email --- */
    var docUrls = await Promise.all(docs.map(function (d) {
      if (!d.file_path) return Promise.resolve(null);
      return sb.storage.from('documents').createSignedUrl(d.file_path, 3600)
        .then(function (r) { return r && r.data ? r.data.signedUrl : null; })
        .catch(function () { return null; });
    }));
    var docsByEmail = {};
    var photosByChild = {};
    docs.forEach(function (d, i) {
      var rec = { name: d.file_name, type: d.mime, dataUrl: docUrls[i] || '',
                  at: d.uploaded_at, path: d.file_path, kind: d.kind };
      if (d.child_id) {
        (photosByChild[d.child_id] = photosByChild[d.child_id] || []).push(rec);
        return;
      }
      var owner = appById[d.application_id];
      if (!owner) return;
      docsByEmail[owner.email] = docsByEmail[owner.email] || {};
      docsByEmail[owner.email][d.kind] = rec;
    });
    Object.keys(photosByChild).forEach(function (k) {
      photosByChild[k].sort(function (a, b) {
        return String(a.kind).localeCompare(String(b.kind)) || (new Date(a.at) - new Date(b.at));
      });
    });

    /* --- me --- */
    state.profile = state.user ? (users[state.user.email] || null) : null;
    appIdForUser = null;
    if (state.user) {
      var mine = appsArr.filter(function (a) { return a.email === state.user.email; });
      if (mine.length) appIdForUser = mine[mine.length - 1].id;
    }

    db = {
      users: users, apps: appsArr, docs: docsByEmail, photos: photosByChild, invoices: invArr,
      settings: set, messages: msgArr, outbox: outArr, read: read,
      profiles: profiles.map(function (p) {
        return { id: p.id, email: p.email, name: p.name, role: p.role, createdAt: p.created_at };
      })
    };
    return db;
  }

  /* ------------------------------------------------------------ realtime */
  function startRealtime() {
    if (!sb || channel) return;
    channel = sb.channel('lb-sync')
      .on('postgres_changes', { event: '*', schema: 'public' }, function () { scheduleReload(); })
      .subscribe();
  }
  function stopRealtime() {
    if (channel && sb) { try { sb.removeChannel(channel); } catch (e) {} }
    channel = null;
  }
  function scheduleReload() {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(function () { reloadTimer = null; refresh(); }, 350);
  }
  async function refresh() {
    try { await load(); } catch (e) { /* keep the last good snapshot */ }
    listeners.forEach(function (cb) { try { cb(db); } catch (e) {} });
  }

  /* --------------------------------------------------------------- events */
  function onChange(cb) { listeners.push(cb); return function () { listeners = listeners.filter(function (f) { return f !== cb; }); }; }
  function notify() { listeners.forEach(function (cb) { try { cb(db); } catch (e) {} }); }

  /* ----------------------------------------------------------------- auth */
  function redirectTo() {
    return location.origin + location.pathname;
  }
  async function signInGoogle() {
    need();
    var r = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: redirectTo() } });
    if (r.error) throw err(r.error);
    return true;
  }
  async function signUpEmail(email, password, name) {
    need();
    var r = await sb.auth.signUp({ email: email, password: password,
      options: { data: { full_name: name || '' }, emailRedirectTo: redirectTo() } });
    if (r.error) throw err(r.error);
    return r.data;
  }
  async function signInEmail(email, password) {
    need();
    var r = await sb.auth.signInWithPassword({ email: email, password: password });
    if (r.error) throw err(r.error);
    return r.data;
  }
  async function signOut() {
    need();
    stopRealtime();
    await sb.auth.signOut();
    state.session = null; state.user = null; state.profile = null;
    db = emptyDB();
  }
  async function emailForStudentNo(no) {
    need();
    var r = await sb.rpc('email_for_student_no', { p_no: String(no || '').trim() });
    if (r.error) throw err(r.error);
    return r.data || null;
  }
  async function studentNoLogin(no) {
    need();
    var email = await emailForStudentNo(no);
    if (!email) throw new Error('No approved learner was found with that student number.');
    var r = await sb.auth.signInWithOtp({ email: email,
      options: { shouldCreateUser: false, emailRedirectTo: redirectTo() } });
    if (r.error) throw err(r.error);
    return email;
  }
  async function sendMagicLink(email) {
    need();
    var r = await sb.auth.signInWithOtp({ email: email, options: { emailRedirectTo: redirectTo() } });
    if (r.error) throw err(r.error);
    return true;
  }

  /* ---------------------------------------------------------- mutations */
  async function submitApplication(payload) {
    need();
    if (!state.user) throw new Error('Please sign in first.');
    var ins = await sb.from('applications').insert({
      user_id: state.user.id,
      email: state.user.email,
      parent_name: payload.parentName, phone: payload.phone, alt_phone: payload.altPhone,
      relation: payload.relation, address: payload.address, emergency: payload.emergency,
      documents_note: payload.documentsNote || '',
      status: 'pending'
    }).select('id').single();
    if (ins.error) throw err(ins.error);
    var appId = ins.data.id;
    var rows = payload.children.map(function (c) {
      return { application_id: appId, name: c.name, dob: c.dob || null, gender: c.gender,
               program: c.program, medical: c.medical };
    });
    var ci = await sb.from('children').insert(rows);
    if (ci.error) throw err(ci.error);
    await load(); notify();
    return appId;
  }

  async function uploadDocument(kind, file, opts) {
    need();
    opts = opts || {};
    if (!state.user) throw new Error('Please sign in first.');
    var appId = opts.applicationId || appIdForUser;
    if (!appId) throw new Error('Please fill in the enrolment form before uploading documents.');
    var childId = opts.childId || null;
    var ext = (file.name.split('.').pop() || 'bin').toLowerCase();
    var path = state.user.id + '/' + appId + '/' +
               (childId ? 'photo-' + childId + '-' : '') + kind + '-' + Date.now() + '.' + ext;

    var up = await sb.storage.from('documents').upload(path, file, { upsert: true, contentType: file.type });
    if (up.error) throw err(up.error);

    var del = sb.from('documents').delete().eq('application_id', appId).eq('kind', kind);
    del = childId ? del.eq('child_id', childId) : del.is('child_id', null);
    var dr = await del;
    if (dr.error) throw err(dr.error);

    var ins = await sb.from('documents').insert({
      application_id: appId, child_id: childId, kind: kind, file_path: path,
      file_name: file.name, mime: file.type
    });
    if (ins.error) throw err(ins.error);
    await load(); notify();
  }

  /* Upload one of the two child photos shown next to the parent's account.
     Slot 0 -> 'photo1', slot 1 -> 'photo2', so the two never overwrite each other. */
  async function uploadChildPhoto(childId, file, slot) {
    need();
    var owner = null;
    db.apps.forEach(function (a) {
      (a.children || []).forEach(function (c) { if (c.id === childId) owner = a; });
    });
    if (!owner) throw new Error('Learner not found.');
    var kind = 'photo' + ((Number(slot) || 0) + 1);
    return uploadDocument(kind, file, { applicationId: owner.id, childId: childId });
  }

  async function recordPayment(invoiceId, amount, method, plan) {
    need();
    var r = await sb.rpc('record_payment', {
      p_invoice: invoiceId, p_amount: Math.round(amount), p_method: method, p_plan: !!plan
    });
    if (r.error) throw err(r.error);
    await load(); notify();
    return r.data;
  }

  async function markRead(ids) {
    need();
    if (!state.user || !ids || !ids.length) return;
    var rows = ids.map(function (id) { return { message_id: id, user_id: state.user.id }; });
    var r = await sb.from('message_reads').upsert(rows, { onConflict: 'message_id,user_id', ignoreDuplicates: true });
    if (r.error) throw err(r.error);
    await load(); notify();
  }

  async function submitAppeal(appId, text) {
    need();
    var r = await sb.rpc('submit_appeal', { p_app: appId, p_text: text });
    if (r.error) throw err(r.error);
    await load(); notify();
  }

  async function ensureMyInvoices() {
    need();
    var r = await sb.rpc('ensure_my_invoices', { p_fees: fees() });
    if (r.error) throw err(r.error);
    if (r.data) { await load(); notify(); }
    return r.data || 0;
  }

  /* ------------------------------------------------------------- admin */
  async function approve(appId, asPending) {
    need();
    var r = await sb.rpc('approve_application', {
      p_app: appId, p_fees: fees(), p_status: asPending ? 'pending' : 'approved'
    });
    if (r.error) throw err(r.error);
    await load();
    return (r.data && r.data.issued) || [];
  }
  async function dismiss(appId, note) {
    need();
    var r = await sb.rpc('dismiss_application', { p_app: appId, p_note: note || '' });
    if (r.error) throw err(r.error);
    await load(); notify();
  }
  async function decideAppeal(appId, accept) {
    need();
    var r = await sb.rpc('decide_appeal', { p_app: appId, p_accept: !!accept });
    if (r.error) throw err(r.error);
    await load(); notify();
  }
  async function ensureInvoicesFor(appId) {
    need();
    var r = await sb.rpc('ensure_invoices_for', { p_app: appId, p_fees: fees() });
    if (r.error) throw err(r.error);
    if (r.data) { await load(); notify(); }
    return r.data || 0;
  }
  async function publishMessage(m) {
    need();
    var r = await sb.from('messages').insert({
      title: m.title, body: m.body, category: m.category, audience: m.audience,
      target: m.target || null, important: !!m.important, author: m.author || 'Front office'
    });
    if (r.error) throw err(r.error);
    await load(); notify();
  }
  async function deleteMessage(id) {
    need();
    var r = await sb.from('messages').delete().eq('id', id);
    if (r.error) throw err(r.error);
    await load(); notify();
  }
  async function saveSettings(obj) {
    need();
    var rows = Object.keys(obj).map(function (k) { return { key: k, value: obj[k] }; });
    var r = await sb.from('settings').upsert(rows, { onConflict: 'key' });
    if (r.error) throw err(r.error);
    await load(); notify();
  }
  async function setRole(userId, role) {
    need();
    var r = await sb.from('profiles').update({ role: role }).eq('id', userId);
    if (r.error) throw err(r.error);
    await load(); notify();
  }
  /* Real email delivery through the Supabase Edge Function `send-email`
     (which calls Resend). Every attempt is logged in the outbox as
     queued -> sent / failed, with the reason kept on the row. */
  async function sendEmail(o) {
    need();
    var rec = {
      to_email: o.to, subject: o.subject, body: o.body,
      status: 'queued', provider: 'resend',
      channel: o.channel || 'email', kind: o.kind || 'transactional',
      message_id: o.messageId || null, error: null
    };
    var ins = await sb.from('outbox').insert(rec).select('id').single();
    if (ins.error) throw err(ins.error);
    var id = ins.data.id;

    var status = 'failed', detail = '';
    try {
      var r = await sb.functions.invoke('send-email', {
        body: {
          to: o.to, subject: o.subject, body: o.body,
          from: (db.settings && db.settings.mailFrom) || undefined,
          replyTo: o.replyTo || undefined
        }
      });
      if (r.error) {
        detail = r.error.message || String(r.error);
        // FunctionsHttpError carries the Response in .context — read the JSON body
        // so the real reason ("RESEND_API_KEY is not set", etc.) reaches the Outbox.
        try {
          var ctx = r.error.context;
          if (ctx && typeof ctx.json === 'function') {
            var j = await ctx.json();
            if (j && j.error) detail = j.error;
          }
        } catch (e2) { /* keep the generic message */ }
      } else if (r.data && r.data.error) {
        detail = r.data.error;
      } else {
        status = 'sent';
      }
    } catch (e) {
      detail = e && (e.message || String(e)) || 'send failed';
    }

    var upd = await sb.from('outbox').update({ status: status, error: detail || null }).eq('id', id);
    if (upd.error) throw err(upd.error);
    await load(); notify();
    return { id: id, status: status, provider: 'resend', detail: detail };
  }

  /* SMS is only ever sent when it is free of charge. No free gateway is wired
     up, so we log the attempt as "skipped" and rely on email instead. */
  async function sendSms(phone, body, kind) {
    need();
    if (!db.settings || !db.settings.smsEnabled) return { skipped: true, reason: 'SMS turned off' };
    var r = await sb.from('outbox').insert({
      to_email: phone || '', subject: '(SMS)', body: body || '',
      status: 'skipped', provider: 'none', channel: 'sms', kind: kind || 'direct',
      error: 'No free SMS gateway configured — sent by email instead.'
    });
    if (r.error) throw err(r.error);
    await load(); notify();
    return { skipped: true, reason: 'no free gateway' };
  }

  /* Admin -> one parent, about one learner. The greeting, the learner's name and
     their student number are attached by the database, then we deliver the same
     text to the parent's email inbox and (optionally) log an SMS attempt. */
  async function sendDirectMessage(childId, category, title, body, important) {
    need();
    var r = await sb.rpc('send_direct_message', {
      p_child: childId, p_category: category || 'general',
      p_title: title || '', p_body: body, p_important: !!important
    });
    if (r.error) throw err(r.error);
    var info = r.data || {};
    await load();
    var mail = null;
    if (info.to) {
      mail = await sendEmail({ to: info.to, subject: info.subject, body: info.body,
                               kind: 'direct', messageId: info.id });
    }
    var sms = await sendSms(info.phone, info.body, 'direct');
    notify();
    return { info: info, mail: mail, sms: sms };
  }

  async function approvedParentContacts() {
    need();
    var r = await sb.rpc('approved_parent_contacts');
    if (r.error) throw err(r.error);
    return r.data || [];
  }

  /* Broadcast to every approved parent at once: an on-site notice everyone can
     read, plus a real email to each parent's inbox. */
  async function broadcast(o) {
    need();
    await publishMessage({
      title: o.title, body: o.body, category: o.category || 'general',
      audience: 'all', target: null, important: !!o.important,
      author: o.author || 'Front office'
    });
    var contacts = await approvedParentContacts();
    var sent = 0, failed = 0, results = [];
    for (var i = 0; i < contacts.length; i++) {
      var c = contacts[i];
      var res = await sendEmail({ to: c.email, subject: o.title, body: o.body, kind: 'broadcast' });
      if (res.status === 'sent') sent++; else failed++;
      results.push({ email: c.email, status: res.status, detail: res.detail });
      if (c.phone) { try { await sendSms(c.phone, o.body, 'broadcast'); } catch (e) {} }
    }
    return { recipients: contacts.length, sent: sent, failed: failed, results: results };
  }

  /* -------------------------------------------------- admin demo helpers */
  async function seedSample() {
    need();
    var ins = await sb.from('applications').insert({
      user_id: null, email: 'demo.parent@gmail.com', parent_name: 'Nomsa Khumalo',
      phone: '072 445 1180', alt_phone: '', relation: 'Mother',
      address: { line1: '18 Marula Street', suburb: 'Extension 4', city: 'Midrand',
                 province: 'Gauteng', postal: '1685' },
      emergency: { name: 'Sipho Khumalo', phone: '083 220 7710' }, status: 'pending'
    }).select('id').single();
    if (ins.error) throw err(ins.error);
    var ci = await sb.from('children').insert({
      application_id: ins.data.id, name: 'Lerato Khumalo', dob: '2023-04-12',
      gender: 'Girl', program: 'toddler', medical: 'Mild peanut allergy'
    });
    if (ci.error) throw err(ci.error);
    await load(); notify();
  }
  async function seedMessages() {
    need();
    var now = Date.now();
    var rows = [
      { title: 'School trip to the Zoo 🦁', category: 'trip', important: true,
        at: new Date(now - 3600e3).toISOString(),
        body: 'Our Pre-School and Toddler groups are going to the Zoo on Friday. Please pack a hat, a water bottle and sunscreen. Permission slips are at the office. Bus leaves at 08:30 sharp.' },
      { title: 'Menu change this week', category: 'food', at: new Date(now - 26 * 3600e3).toISOString(),
        body: 'Thursday lunch will be macaroni and cheese with a side salad instead of rice and mince. Fruit is still served at 15:00.' },
      { title: "Lerato's birthday party 🎂", category: 'party', at: new Date(now - 50 * 3600e3).toISOString(),
        body: 'We are celebrating a birthday this month! Cupcakes and juice will be provided by the centre. If your child has allergies, please let us know.' },
      { title: 'Farewell for Teacher Anne 👋', category: 'farewell', at: new Date(now - 80 * 3600e3).toISOString(),
        body: 'After 9 wonderful years, Teacher Anne is moving on. Join us for a small farewell tea on the last Friday of the month at 15:30. Children may bring a card.' }
    ].map(function (m) {
      return { title: m.title, body: m.body, category: m.category, audience: 'all',
               target: null, important: !!m.important, author: 'Front office', at: m.at };
    });
    var r = await sb.from('messages').insert(rows);
    if (r.error) throw err(r.error);
    await load(); notify();
  }
  async function resetAll() {
    need();
    var tables = ['payments', 'invoices', 'documents', 'children', 'applications',
                  'messages', 'outbox'];
    for (var i = 0; i < tables.length; i++) {
      var r = await sb.from(tables[i]).delete().not('id', 'is', null);
      if (r.error) throw err(r.error);
    }
    try {
      var list = await sb.storage.from('documents').list('', { limit: 1000 });
      if (list.data && list.data.length) {
        for (var j = 0; j < list.data.length; j++) {
          var folder = list.data[j].name;
          var inner = await sb.storage.from('documents').list(folder, { limit: 1000 });
          var paths = (inner.data || []).map(function (f) { return folder + '/' + f.name; });
          if (paths.length) await sb.storage.from('documents').remove(paths);
        }
      }
    } catch (e) { /* best effort */ }
    await load(); notify();
  }

  /* ------------------------------------------------------------ session */
  async function init() {
    if (sb) {
      sb.auth.onAuthStateChange(function (event) {
        if (event === 'SIGNED_OUT') {
          stopRealtime();
          state.session = null; state.user = null; state.profile = null; db = emptyDB();
          listeners.forEach(function (cb) { try { cb(db); } catch (e) {} });
        } else if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
          setTimeout(function () { refresh().then(startRealtime); }, 0);
        }
      });
    }
    try { await load(); } catch (e) { state.loadError = e.message; }
    if (state.session) startRealtime();
    state.ready = true;
  }

  var ready = init();

  window.LB = {
    configured: configured,
    client: sb,
    ready: ready,
    get db() { return db; },
    get state() { return state; },
    user: function () { return state.user; },
    profile: function () { return state.profile; },
    session: function () { return state.session; },
    isAdmin: function () { return !!(state.profile && state.profile.role === 'admin'); },
    load: load,
    refresh: refresh,
    onChange: onChange,
    notify: notify,
    fees: fees,
    signInGoogle: signInGoogle,
    signUpEmail: signUpEmail,
    signInEmail: signInEmail,
    signOut: signOut,
    emailForStudentNo: emailForStudentNo,
    studentNoLogin: studentNoLogin,
    sendMagicLink: sendMagicLink,
    submitApplication: submitApplication,
    uploadDocument: uploadDocument,
    uploadChildPhoto: uploadChildPhoto,
    recordPayment: recordPayment,
    markRead: markRead,
    submitAppeal: submitAppeal,
    ensureMyInvoices: ensureMyInvoices,
    approve: approve,
    dismiss: dismiss,
    decideAppeal: decideAppeal,
    ensureInvoicesFor: ensureInvoicesFor,
    publishMessage: publishMessage,
    deleteMessage: deleteMessage,
    saveSettings: saveSettings,
    setRole: setRole,
    sendEmail: sendEmail,
    sendSms: sendSms,
    sendDirectMessage: sendDirectMessage,
    approvedParentContacts: approvedParentContacts,
    broadcast: broadcast,
    seedSample: seedSample,
    seedMessages: seedMessages,
    resetAll: resetAll
  };
})();

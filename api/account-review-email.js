const tls = require("tls");

const DEFAULT_SUPABASE_URL = "https://ghabfpeaoksvqfntgrff.supabase.co";
const DEFAULT_SUPABASE_KEY = "sb_publishable_Bs7EYqOC__GO21Z1T6f6Mw_AdN8rBbo";

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeHeader(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}

function encodeSubject(value) {
  return "=?UTF-8?B?" + Buffer.from(String(value || ""), "utf8").toString("base64") + "?=";
}

function formatAddress(name, email) {
  const cleanEmail = escapeHeader(email);
  const cleanName = escapeHeader(name);
  if (!cleanName) return `<${cleanEmail}>`;
  return `"${cleanName.replace(/"/g, "'")}" <${cleanEmail}>`;
}

function dotStuff(body) {
  return String(body || "").replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
}

function createMessage({ fromName, fromEmail, to, subject, text, html }) {
  const boundary = "maslog-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  const headers = [
    `From: ${formatAddress(fromName, fromEmail)}`,
    `To: ${formatAddress("", to)}`,
    `Subject: ${encodeSubject(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];

  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    text,
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    html,
    `--${boundary}--`,
    "",
  ];

  return headers.concat([""], parts).join("\r\n");
}

function completeSmtpResponse(buffer) {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n").filter(Boolean);
  const last = lines[lines.length - 1] || "";
  return /^\d{3} /.test(last);
}

function smtpSession(socket) {
  let buffer = "";
  let pending = null;

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    if (pending && completeSmtpResponse(buffer)) {
      const response = buffer;
      buffer = "";
      const resolve = pending;
      pending = null;
      resolve(response);
    }
  });

  socket.on("error", (err) => {
    if (!pending) return;
    const reject = pending.reject;
    pending = null;
    reject(err);
  });

  socket.on("close", () => {
    if (!pending) return;
    const reject = pending.reject;
    pending = null;
    reject(new Error("SMTP connection closed before a response was received"));
  });

  function read() {
    if (completeSmtpResponse(buffer)) {
      const response = buffer;
      buffer = "";
      return Promise.resolve(response);
    }
    return new Promise((resolve, reject) => {
      pending = resolve;
      pending.reject = reject;
    });
  }

  async function expect(command, codes) {
    if (command) socket.write(command + "\r\n");
    const response = await read();
    const code = Number(response.slice(0, 3));
    if (!codes.includes(code)) {
      throw new Error(`SMTP error after ${command || "connect"}: ${response.trim()}`);
    }
    return response;
  }

  return { expect };
}

async function sendSmtpMail({ host, port, user, pass, fromEmail, fromName, to, subject, text, html }) {
  const socket = tls.connect({
    host,
    port,
    servername: host,
    rejectUnauthorized: true,
  });
  socket.setTimeout(15000, () => socket.destroy(new Error("SMTP connection timed out")));

  await new Promise((resolve, reject) => {
    socket.once("secureConnect", resolve);
    socket.once("error", reject);
  });

  const smtp = smtpSession(socket);
  await smtp.expect("", [220]);
  await smtp.expect("EHLO maslog-cold-spring", [250]);
  const auth = Buffer.from(`\u0000${user}\u0000${pass}`, "utf8").toString("base64");
  await smtp.expect(`AUTH PLAIN ${auth}`, [235]);
  await smtp.expect(`MAIL FROM:<${fromEmail}>`, [250]);
  await smtp.expect(`RCPT TO:<${to}>`, [250, 251]);
  await smtp.expect("DATA", [354]);
  socket.write(dotStuff(createMessage({ fromName, fromEmail, to, subject, text, html })) + "\r\n.\r\n");
  await smtp.expect("", [250]);
  await smtp.expect("QUIT", [221]);
  socket.end();
}

async function readBody(req) {
  if (req.body) return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  return JSON.parse(raw);
}

async function supabaseGet(path) {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    DEFAULT_SUPABASE_KEY;
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    const msg = await response.text().catch(() => "");
    throw new Error(`Supabase lookup failed: ${msg || response.statusText}`);
  }
  return response.json();
}

function buildAccountReviewEmail({ status, fullName, registrationCode }) {
  const name = fullName || "Client";
  const safeName = escapeHtml(name);
  const safeCode = escapeHtml(registrationCode || "");
  const siteUrl = (process.env.MASLOG_SITE_URL || "https://resort-neon-three.vercel.app").replace(/\/+$/, "");

  if (status === "approved") {
    return {
      subject: "Your Maslog account has been approved",
      text:
        `Hello ${name},\n\n` +
        "Your Maslog Cold Spring client account has been verified and approved. You can now sign in and book online.\n\n" +
        `Sign in: ${siteUrl}/index.html\n` +
        (registrationCode ? `Registration code: ${registrationCode}\n` : "") +
        "\nMaslog Cold Spring",
      html:
        `<h2>Your Maslog account is approved</h2>` +
        `<p>Hello ${safeName},</p>` +
        `<p>Your Maslog Cold Spring client account has been verified and approved. You can now sign in and book online.</p>` +
        `<p><a href="${escapeHtml(siteUrl)}/index.html">Sign in to Maslog</a></p>` +
        (safeCode ? `<p>Registration code: <strong>${safeCode}</strong></p>` : "") +
        `<p>Maslog Cold Spring</p>`,
    };
  }

  return {
    subject: "Your Maslog registration was rejected",
    text:
      `Hello ${name},\n\n` +
      "We reviewed your Maslog Cold Spring registration and could not approve it at this time. Please contact Maslog Cold Spring or submit a new registration with a clear selfie and valid ID.\n\n" +
      `Register again: ${siteUrl}/create-account.html\n` +
      (registrationCode ? `Registration code: ${registrationCode}\n` : "") +
      "\nMaslog Cold Spring",
    html:
      `<h2>Your Maslog registration was not approved</h2>` +
      `<p>Hello ${safeName},</p>` +
      `<p>We reviewed your Maslog Cold Spring registration and could not approve it at this time.</p>` +
      `<p>Please contact Maslog Cold Spring or submit a new registration with a clear selfie and valid ID.</p>` +
      `<p><a href="${escapeHtml(siteUrl)}/create-account.html">Register again</a></p>` +
      (safeCode ? `<p>Registration code: <strong>${safeCode}</strong></p>` : "") +
      `<p>Maslog Cold Spring</p>`,
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: "Method not allowed" });
  }

  try {
    const body = await readBody(req);
    const profileId = Number(body.profileId);
    if (!Number.isFinite(profileId)) return json(res, 400, { error: "Missing registration profile ID" });

    const profiles = await supabaseGet(`client_profiles?select=id,user_id,registration_code,review_status&id=eq.${profileId}&limit=1`);
    const profile = profiles?.[0];
    if (!profile) return json(res, 404, { error: "Registration not found" });
    if (!["approved", "rejected"].includes(profile.review_status)) {
      return json(res, 409, { error: "Registration is not approved or rejected yet" });
    }

    const users = await supabaseGet(`users?select=id,email,full_name&id=eq.${profile.user_id}&limit=1`);
    const user = users?.[0];
    if (!user?.email) return json(res, 404, { error: "Client email not found" });

    const host = process.env.SMTP_HOST || "smtp.gmail.com";
    const port = Number(process.env.SMTP_PORT || 465);
    const smtpUser = String(process.env.SMTP_USER || "").trim();
    const smtpPass = String(process.env.SMTP_PASS || "").replace(/\s+/g, "");
    const fromEmail = String(process.env.SMTP_FROM_EMAIL || smtpUser).trim();
    const fromName = process.env.SMTP_FROM_NAME || "Maslog";

    if (!smtpUser || !smtpPass || !fromEmail) {
      return json(res, 503, { error: "SMTP email settings are not configured on Vercel" });
    }

    const email = buildAccountReviewEmail({
      status: profile.review_status,
      fullName: user.full_name,
      registrationCode: profile.registration_code,
    });

    await sendSmtpMail({
      host,
      port,
      user: smtpUser,
      pass: smtpPass,
      fromEmail,
      fromName,
      to: user.email,
      subject: email.subject,
      text: email.text,
      html: email.html,
    });

    return json(res, 200, { sent: true, status: profile.review_status, email: user.email });
  } catch (err) {
    return json(res, 500, { error: err.message || "Unable to send account status email" });
  }
};

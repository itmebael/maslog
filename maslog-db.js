/**
 * Maslog Cold Spring — Supabase data layer (replaces localStorage / hardcoded data)
 */
(function (global) {
  const db = {};

  function sb() {
    return MaslogConfig.getClient();
  }

  function money(n) {
    return "₱" + Number(n || 0).toLocaleString("en-PH");
  }

  function formatDate(d) {
    if (!d) return "—";
    const s = String(d).slice(0, 10);
    return new Date(s + "T12:00:00").toLocaleDateString("en-PH", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  function initials(name) {
    return (name || "U")
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase();
  }

  const LOCAL_DOC_PREFIX = "local-doc:";
  const LOCAL_ASSET_PREFIX = "local-asset:";

  function saveLocalDoc(code, kind, dataUrl) {
    if (!dataUrl) return null;
    const key = `maslog_client_doc_${code}_${kind}`;
    try {
      localStorage.setItem(key, dataUrl);
      return `${LOCAL_DOC_PREFIX}${code}:${kind}`;
    } catch {
      return null;
    }
  }

  function resolveLocalDoc(ref) {
    if (!ref || !String(ref).startsWith(LOCAL_DOC_PREFIX)) return ref || "";
    const raw = String(ref).slice(LOCAL_DOC_PREFIX.length);
    const [code, kind] = raw.split(":");
    if (!code || !kind) return "";
    return localStorage.getItem(`maslog_client_doc_${code}_${kind}`) || "";
  }

  function saveLocalAsset(scope, ownerId, index, dataUrl) {
    if (!dataUrl) return "";
    if (!String(dataUrl).startsWith("data:")) return dataUrl;
    const key = `maslog_${scope}_${ownerId}_${index}_${Date.now().toString(36)}`;
    try {
      localStorage.setItem(key, dataUrl);
      return `${LOCAL_ASSET_PREFIX}${key}`;
    } catch {
      return dataUrl;
    }
  }

  function resolveStoredAsset(ref) {
    if (!ref) return "";
    const value = String(ref);
    if (value.startsWith(LOCAL_ASSET_PREFIX)) {
      return localStorage.getItem(value.slice(LOCAL_ASSET_PREFIX.length)) || "";
    }
    return resolveLocalDoc(value);
  }

  async function getPropertyTypeId(code) {
    const normalized = String(code || "cottage").toLowerCase();
    const label = normalized.charAt(0).toUpperCase() + normalized.slice(1);
    const { data, error } = await sb().from("property_types").select("id").eq("code", normalized).maybeSingle();
    if (error) throw error;
    if (data?.id) return data.id;
    const { data: created, error: createError } = await sb()
      .from("property_types")
      .insert({ code: normalized, name: label })
      .select("id")
      .single();
    if (createError) throw createError;
    return created.id;
  }

  // ——— Auth ———
  db.login = async function (email, password) {
    const loginEmail = email.trim().toLowerCase();
    const hash = await MaslogConfig.sha256(password);

    const { data: user, error } = await sb()
      .from("users")
      .select("id, email, password_hash, full_name, phone, status, role_id, roles(role_code, role_name)")
      .eq("email", loginEmail)
      .maybeSingle();

    if (error) throw error;
    if (!user) throw new Error("Invalid email or password");
    const validPassword = user.password_hash === hash;
    if (!validPassword) throw new Error("Invalid email or password");
    if (user.status !== "active") throw new Error("Account is not active (" + user.status + ")");

    const roleCode = user.roles?.role_code;
    if (!["admin", "staff", "client"].includes(roleCode)) throw new Error("Account role is not configured");

    await sb().from("users").update({ last_login_at: new Date().toISOString() }).eq("id", user.id);

    const session = {
      userId: user.id,
      email: user.email,
      fullName: user.full_name,
      phone: user.phone,
      role: roleCode,
      portal: roleCode,
    };
    MaslogConfig.saveSession(session);
    return session;
  };

  db.startGoogleClientLogin = async function () {
    const redirectTo = `${location.origin}${location.pathname}`;
    if (typeof fetch === "function") {
      try {
        await fetch(`${MaslogConfig.SUPABASE_URL}/auth/v1/health`, {
          mode: "no-cors",
          cache: "no-store",
        });
      } catch {
        throw new Error(`Supabase project URL cannot be reached: ${MaslogConfig.SUPABASE_URL}`);
      }
    }
    const { error } = await sb().auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo },
    });
    if (error) {
      const msg = String(error.message || error.msg || "").toLowerCase();
      if (msg.includes("unsupported provider") || msg.includes("provider is not enabled")) {
        throw new Error("Google login is not enabled for this Supabase project yet. Please sign in with email and password, or enable the Google provider in Supabase Auth.");
      }
      throw error;
    }
  };

  db.completeGoogleClientLogin = async function () {
    const params = new URLSearchParams(location.search);
    const code = params.get("code");
    if (code) {
      const { error } = await sb().auth.exchangeCodeForSession(code);
      if (error) throw error;
      history.replaceState(null, document.title, location.pathname);
    }

    const { data: authData, error: authError } = await sb().auth.getSession();
    if (authError) throw authError;
    const authUser = authData?.session?.user;
    const email = String(authUser?.email || "").trim().toLowerCase();
    if (!email) return null;

    if (!email.endsWith("@gmail.com")) {
      await sb().auth.signOut();
      throw new Error("Google login is only available for Gmail client accounts");
    }

    const { data: user, error } = await sb()
      .from("users")
      .select("id, email, full_name, phone, status, role_id, roles(role_code, role_name)")
      .eq("email", email)
      .maybeSingle();
    if (error) throw error;

    const roleCode = user?.roles?.role_code;
    if (!user || roleCode !== "client") {
      await sb().auth.signOut();
      throw new Error("This Google email is not registered as an approved client account");
    }
    if (user.status !== "active") {
      await sb().auth.signOut();
      throw new Error("Client account is not active (" + user.status + ")");
    }

    await sb().from("users").update({ last_login_at: new Date().toISOString() }).eq("id", user.id);

    const session = {
      userId: user.id,
      email: user.email,
      fullName: user.full_name,
      phone: user.phone,
      role: "client",
      portal: "client",
    };
    MaslogConfig.saveSession(session);
    await sb().auth.signOut();
    return session;
  };

  db.sendSignupEmailCode = async function (email) {
    const loginEmail = String(email || "").trim().toLowerCase();
    if (!loginEmail.endsWith("@gmail.com")) throw new Error("Use a valid Gmail address");

    const { data: existing, error: findError } = await sb()
      .from("users")
      .select("id")
      .eq("email", loginEmail)
      .maybeSingle();
    if (findError) throw findError;
    if (existing) throw new Error("This Gmail is already registered");

    const { error } = await sb().auth.signInWithOtp({
      email: loginEmail,
      options: {
        shouldCreateUser: true,
        emailRedirectTo: `${location.origin}${location.pathname}`,
      },
    });
    if (error) throw error;
    return true;
  };

  db.verifySignupEmailCode = async function (email, token) {
    const loginEmail = String(email || "").trim().toLowerCase();
    const cleanToken = String(token || "").replace(/\D/g, "");
    if (!loginEmail.endsWith("@gmail.com")) throw new Error("Use a valid Gmail address");
    if (cleanToken.length < 6) throw new Error("Enter the Gmail verification code from your email");

    const { data, error } = await sb().auth.verifyOtp({
      email: loginEmail,
      token: cleanToken,
      type: "email",
    });
    if (error) throw new Error("Invalid or expired Gmail verification code");
    const verifiedEmail = String(data?.user?.email || "").toLowerCase();
    if (verifiedEmail !== loginEmail) throw new Error("Gmail verification did not match this email");
    return true;
  };

  async function logPasswordReset(user, action, details) {
    if (!user?.id) return;
    try {
      const roleCode = user.roles?.role_code;
      const { error } = await sb().from("audit_logs").insert({
        user_id: user.id,
        portal: ["admin", "staff", "client"].includes(roleCode) ? roleCode : null,
        action,
        table_name: "users",
        record_id: String(user.id),
        details,
      });
      if (error) console.warn("Password reset audit log failed", error);
    } catch (err) {
      console.warn("Password reset audit log failed", err);
    }
  }

  db.sendPasswordResetCode = async function (email) {
    const loginEmail = String(email || "").trim().toLowerCase();
    if (!loginEmail) throw new Error("Enter the email address for the account");

    const { data: user, error } = await sb()
      .from("users")
      .select("id, email, full_name, roles(role_code)")
      .eq("email", loginEmail)
      .maybeSingle();
    if (error) throw error;

    if (user?.id) {
      const { error: otpError } = await sb().auth.signInWithOtp({
        email: loginEmail,
        options: {
          shouldCreateUser: true,
          emailRedirectTo: `${location.origin}${location.pathname}`,
        },
      });
      if (otpError) throw otpError;
      await logPasswordReset(user, "password_reset_code_sent", `Password reset code sent to ${user.email}`);
    }

    return true;
  };

  db.resetPasswordWithCode = async function (email, token, newPassword) {
    const loginEmail = String(email || "").trim().toLowerCase();
    const cleanToken = String(token || "").replace(/\D/g, "");
    if (!loginEmail) throw new Error("Enter the email address for the account");
    if (cleanToken.length < 6) throw new Error("Enter the password reset code from your email");
    if (String(newPassword || "").length < 8) throw new Error("Password must be at least 8 characters");

    const { data, error } = await sb().auth.verifyOtp({
      email: loginEmail,
      token: cleanToken,
      type: "email",
    });
    if (error) throw new Error("Invalid or expired password reset code");
    const verifiedEmail = String(data?.user?.email || "").toLowerCase();
    if (verifiedEmail !== loginEmail) throw new Error("Password reset code did not match this email");

    const { data: user, error: findError } = await sb()
      .from("users")
      .select("id, email, full_name, roles(role_code)")
      .eq("email", loginEmail)
      .maybeSingle();
    if (findError) throw findError;
    if (!user) throw new Error("No account found for this email");

    const hash = await MaslogConfig.sha256(newPassword);
    const { error: updateError } = await sb()
      .from("users")
      .update({ password_hash: hash, updated_at: new Date().toISOString() })
      .eq("id", user.id);
    if (updateError) throw updateError;

    await logPasswordReset(user, "password_reset_completed", `Password reset completed for ${user.email}`);
    await sb().auth.signOut().catch(() => {});
    return true;
  };

  db.requestPasswordReset = db.sendPasswordResetCode;

  db.logout = function () {
    MaslogConfig.clearSession();
  };

  db.requireSession = function (allowedRoles) {
    const s = MaslogConfig.getSession();
    if (!s) return null;
    if (allowedRoles && !allowedRoles.includes(s.role) && !allowedRoles.includes(s.portal)) return null;
    return s;
  };

  // ——— Client signup ———
  db.signUpClient = async function (payload) {
    const email = payload.email.trim().toLowerCase();
    const { data: existing } = await sb().from("users").select("id").eq("email", email).maybeSingle();
    if (existing) throw new Error("This Gmail is already registered");
    if (!payload.gmailVerified) throw new Error("Please verify your Gmail before submitting");

    const { data: authData, error: authErr } = await sb().auth.getUser();
    if (authErr) throw authErr;
    const verifiedEmail = String(authData?.user?.email || "").toLowerCase();
    if (verifiedEmail !== email) throw new Error("Please verify this Gmail address before submitting");

    const firstName = String(payload.firstName || "").trim();
    const middleInitial = String(payload.middleInitial || "").replace(/\./g, "").trim().slice(0, 1).toUpperCase();
    const lastName = String(payload.lastName || "").trim();
    const fullName = [firstName, middleInitial ? `${middleInitial}.` : "", lastName]
      .filter(Boolean)
      .join(" ")
      .trim() || String(payload.fullName || "").trim();
    if (!fullName || !firstName || !lastName) throw new Error("First name and last name are required");

    const hash = await MaslogConfig.sha256(payload.password);
    const { data: role, error: roleErr } = await sb()
      .from("roles")
      .select("id")
      .eq("role_code", "client")
      .maybeSingle();
    if (roleErr) throw roleErr;
    if (!role) throw new Error("Client role is missing in the database");

    const code = "USR-" + Date.now().toString(36).toUpperCase();
    const selfiePath = saveLocalDoc(code, "selfie", payload.selfie);
    const validIdPath = saveLocalDoc(code, "valid-id", payload.validId);

    const userRecord = {
      role_id: role.id,
      email,
      password_hash: hash,
      full_name: fullName,
      phone: payload.phone.trim(),
      status: "pending",
    };
    const splitNameFields = {
      first_name: firstName,
      middle_initial: middleInitial || null,
      last_name: lastName,
    };

    let { data: user, error: uErr } = await sb()
      .from("users")
      .insert({ ...userRecord, ...splitNameFields })
      .select("id")
      .single();

    if (uErr) {
      const msg = String(uErr.message || uErr.details || "").toLowerCase();
      const missingSplitNameColumn =
        ["first_name", "middle_initial", "last_name"].some((col) => msg.includes(col)) &&
        /(schema|column|cache|could not find)/i.test(msg);
      if (missingSplitNameColumn) {
        const retry = await sb().from("users").insert(userRecord).select("id").single();
        user = retry.data;
        uErr = retry.error;
      }
    }
    if (uErr) throw uErr;

    let idTypeId = null;
    if (payload.idType) {
      const { data: it } = await sb().from("id_types").select("id").eq("name", payload.idType).maybeSingle();
      idTypeId = it?.id || null;
    }

    const { error: cErr } = await sb().from("client_profiles").insert({
      user_id: user.id,
      registration_code: code,
      id_type_id: idTypeId,
      selfie_path: selfiePath,
      valid_id_path: validIdPath,
      gmail_verified: !!payload.gmailVerified,
      review_status: "pending",
    });
    if (cErr) {
      await sb().from("users").delete().eq("id", user.id);
      throw cErr;
    }
    await sb().auth.signOut().catch(() => {});
    return { userId: user.id, registrationCode: code };
  };

  // ——— Clients (User Management) ———
  db.listPendingClients = async function () {
    const { data, error } = await sb()
      .from("client_profiles")
      .select(
        `id, user_id, registration_code, review_status, submitted_at, selfie_path, valid_id_path,
         gmail_verified, camera_verified, id_verified, gmail_staff_verified,
         id_types(name)`
      )
      .order("submitted_at", { ascending: false });
    if (error) throw error;

    const userIds = [...new Set((data || []).map((row) => row.user_id).filter(Boolean))];
    let usersById = {};
    if (userIds.length) {
      const { data: users, error: uErr } = await sb()
        .from("users")
        .select("id, full_name, email, phone, status")
        .in("id", userIds);
      if (uErr) throw uErr;
      usersById = Object.fromEntries((users || []).map((u) => [String(u.id), u]));
    }

    return (data || []).map((row) => ({
      id: row.id,
      userId: row.user_id,
      registrationCode: row.registration_code,
      fullName: usersById[String(row.user_id)]?.full_name || "",
      email: usersById[String(row.user_id)]?.email || "",
      phone: usersById[String(row.user_id)]?.phone || "",
      idType: row.id_types?.name || "",
      selfie: resolveLocalDoc(row.selfie_path),
      validId: resolveLocalDoc(row.valid_id_path),
      status: row.review_status,
      verified: {
        gmail: !!row.gmail_verified || !!row.gmail_staff_verified,
        selfie: !!row.camera_verified,
        id: !!row.id_verified,
      },
      gmailVerified: !!row.gmail_verified,
      cameraVerified: !!row.camera_verified,
      idVerified: !!row.id_verified,
      gmailStaffVerified: !!row.gmail_staff_verified,
      submittedAt: row.submitted_at,
    }));
  };

  db.updateClientVerification = async function (profileId, userId, patch) {
    const updates = {};
    if (patch.cameraVerified != null) updates.camera_verified = patch.cameraVerified;
    if (patch.idVerified != null) updates.id_verified = patch.idVerified;
    if (patch.gmailStaffVerified != null) updates.gmail_staff_verified = patch.gmailStaffVerified;
    if (patch.reviewStatus) {
      updates.review_status = patch.reviewStatus;
      updates.reviewed_at = new Date().toISOString();
      const session = MaslogConfig.getSession();
      const reviewerId = Number(session?.userId);
      if (Number.isFinite(reviewerId)) updates.reviewed_by = reviewerId;
    }
    const { error } = await sb().from("client_profiles").update(updates).eq("id", profileId);
    if (error) throw error;

    if (patch.reviewStatus === "approved") {
      await sb().from("users").update({ status: "active" }).eq("id", userId);
    } else if (patch.reviewStatus === "rejected") {
      await sb().from("users").update({ status: "rejected" }).eq("id", userId);
    }
  };

  db.getCurrentClient = async function () {
    const session = MaslogConfig.getSession();
    if (!session?.userId && !session?.email) return null;

    let q = sb()
      .from("client_profiles")
      .select(
        `id, user_id, registration_code, review_status, submitted_at, selfie_path, valid_id_path,
         gmail_verified, camera_verified, id_verified, gmail_staff_verified,
         id_types(name)`
      );

    const sessionUserId = Number(session.userId);
    if (Number.isFinite(sessionUserId)) {
      q = q.eq("user_id", sessionUserId);
    } else {
      // fallback via email join not direct — fetch user first
      const { data: u } = await sb().from("users").select("id").eq("email", session.email).maybeSingle();
      if (!u) return null;
      q = q.eq("user_id", u.id);
    }

    const { data: row, error } = await q.maybeSingle();
    if (error) throw error;
    if (!row) return null;

    const { data: user, error: uErr } = await sb()
      .from("users")
      .select("id, full_name, email, phone, status, created_at")
      .eq("id", row.user_id)
      .maybeSingle();
    if (uErr) throw uErr;

    return {
      id: row.id,
      userId: row.user_id,
      fullName: user?.full_name || "",
      email: user?.email || "",
      phone: user?.phone || "",
      idType: row.id_types?.name || "",
      selfie: resolveLocalDoc(row.selfie_path),
      idImage: resolveLocalDoc(row.valid_id_path),
      status: row.review_status === "approved" ? "approved" : row.review_status,
      verified: {
        gmail: !!(row.gmail_verified || row.gmail_staff_verified),
        selfie: !!row.camera_verified,
        id: !!row.id_verified,
      },
      registeredAt: user?.created_at || row.submitted_at,
    };
  };

  db.isUserVerified = function (user) {
    if (!user) return false;
    if (user.status && user.status !== "approved") return false;
    const v = user.verified || {};
    return !!(v.selfie && v.id && v.gmail);
  };

  // ——— Staff accounts ———
  db.listStaffAccounts = async function () {
    const { data: users, error } = await sb()
      .from("users")
      .select("id, email, full_name, phone, status, created_at, role_id, roles(role_code, role_name)")
      .order("created_at", { ascending: false });
    if (error) throw error;

    const staffUsers = (users || []).filter((u) => ["admin", "staff"].includes(u.roles?.role_code));
    const userIds = staffUsers.map((u) => u.id);
    let profilesByUser = {};

    if (userIds.length) {
      const { data: profiles, error: pErr } = await sb()
        .from("staff_profiles")
        .select("user_id, staff_code, job_title, hire_date")
        .in("user_id", userIds);
      if (pErr) throw pErr;
      profilesByUser = Object.fromEntries((profiles || []).map((p) => [String(p.user_id), p]));
    }

    return mapStaff(staffUsers.map((u) => ({ ...u, staffProfile: profilesByUser[String(u.id)] || null })));
  };

  function mapStaff(users) {
    return (users || []).map((u) => ({
      id: String(u.id),
      name: u.full_name,
      email: u.email,
      phone: u.phone || "",
      role: u.roles?.role_code === "admin" ? "Admin" : "Staff",
      roleCode: u.roles?.role_code,
      status: u.status === "active" ? "Active" : "Inactive",
      createdAt: (u.created_at || "").slice(0, 10),
      staffCode: u.staffProfile?.staff_code || "",
    }));
  }

  db.saveStaffAccount = async function (payload, editingId) {
    const email = payload.email.trim().toLowerCase();
    const roleCode = payload.role === "Admin" ? "admin" : "staff";
    const { data: role, error: roleErr } = await sb().from("roles").select("id").eq("role_code", roleCode).single();
    if (roleErr || !role) throw roleErr || new Error("Role not found in database");
    const status = payload.status === "Active" ? "active" : "inactive";

    if (editingId) {
      const updates = {
        full_name: payload.name.trim(),
        email,
        phone: payload.phone.trim(),
        role_id: role.id,
        status,
      };
      if (payload.password) {
        updates.password_hash = await MaslogConfig.sha256(payload.password);
      }
      const { error } = await sb().from("users").update(updates).eq("id", editingId);
      if (error) throw error;
      await sb()
        .from("staff_profiles")
        .upsert(
          {
            user_id: Number(editingId),
            job_title: payload.role === "Admin" ? "Administrator" : "Staff",
          },
          { onConflict: "user_id" }
        );
      return editingId;
    }

    const { data: exists } = await sb().from("users").select("id").eq("email", email).maybeSingle();
    if (exists) throw new Error("Email already exists");

    const hash = await MaslogConfig.sha256(payload.password);
    const { data: user, error } = await sb()
      .from("users")
      .insert({
        role_id: role.id,
        email,
        password_hash: hash,
        full_name: payload.name.trim(),
        phone: payload.phone.trim(),
        status,
      })
      .select("id")
      .single();
    if (error) throw error;

    const code = (roleCode === "admin" ? "ADM-" : "STF-") + String(user.id).padStart(3, "0");
    const sessionUserId = Number(MaslogConfig.getSession()?.userId);
    await sb().from("staff_profiles").insert({
      user_id: user.id,
      staff_code: code,
      job_title: payload.role === "Admin" ? "Administrator" : "Staff",
      hire_date: new Date().toISOString().slice(0, 10),
      created_by: Number.isFinite(sessionUserId) ? sessionUserId : null,
    });
    return user.id;
  };

  db.archiveStaffAccount = async function (userId) {
    const { error } = await sb()
      .from("users")
      .update({ status: "inactive", updated_at: new Date().toISOString() })
      .eq("id", userId);
    if (error) throw error;
  };

  db.deleteStaffAccount = db.archiveStaffAccount;

  // ——— Admin fees ———
  db.getAdminEntranceFees = async function () {
    const { data, error } = await sb().from("admin_entrance_fees").select("*");
    if (error) throw error;
    const map = { adult: 150, child: 100, senior: 75, infant: 0 };
    (data || []).forEach((r) => {
      map[r.fee_key] = Number(r.amount);
    });
    return map;
  };

  db.saveAdminEntranceFees = async function (fees) {
    for (const [key, amount] of Object.entries(fees)) {
      const { error } = await sb()
        .from("admin_entrance_fees")
        .update({ amount: Number(amount) || 0, updated_at: new Date().toISOString() })
        .eq("fee_key", key);
      if (error) throw error;
    }
  };

  db.listAdminCottages = async function () {
    const { data, error } = await sb().from("admin_cottages").select("*").order("sort_order");
    if (error) throw error;
    return (data || []).map((c) => ({
      id: String(c.id),
      type: c.property_type || "cottage",
      name: c.name,
      capacity: c.capacity,
      features: c.features || "",
      rate: Number(c.rate),
      photoPath: c.photo_path || "",
      photo: resolveLocalDoc(c.photo_path),
      available: !!c.is_available,
    }));
  };

  db.saveAdminCottages = async function (cottages) {
    for (const c of cottages) {
      if (String(c.id).startsWith("c") || String(c.id).startsWith("new")) {
        const { data: inserted, error } = await sb().from("admin_cottages").insert({
          name: c.name,
          property_type: c.type || "cottage",
          capacity: c.capacity,
          features: c.features,
          rate: c.rate,
          photo_path: c.photoPath || "",
          is_available: c.available !== false,
        }).select("*").single();
        if (error) throw error;
        await syncAdminCottageToStaff(inserted);
      } else {
        const { data: updated, error } = await sb()
          .from("admin_cottages")
          .update({
            name: c.name,
            property_type: c.type || "cottage",
            capacity: c.capacity,
            features: c.features,
            rate: c.rate,
            photo_path: c.photoPath || "",
            is_available: c.available !== false,
            updated_at: new Date().toISOString(),
          })
          .eq("id", c.id)
          .select("*")
          .single();
        if (error) throw error;
        await syncAdminCottageToStaff(updated);
      }
    }
  };

  async function syncAdminCottageToStaff(cottage) {
    if (!cottage?.name) return;

    const { data: type, error: typeErr } = await sb()
      .from("property_types")
      .select("id")
      .eq("code", cottage.property_type || "cottage")
      .single();
    if (typeErr) throw typeErr;

    const description = [
      `Capacity ${Number(cottage.capacity || 0) || 1}`,
      cottage.features || "",
    ].filter(Boolean).join(" · ");

    const { data: existing, error: findErr } = await sb()
      .from("staff_properties")
      .select("id")
      .eq("property_type_id", type.id)
      .eq("name", cottage.name)
      .maybeSingle();
    if (findErr) throw findErr;

    let propertyId = existing?.id;
    const row = {
      property_type_id: type.id,
      name: cottage.name,
      price: Number(cottage.rate || 0),
      description,
      is_available: cottage.is_available !== false,
    };

    if (propertyId) {
      const { error } = await sb()
        .from("staff_properties")
        .update({ ...row, updated_at: new Date().toISOString() })
        .eq("id", propertyId);
      if (error) throw error;
    } else {
      const session = MaslogConfig.getSession();
      const { data: inserted, error } = await sb()
        .from("staff_properties")
        .insert({ ...row, created_by: session?.userId || null })
        .select("id")
        .single();
      if (error) throw error;
      propertyId = inserted.id;
    }

    await sb().from("staff_property_photos").delete().eq("property_id", propertyId);
    if (cottage.photo_path) {
      const { error } = await sb().from("staff_property_photos").insert({
        property_id: propertyId,
        photo_path: cottage.photo_path,
        sort_order: 1,
      });
      if (error) throw error;
    }
  }

  db.deleteAdminCottage = async function (id) {
    if (!id || String(id).startsWith("c") || String(id).startsWith("new")) return;
    const { data: cottage } = await sb().from("admin_cottages").select("name, property_type").eq("id", id).maybeSingle();
    const { error } = await sb().from("admin_cottages").delete().eq("id", id);
    if (error) throw error;
    if (cottage?.name) {
      const { data: type } = await sb().from("property_types").select("id").eq("code", cottage.property_type || "cottage").maybeSingle();
      if (type?.id) {
        await sb()
          .from("staff_properties")
          .delete()
          .eq("property_type_id", type.id)
          .eq("name", cottage.name);
      }
    }
  };

  // ——— Staff properties / partnership / gcash / booking settings ———
  db.loadStaffFees = async function () {
    const [{ data: props, error: e1 }, { data: partners, error: e2 }] = await Promise.all([
      sb()
        .from("staff_properties")
        .select("id, name, price, description, is_available, property_types(code), staff_property_photos(photo_path, sort_order)")
        .order("id"),
      sb().from("partnership_fees").select("*").order("id"),
    ]);
    if (e1) throw e1;
    if (e2) throw e2;
    const partnershipRows = (partners || []).map((partner) => ({
      id: String(partner.id),
      name: partner.name,
      perHour: Number(partner.fee_per_hour),
      perDay: Number(partner.fee_per_day),
      description: partner.description || "",
      logo: resolveStoredAsset(partner.logo_path) || "backg.png",
      available: partner.is_available !== false,
    }));
    const defaultPartnership = {
      name: "Vendor Stall Partnership",
      perHour: 0,
      perDay: 0,
      description: "",
      logo: "backg.png",
      available: true,
    };

    return {
      properties: (props || []).map((p) => {
        const photos = (p.staff_property_photos || [])
          .sort((a, b) => a.sort_order - b.sort_order)
          .map((ph) => resolveStoredAsset(ph.photo_path));
        while (photos.length < 5) photos.push("");
        return {
          id: String(p.id),
          type: p.property_types?.code || "cottage",
          name: p.name,
          price: Number(p.price),
          description: p.description || "",
          available: p.is_available !== false,
          pictures: photos.slice(0, 5),
        };
      }),
      partnerships: partnershipRows,
      partnership: partnershipRows[0] || defaultPartnership,
    };
  };

  db.saveStaffProperty = async function (item) {
    const propertyTypeId = await getPropertyTypeId(item.type);
    const session = MaslogConfig.getSession();

    async function replacePhotos(propertyId) {
      const { error: deleteError } = await sb().from("staff_property_photos").delete().eq("property_id", propertyId);
      if (deleteError) {
        console.warn("Unable to clear staff property photos", deleteError);
        return;
      }
      const pics = (item.pictures || []).filter(Boolean).slice(0, 5);
      if (!pics.length) return;
      const rows = pics.map((photo, i) => ({
        property_id: Number(propertyId),
        photo_path: saveLocalAsset("staff_property_photo", propertyId, i + 1, photo),
        sort_order: i + 1,
      }));
      const { error } = await sb().from("staff_property_photos").insert(rows);
      if (error) console.warn("Unable to save staff property photos", error);
    }

    if (item.id && !String(item.id).startsWith("p")) {
      const { error } = await sb()
        .from("staff_properties")
        .update({
          property_type_id: propertyTypeId,
          name: item.name,
          price: item.price,
          description: item.description,
          is_available: item.available !== false,
          updated_at: new Date().toISOString(),
        })
        .eq("id", item.id);
      if (error) throw error;
      await replacePhotos(item.id);
      return item.id;
    }

    const { data: row, error } = await sb()
      .from("staff_properties")
      .insert({
        property_type_id: propertyTypeId,
        name: item.name,
        price: item.price,
        description: item.description,
        is_available: item.available !== false,
        created_by: session?.userId || null,
      })
      .select("id")
      .single();
    if (error) throw error;
    await replacePhotos(row.id);
    return String(row.id);
  };

  db.deleteStaffProperty = async function (id) {
    const { error } = await sb().from("staff_properties").delete().eq("id", id);
    if (error) throw error;
  };

  db.savePartnership = async function (p) {
    const isExisting = p.id && !String(p.id).startsWith("new");
    const row = {
      name: p.name,
      fee_per_hour: p.perHour,
      fee_per_day: p.perDay,
      description: p.description,
      logo_path: saveLocalAsset("partnership_logo", p.id || "new", 1, p.logo),
      is_available: p.available !== false,
      updated_at: new Date().toISOString(),
    };
    if (isExisting) {
      const { error } = await sb().from("partnership_fees").update(row).eq("id", p.id);
      if (error) throw error;
      return String(p.id);
    } else {
      const { data, error } = await sb().from("partnership_fees").insert(row).select("id").single();
      if (error) throw error;
      return String(data.id);
    }
  };

  db.deletePartnership = async function (id) {
    const { error } = await sb().from("partnership_fees").delete().eq("id", id);
    if (error) throw error;
  };

  db.getGcashSettings = async function () {
    const { data, error } = await sb().from("gcash_settings").select("*").limit(1).maybeSingle();
    if (error) throw error;
    return {
      gcashName: data?.account_name || "Maslog Cold Spring",
      gcashNumber: data?.account_number || "",
      gcashQr: data?.qr_image_path || "",
    };
  };

  db.saveGcashSettings = async function (g) {
    const { data: existing } = await sb().from("gcash_settings").select("id").limit(1).maybeSingle();
    const row = {
      account_name: g.gcashName,
      account_number: g.gcashNumber,
      qr_image_path: g.gcashQr,
      updated_by: MaslogConfig.getSession()?.userId || null,
      updated_at: new Date().toISOString(),
    };
    if (existing) {
      const { error } = await sb().from("gcash_settings").update(row).eq("id", existing.id);
      if (error) throw error;
    } else {
      const { error } = await sb().from("gcash_settings").insert(row);
      if (error) throw error;
    }
  };

  db.getBookingSettings = async function () {
    const [{ data: settings }, { data: dates }, gcash] = await Promise.all([
      sb().from("booking_settings").select("*").limit(1).maybeSingle(),
      sb().from("unavailable_dates").select("block_date").order("block_date"),
      db.getGcashSettings(),
    ]);
    return {
      unavailableDates: (dates || []).map((d) => d.block_date),
      unavailablePropertyIds: [],
      entranceFees: {
        adult: Number(settings?.entrance_adult ?? 80),
        child: Number(settings?.entrance_child ?? 50),
        senior: Number(settings?.entrance_senior ?? 60),
      },
      agreement:
        settings?.agreement_text ||
        "You must arrive on your confirmed booking date. If you fail to show up without prior notice, 10% of your payment will not be refunded.",
      customerService: {
        phone: settings?.cs_phone || "",
        email: settings?.cs_email || "",
        hours: settings?.cs_hours || "",
        messenger: settings?.cs_messenger || "",
      },
      ...gcash,
    };
  };

  db.saveBookingSettings = async function (s) {
    const { data: existing } = await sb().from("booking_settings").select("id").limit(1).maybeSingle();
    const row = {
      entrance_adult: s.entranceFees?.adult ?? 80,
      entrance_child: s.entranceFees?.child ?? 50,
      entrance_senior: s.entranceFees?.senior ?? 60,
      agreement_text: s.agreement || "",
      cs_phone: s.customerService?.phone || "",
      cs_email: s.customerService?.email || "",
      cs_hours: s.customerService?.hours || "",
      cs_messenger: s.customerService?.messenger || "",
      updated_at: new Date().toISOString(),
    };
    if (existing) {
      const { error } = await sb().from("booking_settings").update(row).eq("id", existing.id);
      if (error) throw error;
    } else {
      const { error } = await sb().from("booking_settings").insert(row);
      if (error) throw error;
    }

    // sync unavailable dates
    if (Array.isArray(s.unavailableDates)) {
      await sb().from("unavailable_dates").delete().gte("id", 0);
      if (s.unavailableDates.length) {
        const { error } = await sb().from("unavailable_dates").insert(
          s.unavailableDates.map((block_date) => ({
            block_date,
            created_by: MaslogConfig.getSession()?.userId || null,
          }))
        );
        if (error) throw error;
      }
    }
  };

  // ——— Bookings ———
  db.listBookedPropertyIds = async function (bookingDate) {
    if (!bookingDate) return [];
    const { data, error } = await sb()
      .from("bookings")
      .select("property_id")
      .eq("booking_date", bookingDate)
      .in("booking_status", ["pending", "confirmed"])
      .not("property_id", "is", null);
    if (error) throw error;
    return [...new Set((data || []).map((b) => String(b.property_id)).filter(Boolean))];
  };

  db.createBooking = async function (b) {
    const session = MaslogConfig.getSession();
    let clientId = session?.userId;
    if (!clientId && b.email) {
      const { data: u } = await sb().from("users").select("id").eq("email", b.email).maybeSingle();
      clientId = u?.id;
    }
    if (!clientId) throw new Error("Please sign in as a client first");
    if (b.propertyId && !String(b.propertyId).startsWith("p")) {
      const bookedIds = await db.listBookedPropertyIds(b.date);
      if (bookedIds.includes(String(b.propertyId))) {
        throw new Error("This property is already booked on your selected date");
      }
    }

    const code = "BK" + Date.now().toString(36).toUpperCase();
    const { data: row, error } = await sb()
      .from("bookings")
      .insert({
        booking_code: code,
        client_user_id: clientId,
        booking_date: b.date,
        property_id: b.propertyId && !String(b.propertyId).startsWith("p") ? Number(b.propertyId) : null,
        property_name: b.propertyName || "",
        adults: b.entrance?.adult || 1,
        children: b.entrance?.child || 0,
        seniors: b.entrance?.senior || 0,
        include_partner: !!b.partner,
        partner_rate_type: b.partner ? b.partnerRate : null,
        partner_hours: b.partner && b.partnerRate === "hour" ? b.partnerHours : null,
        payment_method: b.payment || "cash",
        payment_status: "pending",
        booking_status: "pending",
        total_amount: b.total || 0,
        agreement_accepted: true,
      })
      .select("id, booking_code")
      .single();
    if (error) throw error;
    return row;
  };

  db.listClientBookings = async function (emailOrUserId) {
    let userId = emailOrUserId;
    if (typeof emailOrUserId === "string" && emailOrUserId.includes("@")) {
      const { data: u } = await sb().from("users").select("id").eq("email", emailOrUserId).maybeSingle();
      userId = u?.id;
    }
    if (typeof userId === "string" && !/^\d+$/.test(userId)) {
      const session = MaslogConfig.getSession();
      if (session?.email) {
        const { data: u } = await sb().from("users").select("id").eq("email", session.email).maybeSingle();
        userId = u?.id;
      }
    }
    if (!userId) return [];
    const { data, error } = await sb()
      .from("bookings")
      .select("*")
      .eq("client_user_id", userId)
      .order("created_at", { ascending: false });
    if (error) throw error;

    const reviewerIds = [...new Set((data || []).map((b) => b.reviewed_by).filter(Boolean))];
    let reviewersById = {};
    if (reviewerIds.length) {
      const { data: reviewers, error: rErr } = await sb()
        .from("users")
        .select("id, full_name")
        .in("id", reviewerIds);
      if (rErr) throw rErr;
      reviewersById = Object.fromEntries((reviewers || []).map((u) => [String(u.id), u.full_name]));
    }

    return (data || []).map((b) => ({
      id: b.booking_code,
      status: b.booking_status,
      date: b.booking_date,
      propertyName: b.property_name,
      entrance: { adult: b.adults, child: b.children, senior: b.seniors },
      total: Number(b.total_amount),
      payment: b.payment_method,
      approvedBy: reviewersById[String(b.reviewed_by)] || "",
      email: "",
      createdAt: b.created_at,
    }));
  };

  db.listAdminBookings = async function () {
    const { data, error } = await sb()
      .from("bookings")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw error;

    const userIds = [...new Set((data || []).flatMap((b) => [b.client_user_id, b.reviewed_by]).filter(Boolean))];
    let usersById = {};
    if (userIds.length) {
      const { data: users, error: uErr } = await sb()
        .from("users")
        .select("id, full_name, email, phone")
        .in("id", userIds);
      if (uErr) throw uErr;
      usersById = Object.fromEntries((users || []).map((u) => [String(u.id), u]));
    }

    return (data || []).map((b) => {
      const user = usersById[String(b.client_user_id)] || {};
      return {
        id: b.id,
        code: b.booking_code,
        customer: user.full_name || b.guest_name || "Client",
        contact: user.phone || user.email || "",
        date: b.booking_date,
        propertyName: b.property_name || "Entrance Fee Only",
        adults: Number(b.adults || 0),
        children: Number(b.children || 0),
        seniors: Number(b.seniors || 0),
        guests: Number(b.adults || 0) + Number(b.children || 0) + Number(b.seniors || 0),
        status: b.booking_status || "pending",
        paymentStatus: b.payment_status || "pending",
        payment: b.payment_method || "cash",
        total: Number(b.total_amount || 0),
        approvedBy: usersById[String(b.reviewed_by)]?.full_name || "",
        notes: b.notes || "",
        createdAt: b.created_at,
      };
    });
  };

  db.countPendingBookings = async function () {
    const { count, error } = await sb()
      .from("bookings")
      .select("id", { count: "exact", head: true })
      .eq("booking_status", "pending");
    if (error) throw error;
    return count || 0;
  };

  db.updateBookingStatus = async function (bookingId, status) {
    const session = MaslogConfig.getSession();
    const updates = {
      booking_status: status,
      reviewed_at: new Date().toISOString(),
    };
    const reviewerId = Number(session?.userId);
    if (Number.isFinite(reviewerId)) updates.reviewed_by = reviewerId;

    const { error } = await sb().from("bookings").update(updates).eq("id", bookingId);
    if (error) throw error;
  };

  db.cancelClientBooking = async function (bookingCode) {
    const session = MaslogConfig.getSession();
    const userId = Number(session?.userId);
    if (!bookingCode || !Number.isFinite(userId)) throw new Error("Please sign in as a client first");

    const { data, error } = await sb()
      .from("bookings")
      .update({
        booking_status: "cancelled",
        reviewed_at: new Date().toISOString(),
      })
      .eq("booking_code", bookingCode)
      .eq("client_user_id", userId)
      .in("booking_status", ["pending", "confirmed"])
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("Booking cannot be cancelled or was already released");
    return true;
  };

  db.hasValidQrVerification = async function (bookingId) {
    if (!bookingId) return false;
    const { data, error } = await sb()
      .from("qr_verifications")
      .select("id")
      .eq("booking_id", bookingId)
      .eq("scan_result", "valid")
      .limit(1);
    if (error) throw error;
    return !!data?.length;
  };

  db.recordQrVerification = async function ({ bookingId, receiptId = null, result, notes = "" }) {
    const session = MaslogConfig.getSession();
    const verifiedBy = Number(session?.userId);
    if (!Number.isFinite(verifiedBy)) throw new Error("Please login as staff before verifying QR codes.");

    const { error } = await sb().from("qr_verifications").insert({
      booking_id: bookingId || null,
      receipt_id: receiptId || null,
      verified_by: verifiedBy,
      scan_result: result,
      notes,
    });
    if (error) throw error;
  };

  db.listQrVerifications = async function () {
    const { data, error } = await sb()
      .from("qr_verifications")
      .select("id, scan_result, verified_at")
      .order("verified_at", { ascending: false });
    if (error) throw error;
    return (data || []).map((q) => ({
      id: q.id,
      status: q.scan_result,
      date: q.verified_at,
    }));
  };

  function localDayRange(date = new Date()) {
    const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const end = new Date(start);
    end.setDate(start.getDate() + 1);
    return { start: start.toISOString(), end: end.toISOString() };
  }

  function mapWalkIn(w) {
    const items = w.walk_in_items || [];
    const entranceTotal = items
      .filter((item) => item.item_type === "entrance")
      .reduce((sum, item) => sum + Number(item.line_total || 0), 0);
    const propertyTotal = items
      .filter((item) => item.item_type === "cottage" || /rental/i.test(item.item_name || ""))
      .reduce((sum, item) => sum + Number(item.line_total || 0), 0);
    const visitorCount = items
      .filter((item) => item.item_type === "entrance")
      .reduce((sum, item) => sum + Number(item.qty || 0), 0);
    return {
      id: w.id,
      code: w.trx_code,
      customer: w.guest_name || "Walk-in Guest",
      date: w.created_at,
      type: "Walk-in",
      status: w.status || "completed",
      payment: w.payment_method || "cash",
      total: Number(w.total_amount || 0),
      entranceTotal,
      propertyTotal,
      visitorCount,
      cashierUserId: w.cashier_user_id,
      createdAt: w.created_at,
    };
  }

  db.listAdminWalkIns = async function () {
    const { data, error } = await sb()
      .from("walk_in_transactions")
      .select("*, walk_in_items(item_type, item_name, qty, line_total)")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data || []).map(mapWalkIn);
  };

  db.listStaffDailyWalkIns = async function () {
    const session = MaslogConfig.getSession();
    const cashierId = Number(session?.userId);
    if (!Number.isFinite(cashierId)) return [];
    const { start, end } = localDayRange();
    const { data, error } = await sb()
      .from("walk_in_transactions")
      .select("*, walk_in_items(item_type, item_name, qty, line_total)")
      .eq("cashier_user_id", cashierId)
      .gte("created_at", start)
      .lt("created_at", end)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data || []).map(mapWalkIn);
  };

  db.listStaffDailyQrVerifications = async function () {
    const session = MaslogConfig.getSession();
    const staffId = Number(session?.userId);
    if (!Number.isFinite(staffId)) return [];
    const { start, end } = localDayRange();
    const { data, error } = await sb()
      .from("qr_verifications")
      .select("id, scan_result, verified_at")
      .eq("verified_by", staffId)
      .gte("verified_at", start)
      .lt("verified_at", end)
      .order("verified_at", { ascending: false });
    if (error) throw error;
    return (data || []).map((q) => ({
      id: q.id,
      status: q.scan_result,
      date: q.verified_at,
    }));
  };

  db.createWalkInTransaction = async function ({ code, items, paymentMethod, subtotal, tax, discount, total, guestName = "Walk-in Guest", qrPayload = "" }) {
    const session = MaslogConfig.getSession();
    const cashierId = Number(session?.userId);
    if (!Number.isFinite(cashierId)) throw new Error("Please login as staff/admin before saving walk-in transactions.");

    const { data: trx, error } = await sb()
      .from("walk_in_transactions")
      .insert({
        trx_code: code,
        cashier_user_id: cashierId,
        guest_name: guestName,
        payment_method: paymentMethod || "cash",
        subtotal: Number(subtotal || 0),
        tax_amount: Number(tax || 0),
        discount_amount: Number(discount || 0),
        total_amount: Number(total || 0),
        status: "completed",
      })
      .select("id, trx_code")
      .single();
    if (error) throw error;

    const rows = (items || []).map((item) => {
      const itemType = item.type === "fee" ? "entrance" : ["cottage", "property"].includes(item.type) ? "cottage" : "other";
      return {
        transaction_id: trx.id,
        item_type: itemType,
        item_name: item.name,
        qty: Number(item.qty || 1),
        unit_price: Number(item.price || 0),
        line_total: Number(item.price || 0) * Number(item.qty || 1),
      };
    });
    if (rows.length) {
      const { error: itemErr } = await sb().from("walk_in_items").insert(rows);
      if (itemErr) throw itemErr;
    }

    const { error: receiptErr } = await sb().from("receipts").insert({
      receipt_no: code,
      source_type: "walk_in",
      walk_in_id: trx.id,
      guest_name: guestName,
      amount_paid: Number(total || 0),
      payment_method: paymentMethod || "cash",
      qr_payload: qrPayload || null,
    });
    if (receiptErr) throw receiptErr;

    return trx;
  };

  db.listAdminTransactions = async function () {
    const [bookings, walkIns, settings] = await Promise.all([
      db.listAdminBookings(),
      db.listAdminWalkIns(),
      db.getBookingSettings().catch(() => null),
    ]);
    const rates = settings?.entranceFees || { adult: 0, child: 0, senior: 0 };
    return [
      ...bookings.map((b) => {
        const entranceTotal =
          Number(b.adults || 0) * Number(rates.adult || 0) +
          Number(b.children || 0) * Number(rates.child || 0) +
          Number(b.seniors || 0) * Number(rates.senior || 0);
        const total = Number(b.total || 0);
        return {
          source: "Online Booking",
          code: b.code,
          customer: b.customer,
          date: b.createdAt || b.date,
          type: b.propertyName,
          status: b.paymentStatus || b.status,
          total,
          entranceTotal: Math.min(entranceTotal, total),
          propertyTotal: Math.max(total - entranceTotal, 0),
          visitorCount: b.guests || 0,
        };
      }),
      ...walkIns.map((w) => ({
        source: "Walk-in",
        code: w.code,
        customer: w.customer,
        date: w.createdAt || w.date,
        type: "Walk-in Transaction",
        status: w.status,
        total: w.total,
        entranceTotal: w.entranceTotal || 0,
        propertyTotal: w.propertyTotal || 0,
        visitorCount: w.visitorCount || 0,
      })),
    ].sort((a, b) => new Date(b.date) - new Date(a.date));
  };

  db.listStaffDailyTransactions = async function () {
    const walkIns = await db.listStaffDailyWalkIns();
    return walkIns.map((w) => ({
      source: "Walk-in",
      code: w.code,
      customer: w.customer,
      date: w.createdAt || w.date,
      type: "Walk-in Transaction",
      status: w.status,
      total: w.total,
      entranceTotal: w.entranceTotal || 0,
      propertyTotal: w.propertyTotal || 0,
      visitorCount: w.visitorCount || 0,
    }));
  };

  db.listNotifications = async function (userId) {
    if (!userId) return [];
    const { data, error } = await sb()
      .from("notifications")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data || []).map((n) => ({
      id: String(n.id),
      type: n.notif_type,
      title: n.title,
      message: n.message,
      href: n.href || "",
      time: new Date(n.created_at).getTime(),
      read: !!n.is_read,
    }));
  };

  db.markNotificationsRead = async function (userId, ids) {
    let q = sb().from("notifications").update({ is_read: true }).eq("user_id", userId);
    if (ids?.length) q = q.in("id", ids);
    const { error } = await q;
    if (error) throw error;
  };

  db.formatMoney = money;
  db.formatDate = formatDate;
  db.initials = initials;

  // Back-compat aliases used by older user-app.js patterns
  db.getCurrentUser = db.getCurrentClient;
  db.loadFees = db.loadStaffFees;
  db.loadSettings = db.getBookingSettings;
  db.saveSettings = db.saveBookingSettings;
  db.saveBooking = db.createBooking;
  db.loadBookings = async function () {
    const s = MaslogConfig.getSession();
    return db.listClientBookings(s?.userId || s?.email);
  };
  db.isDateUnavailable = function (dateStr, settings) {
    return (settings?.unavailableDates || []).includes(dateStr);
  };
  db.isPropertyUnavailable = function (propId, fees, settings) {
    const prop = (fees?.properties || []).find((p) => p.id === propId);
    if (prop && prop.available === false) return true;
    return (settings?.unavailablePropertyIds || []).includes(propId);
  };

  global.MaslogDB = db;
  global.MaslogUser = db; // replace old localStorage helper
})(typeof window !== "undefined" ? window : globalThis);

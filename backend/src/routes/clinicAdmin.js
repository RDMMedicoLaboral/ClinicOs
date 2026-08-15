import { Router } from "express";
import bcrypt from "bcryptjs";
import multer from "multer";
import * as XLSX from "xlsx";
import { db, logAudit, suggestAvailableUsername } from "../db.js";

// Este router completo ya está protegido en server.js con
// requireRole("medico") + requireAdmin: solo el médico admin/dueño de la
// clínica (no el resto de médicos, ni secretaria/enfermera) llega aquí.
// Es el "Panel de administración" dentro de la app (distinto de
// /admin.html, que sigue siendo exclusivo del superadmin de la plataforma).
export const clinicAdminRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

// ---------- Vista general: institución + médicos + equipo ----------
clinicAdminRouter.get("/overview", async (req, res) => {
  const institution = await db
    .prepare(`SELECT id, name, address, phone, logo_base64, created_at FROM institutions WHERE id = ?`)
    .get(req.user.institution_id);

  const doctors = await db
    .prepare(
      `SELECT u.id, u.username, u.full_name, u.is_admin, u.created_at,
        dp.professional_license, dp.specialty, dp.email,
        (SELECT COUNT(*) FROM patients p WHERE p.doctor_id = u.id) AS patient_count,
        (SELECT COUNT(*) FROM users s WHERE s.doctor_id = u.id) AS staff_count
       FROM users u
       LEFT JOIN doctor_profile dp ON dp.doctor_id = u.id
       WHERE u.institution_id = ? AND u.role = 'medico'
       ORDER BY u.is_admin DESC, u.full_name`
    )
    .all(req.user.institution_id);

  // Todo el personal (secretarias/enfermeras) de TODOS los médicos de la
  // clínica, con el nombre del médico al que está asignado — el admin
  // solo puede VERLO aquí (la gestión sigue siendo de cada médico desde
  // "Mi equipo", para no quitarle control sobre a quién le da acceso a
  // su propia cartera de pacientes).
  const staff = await db
    .prepare(
      `SELECT s.id, s.username, s.full_name, s.role, s.created_at, doc.full_name AS doctor_name
       FROM users s
       JOIN users doc ON doc.id = s.doctor_id
       WHERE s.institution_id = ? AND s.role IN ('secretaria', 'enfermera')
       ORDER BY doc.full_name, s.role, s.full_name`
    )
    .all(req.user.institution_id);

  res.json({ institution, doctors, staff });
});

// ---------- Datos de la clínica ----------
clinicAdminRouter.put("/institution", async (req, res) => {
  const { name, address, phone } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "El nombre de la clínica es obligatorio" });

  await db
    .prepare(`UPDATE institutions SET name = ?, address = ?, phone = ? WHERE id = ?`)
    .run(name.trim(), address ?? "", phone ?? "", req.user.institution_id);

  await logAudit({ institutionId: req.user.institution_id, doctorId: req.user.doctor_id, actor: req.user.username, action: "update", entity: "institution", entityId: req.user.institution_id });
  res.json(await db.prepare(`SELECT id, name, address, phone, logo_base64 FROM institutions WHERE id = ?`).get(req.user.institution_id));
});

clinicAdminRouter.put("/institution/logo", async (req, res) => {
  const { data_uri } = req.body;
  if (!data_uri || typeof data_uri !== "string" || !data_uri.startsWith("data:image/")) {
    return res.status(400).json({ error: "Formato de imagen inválido" });
  }
  const match = data_uri.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/);
  if (!match) return res.status(400).json({ error: "Solo se aceptan imágenes PNG, JPG o WEBP" });

  const approxBytes = Math.ceil((match[2].length * 3) / 4);
  if (approxBytes > MAX_LOGO_BYTES) return res.status(400).json({ error: "La imagen es muy grande (máximo 2 MB)" });

  await db.prepare(`UPDATE institutions SET logo_base64 = ? WHERE id = ?`).run(data_uri, req.user.institution_id);
  res.json({ logo_base64: data_uri });
});

clinicAdminRouter.delete("/institution/logo", async (req, res) => {
  await db.prepare(`UPDATE institutions SET logo_base64 = NULL WHERE id = ?`).run(req.user.institution_id);
  res.status(204).end();
});

// ---------- Médicos de la clínica ----------
clinicAdminRouter.post("/doctors", async (req, res) => {
  const { username, password, full_name, personal_id, professional_license, specialty, email, city } = req.body;
  if (!username || !password || !full_name) {
    return res.status(400).json({ error: "username, password y full_name son obligatorios" });
  }
  if (password.length < 6) return res.status(400).json({ error: "La contraseña debe tener al menos 6 caracteres" });

  const existing = await db.prepare(`SELECT id FROM users WHERE username = ?`).get(username.trim().toLowerCase());
  if (existing) {
    return res.status(400).json({ error: "Ese nombre de usuario ya existe", suggestion: await suggestAvailableUsername(username) });
  }

  const password_hash = bcrypt.hashSync(password, 10);
  const userResult = await db
    .prepare(`INSERT INTO users (institution_id, doctor_id, username, password_hash, full_name, role, is_admin) VALUES (?, NULL, ?, ?, ?, 'medico', 0)`)
    .run(req.user.institution_id, username.trim().toLowerCase(), password_hash, full_name);
  const doctorId = userResult.lastInsertRowid;

  await db
    .prepare(
      `INSERT INTO doctor_profile (doctor_id, full_name, personal_id, professional_license, specialty, email, city)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(doctorId, full_name, personal_id ?? "", professional_license ?? "", specialty ?? "", email ?? "", city ?? "");

  await logAudit({ institutionId: req.user.institution_id, doctorId, actor: req.user.username, action: "create", entity: "user", entityId: doctorId, detail: { role: "medico", created_by: "clinic_admin" } });

  res.status(201).json({ id: doctorId, username: username.trim().toLowerCase(), full_name, role: "medico", is_admin: false });
});

// PUT /doctors/:id -> el admin puede corregir CUALQUIER dato de un médico
// de su clínica, incluido el nombre completo (el propio médico no puede
// cambiarse el nombre a sí mismo, solo el admin — ver doctorProfile.js).
clinicAdminRouter.put("/doctors/:id", async (req, res) => {
  const doctor = await db.prepare(`SELECT * FROM users WHERE id = ? AND institution_id = ? AND role = 'medico'`).get(req.params.id, req.user.institution_id);
  if (!doctor) return res.status(404).json({ error: "Médico no encontrado en esta clínica" });

  const { full_name, personal_id, professional_license, specialty, email, city } = req.body;
  if (!full_name || !full_name.trim()) return res.status(400).json({ error: "El nombre completo es obligatorio" });

  await db.prepare(`UPDATE users SET full_name = ? WHERE id = ?`).run(full_name.trim(), doctor.id);
  await db
    .prepare(
      `INSERT INTO doctor_profile (doctor_id, full_name, personal_id, professional_license, specialty, email, city)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(doctor_id) DO UPDATE SET
         full_name = excluded.full_name, personal_id = excluded.personal_id,
         professional_license = excluded.professional_license, specialty = excluded.specialty,
         email = excluded.email, city = excluded.city`
    )
    .run(doctor.id, full_name.trim(), personal_id ?? "", professional_license ?? "", specialty ?? "", email ?? "", city ?? "");

  await logAudit({ institutionId: req.user.institution_id, doctorId: doctor.id, actor: req.user.username, action: "update", entity: "user", entityId: doctor.id, detail: { reason: "clinic_admin_edit" } });
  res.json(await db.prepare(`SELECT * FROM doctor_profile WHERE doctor_id = ?`).get(doctor.id));
});

clinicAdminRouter.post("/doctors/:id/reset-password", async (req, res) => {
  const doctor = await db.prepare(`SELECT * FROM users WHERE id = ? AND institution_id = ? AND role = 'medico'`).get(req.params.id, req.user.institution_id);
  if (!doctor) return res.status(404).json({ error: "Médico no encontrado en esta clínica" });

  const newPassword = Math.random().toString(36).slice(-8);
  const password_hash = bcrypt.hashSync(newPassword, 10);
  await db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(password_hash, doctor.id);
  await logAudit({ institutionId: req.user.institution_id, doctorId: doctor.id, actor: req.user.username, action: "update", entity: "user", entityId: doctor.id, detail: { reason: "password_reset_by_clinic_admin" } });

  res.json({ username: doctor.username, password: newPassword });
});

// PUT /doctors/:id/admin -> pasar/quitar el rol de admin a otro médico de
// la clínica (por ejemplo para compartir la administración con un socio).
// No se puede dejar la clínica sin ningún admin.
clinicAdminRouter.put("/doctors/:id/admin", async (req, res) => {
  const doctor = await db.prepare(`SELECT * FROM users WHERE id = ? AND institution_id = ? AND role = 'medico'`).get(req.params.id, req.user.institution_id);
  if (!doctor) return res.status(404).json({ error: "Médico no encontrado en esta clínica" });

  const { is_admin } = req.body;
  if (is_admin === false) {
    const otherAdmins = await db
      .prepare(`SELECT COUNT(*)::int AS n FROM users WHERE institution_id = ? AND role = 'medico' AND is_admin = 1 AND id != ?`)
      .get(req.user.institution_id, doctor.id);
    if (!otherAdmins || otherAdmins.n < 1) {
      return res.status(400).json({ error: "La clínica se quedaría sin ningún admin; designa otro admin primero" });
    }
  }

  await db.prepare(`UPDATE users SET is_admin = ? WHERE id = ?`).run(is_admin ? 1 : 0, doctor.id);
  await logAudit({ institutionId: req.user.institution_id, doctorId: doctor.id, actor: req.user.username, action: "update", entity: "user", entityId: doctor.id, detail: { is_admin: Boolean(is_admin) } });
  res.json({ id: doctor.id, is_admin: Boolean(is_admin) });
});

// DELETE /doctors/:id -> quitar a un médico de la clínica (y su cartera).
// No se puede eliminar a uno mismo, ni al último admin de la clínica.
clinicAdminRouter.delete("/doctors/:id", async (req, res) => {
  const doctor = await db.prepare(`SELECT * FROM users WHERE id = ? AND institution_id = ? AND role = 'medico'`).get(req.params.id, req.user.institution_id);
  if (!doctor) return res.status(404).json({ error: "Médico no encontrado en esta clínica" });
  if (doctor.id === req.user.doctor_id) {
    return res.status(400).json({ error: "No puedes eliminar tu propia cuenta desde aquí" });
  }
  if (doctor.is_admin) {
    const otherAdmins = await db
      .prepare(`SELECT COUNT(*)::int AS n FROM users WHERE institution_id = ? AND role = 'medico' AND is_admin = 1 AND id != ?`)
      .get(req.user.institution_id, doctor.id);
    if (!otherAdmins || otherAdmins.n < 1) {
      return res.status(400).json({ error: "No puedes eliminar al único admin de la clínica" });
    }
  }

  await db.prepare(`DELETE FROM users WHERE id = ?`).run(doctor.id);
  await logAudit({ institutionId: req.user.institution_id, actor: req.user.username, action: "delete", entity: "user", entityId: doctor.id, detail: { role: "medico" } });
  res.status(204).end();
});

// ---------- Medicamentos de la clínica: carga masiva por Excel ----------
// POST /clinic-admin/medications/import (multipart/form-data, campo "file")
// Columnas esperadas (insensible a mayúsculas/acentos en el encabezado):
//   generic_name / nombre generico | commercial_names / nombres comerciales | presentation / presentacion
clinicAdminRouter.post("/medications/import", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Sube un archivo .xlsx o .csv" });

  let rows;
  try {
    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  } catch (err) {
    return res.status(400).json({ error: "No se pudo leer el archivo. ¿Es un Excel (.xlsx) o CSV válido?" });
  }

  const normalizeKey = (k) =>
    k
      .toString()
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "_");

  const pick = (row, candidates) => {
    const map = {};
    for (const key of Object.keys(row)) map[normalizeKey(key)] = row[key];
    for (const c of candidates) if (map[c] !== undefined && String(map[c]).trim() !== "") return String(map[c]).trim();
    return "";
  };

  const toInsert = [];
  const skipped = [];
  for (const row of rows) {
    const generic_name = pick(row, ["generic_name", "nombre_generico", "nombre", "medicamento", "generico"]);
    const commercial_names = pick(row, ["commercial_names", "nombres_comerciales", "nombre_comercial", "comercial"]);
    const presentation = pick(row, ["presentation", "presentacion"]);
    if (!generic_name || !presentation) {
      skipped.push(row);
      continue;
    }
    toInsert.push([generic_name, commercial_names, presentation]);
  }

  if (toInsert.length === 0) {
    return res.status(400).json({
      error: "No se encontró ninguna fila válida. Cada fila necesita al menos 'nombre genérico' y 'presentación'.",
    });
  }

  const generics = toInsert.map((r) => r[0]);
  const commercials = toInsert.map((r) => r[1]);
  const presentations = toInsert.map((r) => r[2]);

  const inserted = await db
    .prepare(
      `INSERT INTO institution_medications (institution_id, generic_name, commercial_names, presentation)
       SELECT ?, * FROM UNNEST($2::text[], $3::text[], $4::text[]) AS t(generic_name, commercial_names, presentation)
       ON CONFLICT (institution_id, generic_name, presentation) DO NOTHING
       RETURNING id`
    )
    .all(req.user.institution_id, generics, commercials, presentations);

  await logAudit({
    institutionId: req.user.institution_id,
    doctorId: req.user.doctor_id,
    actor: req.user.username,
    action: "create",
    entity: "institution_medication",
    detail: { reason: "excel_import", rows_read: rows.length, inserted: inserted.length, skipped: skipped.length },
  });

  res.status(201).json({
    rows_read: rows.length,
    inserted: inserted.length,
    skipped: skipped.length,
  });
});

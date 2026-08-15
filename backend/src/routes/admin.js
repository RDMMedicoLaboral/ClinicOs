import { Router } from "express";
import bcrypt from "bcryptjs";
import { db, logAudit, suggestAvailableUsername } from "../db.js";

export const adminRouter = Router();

// Estas rutas las usas TÚ (el dueño de la plataforma) para dar de alta
// instituciones/clínicas nuevas y sus médicos. No usan el login normal —
// usan un secreto separado (variable de entorno ADMIN_SECRET) que solo tú
// conoces. Deliberadamente NO hay registro público: cada institución nueva
// la crea el administrador a mano, tal como se definió.
function requireAdminSecret(req, res, next) {
  if (!process.env.ADMIN_SECRET) {
    return res.status(500).json({ error: "ADMIN_SECRET no está configurado en el servidor (variable de entorno)." });
  }
  const provided = req.headers["x-admin-secret"];
  if (!provided || provided !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Secreto de administrador inválido" });
  }
  next();
}

adminRouter.use(requireAdminSecret);

// GET /api/admin/suggest-username?desired=sofia -> propone un usuario libre
adminRouter.get("/suggest-username", async (req, res) => {
  const desired = String(req.query.desired || "").trim();
  if (!desired) return res.json({ suggestion: "" });
  res.json({ suggestion: await suggestAvailableUsername(desired) });
});

// GET /api/admin/institutions -> lista de instituciones dadas de alta, con
// cuántos médicos/usuarios/pacientes tiene cada una.
adminRouter.get("/institutions", async (_req, res) => {
  const rows = await db
    .prepare(
      `SELECT i.id, i.name, i.address, i.phone, i.created_at,
        (SELECT COUNT(*) FROM users u WHERE u.institution_id = i.id AND u.role = 'medico') AS doctor_count,
        (SELECT COUNT(*) FROM users u WHERE u.institution_id = i.id AND u.role IN ('secretaria','enfermera')) AS staff_count,
        (SELECT COUNT(*) FROM patients p JOIN users u2 ON u2.id = p.doctor_id WHERE u2.institution_id = i.id) AS patient_count
       FROM institutions i ORDER BY i.created_at DESC`
    )
    .all();
  res.json(rows);
});

// GET /api/admin/institutions/:id/doctors -> médicos de una institución
adminRouter.get("/institutions/:id/doctors", async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT u.id, u.username, u.full_name, u.is_admin, u.created_at,
        (SELECT COUNT(*) FROM users s WHERE s.doctor_id = u.id) AS staff_count,
        (SELECT COUNT(*) FROM patients p WHERE p.doctor_id = u.id) AS patient_count
       FROM users u WHERE u.institution_id = ? AND u.role = 'medico' ORDER BY u.full_name`
    )
    .all(req.params.id);
  res.json(rows);
});

// POST /api/admin/institutions/:id/reset-password -> genera una contraseña
// nueva para un médico puntual (identificado por user_id) de esa institución.
adminRouter.post("/institutions/:id/reset-password", async (req, res) => {
  const { user_id, password } = req.body;
  const doctor = await db
    .prepare(`SELECT id, username FROM users WHERE id = ? AND institution_id = ? AND role = 'medico'`)
    .get(user_id, req.params.id);
  if (!doctor) return res.status(404).json({ error: "No se encontró esa cuenta de médico en esta institución" });

  const newPassword = password && password.length >= 6 ? password : Math.random().toString(36).slice(-8);
  const password_hash = bcrypt.hashSync(newPassword, 10);

  await db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(password_hash, doctor.id);
  await logAudit({ institutionId: req.params.id, doctorId: doctor.id, actor: "admin", action: "update", entity: "user", entityId: doctor.id, detail: { reason: "password_reset" } });

  res.json({ username: doctor.username, password: newPassword });
});

// POST /api/admin/institutions -> crea una institución/clínica nueva + su
// primera cuenta de médico.
adminRouter.post("/institutions", async (req, res) => {
  const {
    institution_name,
    institution_address,
    institution_phone,
    username,
    password,
    full_name,
    personal_id,
    professional_license,
    specialty,
    email,
    city,
  } = req.body;
  if (!institution_name || !username || !password || !full_name) {
    return res.status(400).json({ error: "institution_name, username, password y full_name son obligatorios" });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "La contraseña debe tener al menos 6 caracteres" });
  }

  const existing = await db.prepare(`SELECT id FROM users WHERE username = ?`).get(username.trim().toLowerCase());
  if (existing) {
    return res.status(400).json({
      error: "Ese nombre de usuario ya existe en otra institución",
      suggestion: await suggestAvailableUsername(username),
    });
  }

  const instResult = await db
    .prepare(`INSERT INTO institutions (name, address, phone) VALUES (?, ?, ?)`)
    .run(institution_name, institution_address ?? "", institution_phone ?? "");
  const institutionId = instResult.lastInsertRowid;

  const password_hash = bcrypt.hashSync(password, 10);
  // El primer médico de una clínica nueva queda marcado como admin/dueño
  // automáticamente: alguien tiene que poder gestionar el resto (agregar
  // colegas, corregir nombres, subir el logo, cargar medicinas) sin
  // depender de ti para cada cambio.
  const userResult = await db
    .prepare(`INSERT INTO users (institution_id, doctor_id, username, password_hash, full_name, role, is_admin) VALUES (?, NULL, ?, ?, ?, 'medico', 1)`)
    .run(institutionId, username.trim().toLowerCase(), password_hash, full_name);
  const doctorId = userResult.lastInsertRowid;

  // Pre-llenamos el perfil del médico con lo que ya sabemos (nombre y
  // nombre de la institución como mínimo), para que "Perfil del médico" no
  // se vea vacío la primera vez que el médico entra. Puede editarlo
  // libremente después.
  await db
    .prepare(
      `INSERT INTO doctor_profile
        (doctor_id, full_name, personal_id, professional_license, specialty, email, city, clinic_name, clinic_address, clinic_phone)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      doctorId,
      full_name,
      personal_id ?? "",
      professional_license ?? "",
      specialty ?? "",
      email ?? "",
      city ?? "",
      institution_name,
      institution_address ?? "",
      institution_phone ?? ""
    );

  await logAudit({ institutionId, doctorId, actor: "admin", action: "create", entity: "institution", entityId: institutionId, detail: { institution_name } });

  res.status(201).json({
    institution: { id: institutionId, name: institution_name },
    user: { id: doctorId, username: username.trim().toLowerCase(), full_name, role: "medico", is_admin: true },
  });
});

// POST /api/admin/institutions/:id/doctors -> agrega OTRO médico a una
// institución que ya existe (soporte multi-médico dentro de la misma clínica).
adminRouter.post("/institutions/:id/doctors", async (req, res) => {
  const institution = await db.prepare(`SELECT * FROM institutions WHERE id = ?`).get(req.params.id);
  if (!institution) return res.status(404).json({ error: "Institución no encontrada" });

  const { username, password, full_name, personal_id, professional_license, specialty, email, city, is_admin } = req.body;
  if (!username || !password || !full_name) {
    return res.status(400).json({ error: "username, password y full_name son obligatorios" });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "La contraseña debe tener al menos 6 caracteres" });
  }

  const existing = await db.prepare(`SELECT id FROM users WHERE username = ?`).get(username.trim().toLowerCase());
  if (existing) {
    return res.status(400).json({
      error: "Ese nombre de usuario ya existe",
      suggestion: await suggestAvailableUsername(username),
    });
  }

  const password_hash = bcrypt.hashSync(password, 10);
  const userResult = await db
    .prepare(`INSERT INTO users (institution_id, doctor_id, username, password_hash, full_name, role, is_admin) VALUES (?, NULL, ?, ?, ?, 'medico', ?)`)
    .run(institution.id, username.trim().toLowerCase(), password_hash, full_name, is_admin ? 1 : 0);
  const doctorId = userResult.lastInsertRowid;

  await db
    .prepare(
      `INSERT INTO doctor_profile
        (doctor_id, full_name, personal_id, professional_license, specialty, email, city, clinic_name, clinic_address, clinic_phone)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(doctorId, full_name, personal_id ?? "", professional_license ?? "", specialty ?? "", email ?? "", city ?? "", institution.name, institution.address ?? "", institution.phone ?? "");

  await logAudit({ institutionId: institution.id, doctorId, actor: "admin", action: "create", entity: "user", entityId: doctorId, detail: { role: "medico", is_admin: Boolean(is_admin) } });

  res.status(201).json({ id: doctorId, username: username.trim().toLowerCase(), full_name, role: "medico", is_admin: Boolean(is_admin) });
});

// PUT /api/admin/doctors/:id/admin -> te (superadmin) permite designar o
// quitarle a un médico el rol de admin/dueño de la clínica (por ejemplo,
// si el dueño original deja la clínica y hay que pasarle el puesto a
// otro médico, o si una clínica antigua migrada quedó sin admin).
adminRouter.put("/doctors/:id/admin", async (req, res) => {
  const doctor = await db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'medico'`).get(req.params.id);
  if (!doctor) return res.status(404).json({ error: "Médico no encontrado" });

  const { is_admin } = req.body;
  if (is_admin === false) {
    const otherAdmins = await db
      .prepare(`SELECT COUNT(*)::int AS n FROM users WHERE institution_id = ? AND role = 'medico' AND is_admin = 1 AND id != ?`)
      .get(doctor.institution_id, doctor.id);
    if (!otherAdmins || otherAdmins.n < 1) {
      return res.status(400).json({ error: "Esta clínica se quedaría sin ningún médico admin; designa otro admin primero" });
    }
  }

  await db.prepare(`UPDATE users SET is_admin = ? WHERE id = ?`).run(is_admin ? 1 : 0, doctor.id);
  await logAudit({ institutionId: doctor.institution_id, doctorId: doctor.id, actor: "admin", action: "update", entity: "user", entityId: doctor.id, detail: { is_admin: Boolean(is_admin) } });
  res.json({ id: doctor.id, is_admin: Boolean(is_admin) });
});

// DELETE /api/admin/institutions/:id -> borra una institución y TODO lo que
// le pertenece (médicos, secretarias/enfermeras, pacientes, etc. en cascada)
adminRouter.delete("/institutions/:id", async (req, res) => {
  const existing = await db.prepare(`SELECT id FROM institutions WHERE id = ?`).get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Institución no encontrada" });
  await db.prepare(`DELETE FROM institutions WHERE id = ?`).run(req.params.id);
  await logAudit({ actor: "admin", action: "delete", entity: "institution", entityId: req.params.id });
  res.status(204).end();
});

// DELETE /api/admin/doctors/:id -> borra un médico puntual (y su cartera
// de pacientes/secretarias) sin borrar el resto de la institución.
adminRouter.delete("/doctors/:id", async (req, res) => {
  const existing = await db.prepare(`SELECT id, institution_id FROM users WHERE id = ? AND role = 'medico'`).get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Médico no encontrado" });
  await db.prepare(`DELETE FROM users WHERE id = ?`).run(req.params.id);
  await logAudit({ institutionId: existing.institution_id, actor: "admin", action: "delete", entity: "user", entityId: req.params.id, detail: { role: "medico" } });
  res.status(204).end();
});

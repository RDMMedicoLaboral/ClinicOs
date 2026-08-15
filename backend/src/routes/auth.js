import { Router } from "express";
import bcrypt from "bcryptjs";
import { db, logAudit } from "../db.js";
import { signToken, requireAuth } from "../auth.js";

export const authRouter = Router();

// POST /api/auth/login
authRouter.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "username y password son obligatorios" });

  const row = await db
    .prepare(
      `SELECT u.*, i.name AS institution_name, doc.full_name AS assigned_doctor_name
       FROM users u
       JOIN institutions i ON i.id = u.institution_id
       LEFT JOIN users doc ON doc.id = u.doctor_id
       WHERE u.username = ?`
    )
    .get(username.trim().toLowerCase());

  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    return res.status(401).json({ error: "Usuario o contraseña incorrectos" });
  }

  const user = {
    id: row.id,
    username: row.username,
    full_name: row.full_name,
    role: row.role,
    // Un médico es dueño de sus propios datos (doctor_id = su propio id).
    // Una secretaria/enfermera hereda el doctor_id de su médico asignado.
    doctor_id: row.role === "medico" ? row.id : row.doctor_id,
    doctor_name: row.role === "medico" ? row.full_name : row.assigned_doctor_name,
    institution_id: row.institution_id,
    institution_name: row.institution_name,
  };
  await logAudit({ institutionId: user.institution_id, doctorId: user.doctor_id, actor: user.username, action: "login", entity: "user", entityId: user.id });
  res.json({ token: signToken(user), user });
});

// GET /api/auth/me -> valida el token y regresa el usuario actual
authRouter.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// POST /api/auth/change-password -> el usuario logueado (médico o
// secretaria) cambia su propia contraseña. Útil sobre todo para que la
// secretaria reemplace la clave temporal que le dio el médico al crear
// su cuenta.
authRouter.post("/change-password", requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) {
    return res.status(400).json({ error: "current_password y new_password son obligatorios" });
  }
  if (new_password.length < 6) {
    return res.status(400).json({ error: "La nueva contraseña debe tener al menos 6 caracteres" });
  }

  const row = await db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.user.id);
  if (!row || !bcrypt.compareSync(current_password, row.password_hash)) {
    return res.status(401).json({ error: "La contraseña actual no es correcta" });
  }

  const password_hash = bcrypt.hashSync(new_password, 10);
  await db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(password_hash, row.id);
  await logAudit({
    institutionId: req.user.institution_id,
    doctorId: req.user.doctor_id,
    actor: req.user.username,
    action: "update",
    entity: "user",
    entityId: row.id,
    detail: { reason: "self_change_password" },
  });

  res.json({ ok: true });
});

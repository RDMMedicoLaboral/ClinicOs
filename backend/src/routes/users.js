import { Router } from "express";
import bcrypt from "bcryptjs";
import { db, logAudit, suggestAvailableUsername } from "../db.js";

export const usersRouter = Router();

// GET /api/users/suggest-username?desired=sofia -> propone un usuario libre
usersRouter.get("/suggest-username", async (req, res) => {
  const desired = String(req.query.desired || "").trim();
  if (!desired) return res.json({ suggestion: "" });
  res.json({ suggestion: await suggestAvailableUsername(desired) });
});

// GET /api/users -> el equipo (secretarias/enfermeras) asignado a ESTE médico.
usersRouter.get("/", async (req, res) => {
  const rows = await db
    .prepare(`SELECT id, username, full_name, role, created_at FROM users WHERE doctor_id = ? ORDER BY role, full_name`)
    .all(req.user.doctor_id);
  res.json(rows);
});

usersRouter.post("/", async (req, res) => {
  const { username, password, full_name, role } = req.body;
  if (!username || !password || !full_name) {
    return res.status(400).json({ error: "username, password y full_name son obligatorios" });
  }
  if (!["secretaria", "enfermera"].includes(role)) {
    return res.status(400).json({ error: "role debe ser 'secretaria' o 'enfermera'" });
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
  // La secretaria/enfermera queda asignada exclusivamente a ESTE médico
  // (doctor_id) dentro de la misma institución — no puede ver la cartera
  // de otros médicos de la clínica.
  const result = await db
    .prepare(`INSERT INTO users (institution_id, doctor_id, username, password_hash, full_name, role) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(req.user.institution_id, req.user.doctor_id, username.trim().toLowerCase(), password_hash, full_name, role);

  await logAudit({
    institutionId: req.user.institution_id,
    doctorId: req.user.doctor_id,
    actor: req.user.username,
    action: "create",
    entity: "user",
    entityId: result.lastInsertRowid,
    detail: { role },
  });

  res.status(201).json(
    await db.prepare(`SELECT id, username, full_name, role, created_at FROM users WHERE id = ?`).get(result.lastInsertRowid)
  );
});

// POST /api/users/:id/reset-password -> el médico genera una clave
// temporal nueva para una cuenta de secretaria/enfermera asignada a él
// (por ejemplo si la olvidó). Debe cambiarla desde "Cambiar contraseña"
// apenas entre.
usersRouter.post("/:id/reset-password", async (req, res) => {
  const target = await db.prepare(`SELECT * FROM users WHERE id = ? AND doctor_id = ?`).get(req.params.id, req.user.doctor_id);
  if (!target) return res.status(404).json({ error: "Usuario no encontrado" });

  const newPassword = Math.random().toString(36).slice(-8);
  const password_hash = bcrypt.hashSync(newPassword, 10);
  await db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(password_hash, target.id);

  await logAudit({
    institutionId: req.user.institution_id,
    doctorId: req.user.doctor_id,
    actor: req.user.username,
    action: "update",
    entity: "user",
    entityId: target.id,
    detail: { reason: "password_reset" },
  });

  res.json({ username: target.username, password: newPassword });
});

usersRouter.delete("/:id", async (req, res) => {
  const target = await db.prepare(`SELECT * FROM users WHERE id = ? AND doctor_id = ?`).get(req.params.id, req.user.doctor_id);
  if (!target) return res.status(404).json({ error: "Usuario no encontrado" });

  await db.prepare(`DELETE FROM users WHERE id = ?`).run(req.params.id);
  await logAudit({ institutionId: req.user.institution_id, doctorId: req.user.doctor_id, actor: req.user.username, action: "delete", entity: "user", entityId: req.params.id });
  res.status(204).end();
});

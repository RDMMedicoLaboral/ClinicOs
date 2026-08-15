import { Router } from "express";
import { db } from "../db.js";
import { requireRole } from "../auth.js";

export const doctorProfileRouter = Router();

// GET /api/doctor-profile -> datos personales/profesionales del médico
// (los ve él mismo y su equipo, para precargar recetas/certificados).
// Los datos de la CLÍNICA (nombre, dirección, teléfono, logo) ya no viven
// aquí — son compartidos por todos los médicos de la institución y se
// consultan en /api/institution (lectura) / /api/clinic-admin (escritura,
// solo admin).
doctorProfileRouter.get("/", async (req, res) => {
  const profile = await db.prepare(`SELECT * FROM doctor_profile WHERE doctor_id = ?`).get(req.user.doctor_id);
  res.json(
    profile || {
      doctor_id: req.user.doctor_id,
      full_name: req.user.doctor_name || "",
      personal_id: "",
      professional_license: "",
      specialty: "",
      email: "",
      city: "",
    }
  );
});

// PUT /api/doctor-profile -> el médico edita su propio perfil.
// IMPORTANTE: el nombre completo NO se puede autoeditar aquí (evita que
// alguien lo cambie sin querer, o a propósito, después de que la cuenta
// ya quedó creada) — solo el médico admin/dueño de la clínica puede
// corregirlo, desde el Panel de administración
// (PUT /api/clinic-admin/doctors/:id), incluso para sí mismo.
doctorProfileRouter.put("/", requireRole("medico"), async (req, res) => {
  const { personal_id, professional_license, specialty, email, city } = req.body;

  const existing = await db.prepare(`SELECT full_name FROM doctor_profile WHERE doctor_id = ?`).get(req.user.doctor_id);
  const full_name = existing?.full_name || req.user.doctor_name || "";

  await db
    .prepare(
      `INSERT INTO doctor_profile
        (doctor_id, full_name, personal_id, professional_license, specialty, email, city)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(doctor_id) DO UPDATE SET
         personal_id = excluded.personal_id,
         professional_license = excluded.professional_license,
         specialty = excluded.specialty,
         email = excluded.email,
         city = excluded.city`
    )
    .run(
      req.user.doctor_id,
      full_name,
      personal_id ?? "",
      professional_license ?? "",
      specialty ?? "",
      email ?? "",
      city ?? ""
    );
  res.json(await db.prepare(`SELECT * FROM doctor_profile WHERE doctor_id = ?`).get(req.user.doctor_id));
});

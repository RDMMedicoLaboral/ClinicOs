import { Router } from "express";
import { db, logAudit } from "../db.js";

export const consultationsRouter = Router();

function computeBmi(weight_kg, height_cm) {
  if (!weight_kg || !height_cm) return null;
  const heightM = height_cm / 100;
  if (heightM <= 0) return null;
  return Math.round((weight_kg / (heightM * heightM)) * 10) / 10;
}

consultationsRouter.get("/patients/:patientId/consultations", async (req, res) => {
  const patient = await db.prepare(`SELECT id FROM patients WHERE id = ? AND doctor_id = ?`).get(req.params.patientId, req.user.doctor_id);
  if (!patient) return res.status(404).json({ error: "Paciente no encontrado" });

  const rows = await db
    .prepare(`SELECT * FROM consultations WHERE patient_id = ? AND doctor_id = ? ORDER BY created_at DESC`)
    .all(req.params.patientId, req.user.doctor_id);
  res.json(rows);
});

consultationsRouter.post("/consultations", async (req, res) => {
  // Las enfermeras solo pueden registrar signos vitales: el subjetivo, el
  // diagnóstico y el plan quedan reservados al médico (se ignoran aunque
  // vengan en el body, en vez de fallar, para no complicar el formulario
  // de enfermería).
  const isNurse = req.user.role === "enfermera";
  const {
    patient_id,
    appointment_id,
    subjective,
    blood_pressure,
    heart_rate,
    temperature_c,
    weight_kg,
    height_cm,
    diagnosis_code,
    diagnosis_label,
    plan,
  } = req.body;

  if (!patient_id) return res.status(400).json({ error: "patient_id es obligatorio" });

  const patient = await db.prepare(`SELECT id FROM patients WHERE id = ? AND doctor_id = ?`).get(patient_id, req.user.doctor_id);
  if (!patient) return res.status(400).json({ error: "El paciente no existe" });

  if (appointment_id) {
    const appt = await db.prepare(`SELECT id FROM appointments WHERE id = ? AND doctor_id = ?`).get(appointment_id, req.user.doctor_id);
    if (!appt) return res.status(400).json({ error: "La cita no existe en esta clínica" });
  }

  const bmi = computeBmi(weight_kg, height_cm);

  const result = await db
    .prepare(
      `INSERT INTO consultations
        (doctor_id, patient_id, appointment_id, subjective, blood_pressure, heart_rate,
         temperature_c, weight_kg, height_cm, bmi, diagnosis_code, diagnosis_label, plan)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.user.doctor_id,
      patient_id,
      appointment_id ?? null,
      isNurse ? null : subjective ?? null,
      blood_pressure ?? null,
      heart_rate ?? null,
      temperature_c ?? null,
      weight_kg ?? null,
      height_cm ?? null,
      bmi,
      isNurse ? null : diagnosis_code ?? null,
      isNurse ? null : diagnosis_label ?? null,
      isNurse ? null : plan ?? null
    );

  await logAudit({ doctorId: req.user.doctor_id, actor: req.user.username, action: "create", entity: "consultation", entityId: result.lastInsertRowid });

  // Cuando una enfermera toma los signos vitales antes de la consulta, la
  // cita NO se marca como finalizada todavía (eso lo hace el médico al
  // completar su nota); solo pasa a "en_consulta" si estaba pendiente,
  // para reflejar que el paciente ya fue atendido por enfermería.
  if (appointment_id && !isNurse) {
    await db
      .prepare(`UPDATE appointments SET status = 'finalizada', updated_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`)
      .run(appointment_id);
  }

  const consultation = await db.prepare(`SELECT * FROM consultations WHERE id = ?`).get(result.lastInsertRowid);
  res.status(201).json(consultation);
});

// PUT /api/consultations/:id -> editar una nota ya guardada (por si se escribió con un error)
consultationsRouter.put("/consultations/:id", async (req, res) => {
  const isNurse = req.user.role === "enfermera";
  const existing = await db
    .prepare(`SELECT * FROM consultations WHERE id = ? AND doctor_id = ?`)
    .get(req.params.id, req.user.doctor_id);
  if (!existing) return res.status(404).json({ error: "Nota no encontrada" });

  const {
    subjective,
    blood_pressure,
    heart_rate,
    temperature_c,
    weight_kg,
    height_cm,
    diagnosis_code,
    diagnosis_label,
    plan,
  } = req.body;

  const bmi = computeBmi(weight_kg, height_cm);

  await db
    .prepare(
      `UPDATE consultations SET
        subjective = ?, blood_pressure = ?, heart_rate = ?, temperature_c = ?,
        weight_kg = ?, height_cm = ?, bmi = ?, diagnosis_code = ?, diagnosis_label = ?, plan = ?,
        updated_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
       WHERE id = ?`
    )
    .run(
      // La enfermera solo puede tocar signos vitales; el resto de la nota
      // (escrita por el médico) se conserva tal cual estaba.
      isNurse ? existing.subjective : subjective ?? null,
      blood_pressure ?? null,
      heart_rate ?? null,
      temperature_c ?? null,
      weight_kg ?? null,
      height_cm ?? null,
      bmi,
      isNurse ? existing.diagnosis_code : diagnosis_code ?? null,
      isNurse ? existing.diagnosis_label : diagnosis_label ?? null,
      isNurse ? existing.plan : plan ?? null,
      req.params.id
    );

  await logAudit({ doctorId: req.user.doctor_id, actor: req.user.username, action: "update", entity: "consultation", entityId: req.params.id });
  res.json(await db.prepare(`SELECT * FROM consultations WHERE id = ?`).get(req.params.id));
});

// DELETE /api/consultations/:id -> borra una nota de evolución por si se
// registró por error. No borra en cascada la receta/certificado que
// pudieran estar ligados a ella (quedan sueltos, con consultation_id NULL,
// gracias al ON DELETE SET NULL de la base de datos).
consultationsRouter.delete("/consultations/:id", async (req, res) => {
  if (req.user.role === "enfermera") return res.status(403).json({ error: "Solo el médico puede eliminar notas de evolución" });
  const existing = await db
    .prepare(`SELECT * FROM consultations WHERE id = ? AND doctor_id = ?`)
    .get(req.params.id, req.user.doctor_id);
  if (!existing) return res.status(404).json({ error: "Nota no encontrada" });

  await db.prepare(`DELETE FROM consultations WHERE id = ?`).run(req.params.id);
  await logAudit({ doctorId: req.user.doctor_id, actor: req.user.username, action: "delete", entity: "consultation", entityId: req.params.id });
  res.json({ ok: true });
});

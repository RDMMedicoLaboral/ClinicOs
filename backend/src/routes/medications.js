import { Router } from "express";
import { db, logAudit } from "../db.js";

export const medicationsRouter = Router();

// GET /api/medications?q=... -> busca en el catálogo general de la app
// MÁS los medicamentos propios de la institución/clínica de este médico.
// Los de otras instituciones nunca aparecen aquí.
medicationsRouter.get("/", async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) return res.json([]);
  const like = `%${q}%`;
  const rows = await db
    .prepare(
      `SELECT id, generic_name, commercial_names, presentation, FALSE AS is_custom
         FROM medications_catalog
        WHERE generic_name ILIKE ? OR commercial_names ILIKE ?
       UNION ALL
       SELECT id, generic_name, commercial_names, presentation, TRUE AS is_custom
         FROM institution_medications
        WHERE institution_id = ? AND (generic_name ILIKE ? OR commercial_names ILIKE ?)
       ORDER BY generic_name LIMIT 15`
    )
    .all(like, like, req.user.institution_id, like, like);
  res.json(rows);
});

// GET /api/medications/mine -> lista completa de los medicamentos propios
// de la institución (compartidos entre todos sus médicos), para la
// pantalla de "Medicamentos de la clínica".
medicationsRouter.get("/mine", async (req, res) => {
  const rows = await db
    .prepare(`SELECT id, generic_name, commercial_names, presentation, created_at FROM institution_medications WHERE institution_id = ? ORDER BY generic_name`)
    .all(req.user.institution_id);
  res.json(rows);
});

// POST /api/medications -> agrega un medicamento propio de la institución
// (por ejemplo una lista que te dio el dueño de la clínica). Lo ven todos
// los médicos de esa institución.
medicationsRouter.post("/", async (req, res) => {
  const { generic_name, commercial_names, presentation } = req.body;
  if (!generic_name || !presentation) {
    return res.status(400).json({ error: "generic_name y presentation son obligatorios" });
  }
  const result = await db
    .prepare(`INSERT INTO institution_medications (institution_id, generic_name, commercial_names, presentation) VALUES (?, ?, ?, ?)`)
    .run(req.user.institution_id, generic_name, commercial_names ?? "", presentation);

  await logAudit({
    institutionId: req.user.institution_id,
    doctorId: req.user.doctor_id,
    actor: req.user.username,
    action: "create",
    entity: "institution_medication",
    entityId: result.lastInsertRowid,
  });

  res.status(201).json(
    await db.prepare(`SELECT id, generic_name, commercial_names, presentation, created_at FROM institution_medications WHERE id = ?`).get(result.lastInsertRowid)
  );
});

// DELETE /api/medications/:id -> borra un medicamento propio de la
// institución (nunca el catálogo general, y nunca uno de otra institución).
medicationsRouter.delete("/:id", async (req, res) => {
  const existing = await db.prepare(`SELECT id FROM institution_medications WHERE id = ? AND institution_id = ?`).get(req.params.id, req.user.institution_id);
  if (!existing) return res.status(404).json({ error: "Medicamento no encontrado" });

  await db.prepare(`DELETE FROM institution_medications WHERE id = ?`).run(req.params.id);
  await logAudit({ institutionId: req.user.institution_id, doctorId: req.user.doctor_id, actor: req.user.username, action: "delete", entity: "institution_medication", entityId: req.params.id });
  res.status(204).end();
});

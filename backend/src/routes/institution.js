import { Router } from "express";
import { db } from "../db.js";

export const institutionRouter = Router();

// GET /api/institution -> datos públicos (dentro de la app) de la clínica
// del usuario logueado: nombre, dirección, teléfono y logo. Cualquier rol
// (médico, secretaria, enfermera) puede LEER esto — por ejemplo para
// mostrar el logo en el encabezado — pero solo el médico admin puede
// escribirlo (ver routes/clinicAdmin.js).
institutionRouter.get("/", async (req, res) => {
  const institution = await db
    .prepare(`SELECT id, name, address, phone, logo_base64 FROM institutions WHERE id = ?`)
    .get(req.user.institution_id);
  res.json(
    institution || { id: req.user.institution_id, name: "", address: "", phone: "", logo_base64: null }
  );
});

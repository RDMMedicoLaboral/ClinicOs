import { Router } from "express";
import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, logAudit, newQrToken } from "../db.js";
import { spellDateSpanish, formatDateSlashes } from "../spanishDates.js";
import { notifyDocumentIssued } from "../notifications.js";

export const certificatesRouter = Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Logo de Clínic-Os (la aplicación), no confundir con el logo de la
// clínica (que el médico admin sube desde el Panel de administración).
// Se carga una sola vez al arrancar el proceso.
const APP_LOGO_PATH = path.join(__dirname, "..", "assets", "app-logo.png");
const appLogoBuffer = fs.existsSync(APP_LOGO_PATH) ? fs.readFileSync(APP_LOGO_PATH) : null;

// Colores de marca de Clínic-Os (mismos tonos "tierra" que --accent /
// --accent-dark en el frontend), usados para los títulos del certificado.
const BRAND_BROWN = "#8f4620";
const BRAND_BROWN_LIGHT = "#c2632f";

const TYPE_LABELS = {
  enfermedad: "Enfermedad",
  aislamiento: "Aislamiento",
  teletrabajo: "Teletrabajo",
};

// Trae el perfil profesional del médico (nombre, cédula, especialidad…)
// MÁS los datos de la clínica (nombre, dirección, teléfono), que ahora
// viven en la institución — así todos los médicos de una misma clínica
// muestran siempre el mismo membrete, y el admin los edita en un solo
// lugar para todos.
async function getDoctorProfile(doctorId) {
  const row = await db
    .prepare(
      `SELECT dp.full_name, dp.personal_id, dp.professional_license, dp.specialty, dp.email, dp.city,
              i.name AS clinic_name, i.address AS clinic_address, i.phone AS clinic_phone
         FROM users u
         JOIN institutions i ON i.id = u.institution_id
         LEFT JOIN doctor_profile dp ON dp.doctor_id = u.id
        WHERE u.id = ?`
    )
    .get(doctorId);
  return (
    row || {
      full_name: "",
      personal_id: "",
      professional_license: "",
      specialty: "",
      email: "",
      city: "",
      clinic_name: "",
      clinic_address: "",
      clinic_phone: "",
    }
  );
}

function daysBetweenInclusive(fromISO, toISO) {
  const from = new Date(`${fromISO}T00:00:00`);
  const to = new Date(`${toISO}T00:00:00`);
  const diff = Math.round((to - from) / (1000 * 60 * 60 * 24));
  return diff >= 0 ? diff + 1 : null;
}

// Convierte un "data URI" (ej. "data:image/png;base64,....") guardado en
// doctor_profile.logo_base64 a un Buffer que pdfkit pueda dibujar. Si no
// hay logo o el formato no es válido, regresa null en vez de tronar.
// PDFKit (la librería que arma el PDF) NO soporta WEBP, solo PNG/JPEG —
// por eso el regex es más estricto de lo que acepta el <input type="file">
// en algunos navegadores. Si el logo guardado no matchea, se ignora en vez
// de romper la generación del documento.
function parseLogoBuffer(dataUri) {
  if (!dataUri || typeof dataUri !== "string") return null;
  const match = dataUri.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/);
  if (!match) return null;
  try {
    return Buffer.from(match[2], "base64");
  } catch {
    return null;
  }
}

certificatesRouter.post("/", async (req, res) => {
  const {
    patient_id,
    consultation_id,
    diagnosis_code,
    diagnosis_label,
    clinical_picture,
    presents_symptoms,
    certificate_type,
    description,
    date_from,
    date_to,
    days_granted,
  } = req.body;

  if (!patient_id) return res.status(400).json({ error: "patient_id es obligatorio" });
  if (!date_from || !date_to) return res.status(400).json({ error: "date_from y date_to son obligatorios" });
  if (!TYPE_LABELS[certificate_type]) {
    return res.status(400).json({ error: "certificate_type debe ser enfermedad, aislamiento o teletrabajo" });
  }

  const patient = await db.prepare(`SELECT * FROM patients WHERE id = ? AND doctor_id = ?`).get(patient_id, req.user.doctor_id);
  if (!patient) return res.status(400).json({ error: "El paciente no existe" });

  const autoDays = daysBetweenInclusive(date_from, date_to);
  const finalDays = days_granted ?? autoDays;
  if (!finalDays || finalDays < 1) {
    return res.status(400).json({ error: "El rango de fechas o los días concedidos no son válidos" });
  }

  const doctor = await getDoctorProfile(req.user.doctor_id);
  const share_token = newQrToken();

  const result = await db
    .prepare(
      `INSERT INTO certificates
        (doctor_id, patient_id, consultation_id,
         diagnosis_code, diagnosis_label, clinical_picture, presents_symptoms, certificate_type,
         description, days_granted, date_from, date_to,
         patient_full_name, patient_address, patient_phone, patient_email,
         patient_institution, patient_job_title, patient_id_number, patient_clinical_history_number,
         doctor_name, doctor_personal_id, doctor_license, doctor_specialty, doctor_email,
         clinic_name, clinic_address, clinic_phone, issue_place, share_token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.user.doctor_id,
      patient_id,
      consultation_id ?? null,
      diagnosis_code ?? null,
      diagnosis_label ?? null,
      clinical_picture ?? null,
      presents_symptoms === false ? 0 : 1,
      certificate_type,
      description ?? null,
      finalDays,
      date_from,
      date_to,
      `${patient.first_name} ${patient.last_name}`,
      patient.address ?? null,
      patient.phone ?? null,
      patient.email ?? null,
      patient.workplace ?? null,
      patient.job_title ?? null,
      patient.id_number ?? null,
      patient.clinical_history_number ?? null,
      doctor.full_name,
      doctor.personal_id,
      doctor.professional_license,
      doctor.specialty,
      doctor.email,
      doctor.clinic_name,
      doctor.clinic_address,
      doctor.clinic_phone,
      doctor.city,
      share_token
    );

  await logAudit({ doctorId: req.user.doctor_id, actor: req.user.username, action: "create", entity: "certificate", entityId: result.lastInsertRowid });

  const certificate = await db.prepare(`SELECT * FROM certificates WHERE id = ?`).get(result.lastInsertRowid);

  // Envío automático por WhatsApp/correo, si el médico lo activó en
  // "Notificaciones automáticas". No bloquea la respuesta al usuario: si
  // el envío falla (credenciales no configuradas, etc.), el certificado
  // ya quedó creado igual — solo se registra el error en el log.
  notifyDocumentIssued({
    doctorId: req.user.doctor_id,
    kind: "certificate",
    id: certificate.id,
    patientPhone: patient.phone,
    patientEmail: patient.email,
    patientName: `${patient.first_name} ${patient.last_name}`,
  }).catch((err) => console.error("Error enviando notificación de certificado:", err));

  res.status(201).json(certificate);
});

certificatesRouter.get("/patient/:patientId", async (req, res) => {
  const rows = await db
    .prepare(`SELECT * FROM certificates WHERE patient_id = ? AND doctor_id = ? ORDER BY created_at DESC`)
    .all(req.params.patientId, req.user.doctor_id);
  res.json(rows);
});

certificatesRouter.get("/:id", async (req, res) => {
  const cert = await db.prepare(`SELECT * FROM certificates WHERE id = ? AND doctor_id = ?`).get(req.params.id, req.user.doctor_id);
  if (!cert) return res.status(404).json({ error: "Certificado no encontrado" });
  res.json(cert);
});

certificatesRouter.put("/:id", async (req, res) => {
  const existing = await db.prepare(`SELECT * FROM certificates WHERE id = ? AND doctor_id = ?`).get(req.params.id, req.user.doctor_id);
  if (!existing) return res.status(404).json({ error: "Certificado no encontrado" });

  const {
    diagnosis_code,
    diagnosis_label,
    clinical_picture,
    presents_symptoms,
    certificate_type,
    description,
    date_from,
    date_to,
    days_granted,
  } = req.body;

  if (!date_from || !date_to) return res.status(400).json({ error: "date_from y date_to son obligatorios" });
  if (!TYPE_LABELS[certificate_type]) {
    return res.status(400).json({ error: "certificate_type debe ser enfermedad, aislamiento o teletrabajo" });
  }

  const autoDays = daysBetweenInclusive(date_from, date_to);
  const finalDays = days_granted ?? autoDays;
  if (!finalDays || finalDays < 1) {
    return res.status(400).json({ error: "El rango de fechas o los días concedidos no son válidos" });
  }

  await db
    .prepare(
      `UPDATE certificates SET
        diagnosis_code = ?, diagnosis_label = ?, clinical_picture = ?, presents_symptoms = ?,
        certificate_type = ?, description = ?, days_granted = ?, date_from = ?, date_to = ?,
        updated_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
       WHERE id = ?`
    )
    .run(
      diagnosis_code ?? null,
      diagnosis_label ?? null,
      clinical_picture ?? null,
      presents_symptoms === false ? 0 : 1,
      certificate_type,
      description ?? null,
      finalDays,
      date_from,
      date_to,
      req.params.id
    );

  await logAudit({ doctorId: req.user.doctor_id, actor: req.user.username, action: "update", entity: "certificate", entityId: req.params.id });
  res.json(await db.prepare(`SELECT * FROM certificates WHERE id = ?`).get(req.params.id));
});

// DELETE /api/certificates/:id -> borra un certificado emitido por error
certificatesRouter.delete("/:id", async (req, res) => {
  const existing = await db.prepare(`SELECT * FROM certificates WHERE id = ? AND doctor_id = ?`).get(req.params.id, req.user.doctor_id);
  if (!existing) return res.status(404).json({ error: "Certificado no encontrado" });

  await db.prepare(`DELETE FROM certificates WHERE id = ?`).run(req.params.id);
  await logAudit({ doctorId: req.user.doctor_id, actor: req.user.username, action: "delete", entity: "certificate", entityId: req.params.id });
  res.json({ ok: true });
});

// Prepara los datos de un certificado (con el fallback del perfil actual
// del médico) y devuelve también el logo de la CLÍNICA vigente (compartido
// por todos los médicos de la institución, lo sube el admin) — usado
// tanto por la ruta autenticada de descarga como por el envío por
// WhatsApp/correo y la ruta pública de compartir.
export async function getCertificateReadyForPdf(certId) {
  const cert = await db.prepare(`SELECT * FROM certificates WHERE id = ?`).get(certId);
  if (!cert) return null;

  const doctorNow = await getDoctorProfile(cert.doctor_id);
  const institution = await db
    .prepare(`SELECT i.logo_base64 FROM institutions i JOIN users u ON u.institution_id = i.id WHERE u.id = ?`)
    .get(cert.doctor_id);
  const logoBuffer = parseLogoBuffer(institution?.logo_base64);
  cert.doctor_specialty = cert.doctor_specialty || doctorNow.specialty || null;
  cert.doctor_license = cert.doctor_license || doctorNow.professional_license || null;
  cert.doctor_personal_id = cert.doctor_personal_id || doctorNow.personal_id || null;

  return { cert, logoBuffer };
}

// Dibuja el PDF del certificado directamente sobre cualquier stream
// escribible (la respuesta HTTP, o un stream en memoria para adjuntarlo a
// un correo). Es la MISMA función que usan la descarga manual, el envío
// automático por correo y el link público de WhatsApp — un solo lugar
// donde vive el diseño del certificado.
export function renderCertificatePdf(cert, logoBuffer, writable) {
  const doc = new PDFDocument({ size: "A4", margin: 34 });
  // Mismo motivo que el listener en la ruta /pdf: sin esto, un error
  // interno de pdfkit (ej. imagen corrupta) puede escalar a una excepción
  // no capturada y tumbar el proceso completo.
  doc.on("error", (err) => console.error("[certificates] Error generando el PDF:", err.message));
  doc.pipe(writable);

  const margin = doc.page.margins.left;
  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  // Etiqueta y valor van en la MISMA línea (en vez de en dos líneas
  // separadas) para que el certificado completo quepa en una sola hoja.
  const row = (labelText, valueText) => {
    doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#333").text(`${labelText} `, { continued: true });
    doc.font("Helvetica").fontSize(9).fillColor("#000").text(valueText || "—");
    doc.moveDown(0.4);
  };
  const sectionTitle = (text) => {
    doc.moveDown(1.3); // 1-2 líneas de aire entre el bloque anterior (membrete/A/B/C) y el siguiente
    doc.font("Helvetica-Bold").fontSize(10.5).fillColor(BRAND_BROWN).text(text);
    doc.moveTo(doc.x, doc.y + 2).lineTo(doc.page.width - doc.page.margins.right, doc.y + 2).strokeColor(BRAND_BROWN).opacity(0.35).stroke().opacity(1);
    doc.moveDown(0.4);
  };

  // ---------- Encabezado ----------
  // Columna izquierda: logo del consultorio (más grande) y, debajo, el
  // nombre del consultorio. Columna derecha: logo de Clínic-Os (la app) y,
  // debajo, "Clínic-Os". En el centro: el título del certificado y el
  // nombre del médico.
  const sideColWidth = 118;
  const logoSize = 50;
  const headerTop = doc.y;
  const centerX = margin + sideColWidth;
  const centerWidth = contentWidth - sideColWidth * 2;

  if (logoBuffer) {
    // Misma red de seguridad que en prescriptions.js: si el logo no se
    // puede decodificar, seguimos generando el certificado sin él.
    try {
      doc.image(logoBuffer, margin + sideColWidth / 2 - logoSize / 2, headerTop, { width: logoSize, height: logoSize });
    } catch (err) {
      console.error("[certificates] No se pudo dibujar el logo de la clínica (se omite):", err.message);
    }
  }
  doc
    .font("Helvetica-Bold")
    .fontSize(8.5)
    .fillColor("#333")
    .text(cert.clinic_name || "Consultorio médico", margin, headerTop + logoSize + 4, { width: sideColWidth, align: "center" });

  if (appLogoBuffer) {
    doc.image(appLogoBuffer, doc.page.width - margin - sideColWidth / 2 - logoSize / 2, headerTop, { width: logoSize, height: logoSize });
  }
  doc
    .font("Helvetica-Bold")
    .fontSize(8.5)
    .fillColor("#333")
    .text("Clínic-Os", doc.page.width - margin - sideColWidth, headerTop + logoSize + 4, { width: sideColWidth, align: "center" });

  doc.font("Helvetica-Bold").fontSize(15).fillColor(BRAND_BROWN).text("CERTIFICADO MÉDICO", centerX, headerTop + 6, {
    width: centerWidth,
    align: "center",
  });
  if (cert.doctor_name) {
    doc.font("Helvetica-Bold").fontSize(11.5).fillColor(BRAND_BROWN).text(cert.doctor_name, centerX, doc.y + 4, {
      width: centerWidth,
      align: "center",
    });
  }

  doc.x = margin; // volvemos al margen izquierdo normal para el resto del documento
  doc.y = headerTop + logoSize + 4 + 12; // nunca empezar antes de que termine el bloque de logo + nombre

  sectionTitle("A) DATOS DEL ESTABLECIMIENTO DE SALUD");
  row("Nombre del establecimiento:", cert.clinic_name);
  row("Correo electrónico del médico emisor del certificado:", cert.doctor_email);
  row("Teléfono del emisor del certificado:", cert.clinic_phone);
  row("Dirección del establecimiento de salud:", cert.clinic_address);
  row(
    "Lugar y fecha de emisión:",
    // El servidor corre en UTC (Render); sin "Z" + timeZone explícito,
    // un certificado emitido de noche en Ecuador podía imprimir la fecha
    // del día SIGUIENTE por error — importante en un documento oficial.
    `${cert.issue_place || ""}, ${new Date(cert.created_at.replace(" ", "T") + "Z").toLocaleDateString("es-MX", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "America/Guayaquil",
    })}`
  );

  sectionTitle("B) DATOS DEL PACIENTE");
  row("Apellidos y nombres completo:", cert.patient_full_name);
  row("Dirección domiciliaria:", cert.patient_address);
  row("Número de teléfono:", cert.patient_phone);
  row("Institución o empresa:", cert.patient_institution);
  row("Puesto de trabajo del paciente:", cert.patient_job_title);
  row("Número de cédula:", cert.patient_id_number);
  row("Número de historia clínica:", cert.patient_clinical_history_number);
  row("Correo electrónico:", cert.patient_email);

  sectionTitle("C) MOTIVO DE AISLAMIENTO/ENFERMEDAD");
  row("Diagnóstico:", cert.diagnosis_label);
  if (cert.clinical_picture) row("Cuadro clínico:", cert.clinical_picture);
  row("Código CIE-10:", cert.diagnosis_code);
  row("Presenta síntomas:", cert.presents_symptoms ? "SI" : "NO");
  row("Tipo:", TYPE_LABELS[cert.certificate_type] || cert.certificate_type);
  if (cert.description) row("Descripción:", cert.description);
  row("Total de días concedidos:", `${cert.days_granted} (${cert.days_granted === 1 ? "un" : cert.days_granted} día${cert.days_granted === 1 ? "" : "s"})`);
  row("Desde:", `${formatDateSlashes(cert.date_from)} (${spellDateSpanish(cert.date_from)})`);
  row("Hasta:", `${formatDateSlashes(cert.date_to)} (${spellDateSpanish(cert.date_to)})`);

  // ---------- Firma ----------
  // El espacio antes de la firma debe ser el más grande del documento: la
  // empujamos hasta cerca del pie de página para que el certificado
  // aproveche toda la hoja en vez de dejar el resto en blanco.
  const signatureBlockHeight = 95; // línea + nombre + especialidad + reg. SENESCYT + C.I.
  const bottomLimit = doc.page.height - doc.page.margins.bottom;
  const targetSignatureTop = bottomLimit - signatureBlockHeight;
  if (doc.y < targetSignatureTop) {
    doc.y = targetSignatureTop;
  } else {
    doc.moveDown(0.8);
  }

  const signWidth = 240;
  const signX = doc.page.width / 2 - signWidth / 2;
  doc.moveTo(signX, doc.y).lineTo(signX + signWidth, doc.y).strokeColor("#000").stroke();
  doc.moveDown(0.3);
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#000").text(cert.doctor_name || "", signX, doc.y, { width: signWidth, align: "center" });
  doc.moveDown(0.1);
  doc.font("Helvetica").fontSize(8.5).fillColor("#333");
  // Orden solicitado: nombre (arriba), especialidad, registro SENESCYT, número de cédula.
  if (cert.doctor_specialty) doc.text(cert.doctor_specialty, signX, doc.y, { width: signWidth, align: "center" });
  if (cert.doctor_license) doc.text(`Reg. SENESCYT No. ${cert.doctor_license}`, signX, doc.y, { width: signWidth, align: "center" });
  if (cert.doctor_personal_id) doc.text(`C.I. ${cert.doctor_personal_id}`, signX, doc.y, { width: signWidth, align: "center" });

  doc.end();
}

certificatesRouter.get("/:id/pdf", async (req, res) => {
  const owned = await db.prepare(`SELECT id FROM certificates WHERE id = ? AND doctor_id = ?`).get(req.params.id, req.user.doctor_id);
  if (!owned) return res.status(404).json({ error: "Certificado no encontrado" });

  const ready = await getCertificateReadyForPdf(req.params.id);
  if (!ready) return res.status(404).json({ error: "Certificado no encontrado" });

  // Si el cliente cierra la conexión a medio descargar (muy común en
  // móvil: el usuario sale de la vista previa antes de que termine de
  // cargar), el stream de respuesta emite un evento "error" (ECONNRESET/
  // EPIPE). Sin este listener, Node lo trata como excepción no capturada
  // y TUMBA TODO EL SERVIDOR — este es el bug reportado de que "Render se
  // cae" al generar certificados. Con el listener, solo se registra y el
  // resto de la app sigue funcionando con normalidad.
  res.on("error", (err) => {
    console.error("[certificates] Conexión interrumpida al descargar el PDF (no se detiene el servidor):", err.message);
  });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="certificado-${ready.cert.id}.pdf"`);
  renderCertificatePdf(ready.cert, ready.logoBuffer, res);
});

// POST /api/certificates/:id/send -> envío manual por WhatsApp o correo,
// bajo demanda (además del envío automático si está activado).
certificatesRouter.post("/:id/send", async (req, res) => {
  const cert = await db.prepare(`SELECT * FROM certificates WHERE id = ? AND doctor_id = ?`).get(req.params.id, req.user.doctor_id);
  if (!cert) return res.status(404).json({ error: "Certificado no encontrado" });

  const { channel } = req.body; // "whatsapp" | "email"
  const result = await notifyDocumentIssued({
    doctorId: req.user.doctor_id,
    kind: "certificate",
    id: cert.id,
    patientPhone: cert.patient_phone,
    patientEmail: cert.patient_email,
    patientName: cert.patient_full_name,
    forceChannel: channel,
  });
  res.json(result);
});

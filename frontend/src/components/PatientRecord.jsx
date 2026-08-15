import { useEffect, useState } from "react";
import { api } from "../api.js";
import DiagnosisSearch from "./DiagnosisSearch.jsx";
import PrescriptionModal from "./PrescriptionModal.jsx";
import CertificateModal from "./CertificateModal.jsx";
import PatientModal from "./PatientModal.jsx";
import { formatAge } from "../utils/age.js";

const EMPTY_NOTE = {
  subjective: "",
  blood_pressure: "",
  heart_rate: "",
  temperature_c: "",
  weight_kg: "",
  height_cm: "",
  diagnosis_code: "",
  diagnosis_label: "",
  plan: "",
};

function computeBmi(weight, height) {
  const w = Number(weight);
  const h = Number(height);
  if (!w || !h) return null;
  const m = h / 100;
  return Math.round((w / (m * m)) * 10) / 10;
}

// Genera las opciones numéricas de un <select> de signos vitales. Si el
// valor actual (por ejemplo de una nota vieja) no cae exactamente en la
// lista generada, lo agregamos igual para no perder ese dato al editar.
function numericOptions(min, max, step, currentValue) {
  const opts = [];
  for (let v = min; v <= max + 1e-9; v += step) {
    opts.push(Math.round(v * 100) / 100);
  }
  const cur = currentValue !== "" && currentValue !== null && currentValue !== undefined ? Number(currentValue) : null;
  if (cur !== null && !Number.isNaN(cur) && !opts.some((o) => Math.abs(o - cur) < 1e-6)) {
    opts.push(cur);
    opts.sort((a, b) => a - b);
  }
  return opts;
}

function formatDateTime(iso) {
  // El backend guarda las horas en UTC (hora del servidor). Sin la "Z",
  // JavaScript interpretaba el texto como si YA fuera hora local del
  // navegador, mostrando 5 horas de más para Ecuador. Al agregar "Z" le
  // decimos "esto es UTC", y toLocaleString lo convierte solo a la hora
  // local de quien lo está viendo.
  return new Date(iso.replace(" ", "T") + "Z").toLocaleString("es-MX", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function dateKey(iso) {
  // Mismo motivo que formatDateTime: el texto es UTC. Si solo cortáramos
  // los primeros 10 caracteres agruparíamos por fecha UTC, y una nota
  // creada de noche en Ecuador (madrugada en UTC) aparecería agrupada
  // bajo el día siguiente. Acepta tanto "YYYY-MM-DD HH:MM:SS" (formato
  // del backend) como un ISO ya completo con "Z" (ej. new Date().toISOString()).
  const normalized = iso.includes("T") ? iso : iso.replace(" ", "T");
  const withZone = normalized.endsWith("Z") ? normalized : `${normalized}Z`;
  const d = new Date(withZone);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatDayHeading(key) {
  return new Date(`${key}T00:00:00`).toLocaleDateString("es-MX", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

// Agrupa nota(s) de evolución, recetas y certificados que comparten la
// MISMA FECHA en un solo contenedor — sin importar la hora exacta ni si
// quedaron técnicamente ligados por consultation_id. Solo la fecha más
// reciente de todas se resalta.
function buildVisitGroups(history, prescriptions, certificates) {
  const allDateKeys = Array.from(
    new Set([
      ...history.map((c) => dateKey(c.created_at)),
      ...prescriptions.map((rx) => dateKey(rx.created_at)),
      ...certificates.map((cert) => dateKey(cert.created_at)),
    ])
  ).sort((a, b) => (a < b ? 1 : -1)); // más reciente primero

  return allDateKeys.map((key, index) => ({
    key,
    dateKey: key,
    isLatest: index === 0,
    notes: history.filter((c) => dateKey(c.created_at) === key),
    rx: prescriptions.filter((rx) => dateKey(rx.created_at) === key),
    certs: certificates.filter((cert) => dateKey(cert.created_at) === key),
  }));
}

const CERT_TYPE_LABELS = {
  enfermedad: "Enfermedad",
  aislamiento: "Aislamiento",
  teletrabajo: "Teletrabajo",
};

export default function PatientRecord({ patientId, appointmentId, role, onOpenDoctorProfile, onBack }) {
  const isNurse = role === "enfermera";
  const [patient, setPatient] = useState(null);
  const [history, setHistory] = useState([]);
  const [prescriptions, setPrescriptions] = useState([]);
  const [certificates, setCertificates] = useState([]);
  const [doctorReady, setDoctorReady] = useState(true);
  const [showRxModal, setShowRxModal] = useState(false);
  const [showCertModal, setShowCertModal] = useState(false);
  const [editingRx, setEditingRx] = useState(null);
  const [editingCert, setEditingCert] = useState(null);
  const [showEditPatient, setShowEditPatient] = useState(false);
  const [editingNoteId, setEditingNoteId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [note, setNote] = useState(EMPTY_NOTE);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [savedMsg, setSavedMsg] = useState(false);

  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      // Enfermería no tiene permiso sobre /api/prescriptions ni
      // /api/certificates (son exclusivos del médico): si se piden de
      // todas formas, el 403 tumba el Promise.all completo y el
      // expediente se queda colgado en "Cargando expediente…" para
      // siempre. Para una enfermera, ni falta que le hacen.
      const [p, h, rx, certs, profile] = await Promise.all([
        api.patients.get(patientId),
        api.consultations.listByPatient(patientId),
        isNurse ? Promise.resolve([]) : api.prescriptions.listByPatient(patientId),
        isNurse ? Promise.resolve([]) : api.certificates.listByPatient(patientId),
        api.doctorProfile.get(),
      ]);
      setPatient(p);
      setHistory(h);
      setPrescriptions(rx);
      setCertificates(certs);
      setDoctorReady(Boolean(profile.full_name));
    } catch (err) {
      // Antes, cualquier falla aquí dejaba la pantalla en "Cargando
      // expediente…" para siempre sin ninguna pista de qué pasó.
      setLoadError(err.message || "No se pudo cargar el expediente.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    setNote(EMPTY_NOTE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId]);

  const set = (field) => (e) => setNote({ ...note, [field]: e.target.value });
  const bmi = computeBmi(note.weight_kg, note.height_cm);

  function startEditNote(c) {
    setEditingNoteId(c.id);
    setNote({
      subjective: c.subjective || "",
      blood_pressure: c.blood_pressure || "",
      heart_rate: c.heart_rate ?? "",
      temperature_c: c.temperature_c ?? "",
      weight_kg: c.weight_kg ?? "",
      height_cm: c.height_cm ?? "",
      diagnosis_code: c.diagnosis_code || "",
      diagnosis_label: c.diagnosis_label || "",
      plan: c.plan || "",
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function cancelEditNote() {
    setEditingNoteId(null);
    setNote(EMPTY_NOTE);
  }

  async function handleDeleteNote(id) {
    if (!confirm("¿Eliminar esta nota de evolución? Esta acción no se puede deshacer.")) return;
    await api.consultations.remove(id);
    if (editingNoteId === id) cancelEditNote();
    load();
  }

  async function handleDeleteRx(id) {
    if (!confirm("¿Eliminar esta receta? Esta acción no se puede deshacer.")) return;
    await api.prescriptions.remove(id);
    load();
  }

  async function handleDeleteCert(id) {
    if (!confirm("¿Eliminar este certificado médico? Esta acción no se puede deshacer.")) return;
    await api.certificates.remove(id);
    load();
  }

  const [sendingId, setSendingId] = useState(null); // `${kind}-${id}-${channel}` mientras se envía

  async function handleSendDocument(kind, id, channel) {
    setSendingId(`${kind}-${id}-${channel}`);
    try {
      const api_ = kind === "prescription" ? api.prescriptions : api.certificates;
      const result = await api_.send(id, channel);
      const outcome = result[channel];
      if (!outcome) {
        alert("No se pudo enviar: revisa la configuración en \"Envío automático\".");
      } else if (outcome.ok) {
        alert(channel === "whatsapp" ? "Enviado por WhatsApp." : "Enviado por correo.");
      } else {
        alert(`No se pudo enviar: ${outcome.error}`);
      }
    } catch (err) {
      alert(`No se pudo enviar: ${err.message}`);
    } finally {
      setSendingId(null);
    }
  }

  async function handleSave(e) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    const payload = {
      subjective: note.subjective || null,
      blood_pressure: note.blood_pressure || null,
      heart_rate: note.heart_rate ? Number(note.heart_rate) : null,
      temperature_c: note.temperature_c ? Number(note.temperature_c) : null,
      weight_kg: note.weight_kg ? Number(note.weight_kg) : null,
      height_cm: note.height_cm ? Number(note.height_cm) : null,
      diagnosis_code: note.diagnosis_code || null,
      diagnosis_label: note.diagnosis_label || null,
      plan: note.plan || null,
    };
    try {
      if (editingNoteId) {
        await api.consultations.update(editingNoteId, payload);
        setEditingNoteId(null);
      } else {
        await api.consultations.create({
          patient_id: patientId,
          appointment_id: appointmentId ?? null,
          ...payload,
        });
      }
      setNote(EMPTY_NOTE);
      setSavedMsg(true);
      setTimeout(() => setSavedMsg(false), 2500);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (loadError) {
    return (
      <div className="empty-state">
        <p className="form-error">No se pudo cargar el expediente: {loadError}</p>
        <button type="button" className="btn-ghost" onClick={onBack}>
          ← Volver a la agenda
        </button>
      </div>
    );
  }

  if (loading || !patient) {
    return <p className="empty-state">Cargando expediente…</p>;
  }

  const visits = buildVisitGroups(history, prescriptions, certificates);

  // Si el médico acaba de escribir una nota HOY, las recetas/certificados
  // que cree con los botones de abajo se vinculan automáticamente a esa
  // nota (para que queden agrupados). Si no hay nota de hoy, quedan
  // sueltos bajo la fecha de hoy — sin engancharse a una visita vieja.
  const todayKey = dateKey(new Date().toISOString());
  const todaysConsultation = history.find((c) => dateKey(c.created_at) === todayKey);
  const defaultConsultationId = todaysConsultation ? todaysConsultation.id : null;

  return (
    <div className="record-shell">
      <button className="btn-ghost back-btn" onClick={onBack}>
        ← Volver a la agenda
      </button>

      <div className="record-grid">
        {/* ---------- Columna izquierda: ficha + historial ---------- */}
        <aside className="record-history">
          <div className="folder-card">
            <div className="modal-tab" style={{ background: "#c2632f" }} />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
              <h2 className="patient-title">
                {patient.first_name} {patient.last_name}
              </h2>
              {!isNurse && (
                <button type="button" className="link-btn" onClick={() => setShowEditPatient(true)}>
                  Editar
                </button>
              )}
            </div>
            {formatAge(patient.birth_date) && (
              <div className="hint" style={{ marginTop: -6, marginBottom: 6 }}>
                {formatAge(patient.birth_date)}
              </div>
            )}
            {patient.clinical_history_number && (
              <div className="hint" style={{ marginTop: -6, marginBottom: 6 }}>
                HC #{patient.clinical_history_number}
              </div>
            )}
            <dl className="id-list">
              {patient.birth_date && (
                <>
                  <dt>Nacimiento</dt>
                  <dd>
                    {patient.birth_date}
                    {formatAge(patient.birth_date) ? ` (${formatAge(patient.birth_date)})` : ""}
                  </dd>
                </>
              )}
              {patient.gender && (
                <>
                  <dt>Género</dt>
                  <dd>{patient.gender}</dd>
                </>
              )}
              {patient.blood_type && (
                <>
                  <dt>Tipo de sangre</dt>
                  <dd>{patient.blood_type}</dd>
                </>
              )}
              {patient.phone && (
                <>
                  <dt>Teléfono</dt>
                  <dd>{patient.phone}</dd>
                </>
              )}
              {patient.id_number && (
                <>
                  <dt>Cédula</dt>
                  <dd>{patient.id_number}</dd>
                </>
              )}
              {patient.workplace && (
                <>
                  <dt>Institución</dt>
                  <dd>{patient.workplace}</dd>
                </>
              )}
            </dl>

            {patient.allergies && (
              <div className="allergy-banner">⚠ ALERGIAS: {patient.allergies}</div>
            )}
            {patient.chronic_conditions && (
              <div className="chronic-note">
                <strong>Antecedentes:</strong> {patient.chronic_conditions}
              </div>
            )}
          </div>

          <div className="rx-section-header">
            <h3 className="history-title" style={{ margin: 0 }}>
              Historial de atenciones
            </h3>
            {!isNurse && (
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn-primary sm" onClick={() => setShowRxModal(true)}>
                  + Nueva receta
                </button>
                <button className="btn-primary sm" onClick={() => setShowCertModal(true)}>
                  + Nuevo certificado
                </button>
              </div>
            )}
          </div>

          {visits.length === 0 ? (
            <p className="hint">Aún no hay atenciones registradas para este paciente.</p>
          ) : (
            <ol className="visit-list">
              {visits.map((v) => (
                <li key={v.key} className={`visit-day${v.isLatest ? " visit-day--latest" : ""}`}>
                  <div className="visit-day-header">
                    <span>{formatDayHeading(v.dateKey)}</span>
                  </div>

                  {v.notes.map((c) => (
                    <div key={`note-${c.id}`} className="folder-card history-card visit-item">
                      <div className="modal-tab" style={{ background: v.isLatest ? "#c98a2b" : "#6f8c6a" }} />
                      <div className="history-date">{formatDateTime(c.created_at)} · Nota de evolución</div>
                      {c.diagnosis_label && (
                        <div className="history-dx">
                          {c.diagnosis_code && <span className="cie-code">{c.diagnosis_code}</span>}{" "}
                          {c.diagnosis_label}
                        </div>
                      )}
                      {c.subjective && <div className="history-field"><strong>S:</strong> {c.subjective}</div>}
                      {(c.blood_pressure || c.heart_rate || c.bmi) && (
                        <div className="history-field">
                          <strong>O:</strong>{" "}
                          {[
                            c.blood_pressure && `PA ${c.blood_pressure}`,
                            c.heart_rate && `FC ${c.heart_rate} lpm`,
                            c.temperature_c && `T ${c.temperature_c}°C`,
                            c.bmi && `IMC ${c.bmi}`,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                      )}
                      {c.plan && <div className="history-field"><strong>P:</strong> {c.plan}</div>}
                      <div className="visit-item-actions">
                        <button type="button" className="link-btn" onClick={() => startEditNote(c)}>
                          {isNurse ? "Corregir signos vitales" : "Editar"}
                        </button>
                        {!isNurse && (
                          <button type="button" className="link-btn link-btn-danger" onClick={() => handleDeleteNote(c.id)}>
                            Eliminar
                          </button>
                        )}
                      </div>
                    </div>
                  ))}

                  {v.rx.map((rx) => (
                    <div key={`rx-${rx.id}`} className="folder-card history-card visit-item">
                      <div className="modal-tab" style={{ background: v.isLatest ? "#c98a2b" : "#7d6a52" }} />
                      <div className="history-date">{formatDateTime(rx.created_at)} · Receta</div>
                      <div className="history-field">{rx.items.map((it) => it.generic_name).join(", ")}</div>
                      <div className="visit-item-actions">
                        <a className="link-btn" href={api.prescriptions.pdfUrl(rx.id)} target="_blank" rel="noreferrer">
                          Ver PDF
                        </a>
                        {!isNurse && (
                          <>
                            <button type="button" className="link-btn" onClick={() => setEditingRx(rx)}>
                              Editar
                            </button>
                            <button type="button" className="link-btn link-btn-danger" onClick={() => handleDeleteRx(rx.id)}>
                              Eliminar
                            </button>
                          </>
                        )}
                      </div>
                      {!isNurse && (
                        <div className="visit-item-actions">
                        <button
                          type="button"
                          className="link-btn"
                          disabled={sendingId === `prescription-${rx.id}-whatsapp`}
                          onClick={() => handleSendDocument("prescription", rx.id, "whatsapp")}
                        >
                          {sendingId === `prescription-${rx.id}-whatsapp` ? "Enviando…" : "Enviar por WhatsApp"}
                        </button>
                        <button
                          type="button"
                          className="link-btn"
                          disabled={sendingId === `prescription-${rx.id}-email`}
                          onClick={() => handleSendDocument("prescription", rx.id, "email")}
                        >
                          {sendingId === `prescription-${rx.id}-email` ? "Enviando…" : "Enviar por correo"}
                        </button>
                        </div>
                      )}
                    </div>
                  ))}

                  {v.certs.map((cert) => (
                    <div key={`cert-${cert.id}`} className="folder-card history-card visit-item">
                      <div className="modal-tab" style={{ background: v.isLatest ? "#c98a2b" : "#6f8c6a" }} />
                      <div className="history-date">{formatDateTime(cert.created_at)} · Certificado médico</div>
                      <div className="history-dx">
                        {CERT_TYPE_LABELS[cert.certificate_type] || cert.certificate_type}
                        {cert.diagnosis_label ? ` — ${cert.diagnosis_label}` : ""}
                      </div>
                      <div className="history-field">
                        {cert.days_granted} día{cert.days_granted === 1 ? "" : "s"} · {cert.date_from} a {cert.date_to}
                      </div>
                      <div className="visit-item-actions">
                        <a className="link-btn" href={api.certificates.pdfUrl(cert.id)} target="_blank" rel="noreferrer">
                          Ver PDF
                        </a>
                        {!isNurse && (
                          <>
                            <button type="button" className="link-btn" onClick={() => setEditingCert(cert)}>
                              Editar
                            </button>
                            <button type="button" className="link-btn link-btn-danger" onClick={() => handleDeleteCert(cert.id)}>
                              Eliminar
                            </button>
                          </>
                        )}
                      </div>
                      {!isNurse && (
                        <div className="visit-item-actions">
                        <button
                          type="button"
                          className="link-btn"
                          disabled={sendingId === `certificate-${cert.id}-whatsapp`}
                          onClick={() => handleSendDocument("certificate", cert.id, "whatsapp")}
                        >
                          {sendingId === `certificate-${cert.id}-whatsapp` ? "Enviando…" : "Enviar por WhatsApp"}
                        </button>
                        <button
                          type="button"
                          className="link-btn"
                          disabled={sendingId === `certificate-${cert.id}-email`}
                          onClick={() => handleSendDocument("certificate", cert.id, "email")}
                        >
                          {sendingId === `certificate-${cert.id}-email` ? "Enviando…" : "Enviar por correo"}
                        </button>
                        </div>
                      )}
                    </div>
                  ))}
                </li>
              ))}
            </ol>
          )}
        </aside>

        {/* ---------- Columna derecha: nueva nota SOAP ---------- */}
        <section className="record-note folder-card">
          <div className="modal-tab" style={{ background: "#C08A3E" }} />
          <h3 className="modal-title">
            {isNurse ? "Registrar signos vitales" : editingNoteId ? "Editar nota de evolución (SOAP)" : "Nueva nota de evolución (SOAP)"}
          </h3>

          <form onSubmit={handleSave} className="soap-form">
            {!isNurse && (
              <label className="soap-block">
                <span className="soap-letter">S · Subjetivo</span>
                <textarea
                  rows={3}
                  value={note.subjective}
                  onChange={set("subjective")}
                  placeholder="Motivo de consulta, síntomas que refiere el paciente…"
                />
              </label>
            )}

            <div className="soap-block">
              <span className="soap-letter">{isNurse ? "Signos vitales" : "O · Objetivo (signos vitales)"}</span>
              <div className="vitals-grid">
                <label>
                  Presión arterial
                  <input value={note.blood_pressure} onChange={set("blood_pressure")} placeholder="120/80" />
                </label>
                <label>
                  FC (lpm)
                  <select value={note.heart_rate} onChange={set("heart_rate")}>
                    <option value="">Seleccionar…</option>
                    {numericOptions(30, 220, 1, note.heart_rate).map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Temp (°C)
                  <select value={note.temperature_c} onChange={set("temperature_c")}>
                    <option value="">Seleccionar…</option>
                    {numericOptions(34, 42, 0.1, note.temperature_c).map((v) => (
                      <option key={v} value={v}>
                        {v.toFixed(1)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Peso (kg)
                  <select value={note.weight_kg} onChange={set("weight_kg")}>
                    <option value="">Seleccionar…</option>
                    {numericOptions(1, 150, 0.5, note.weight_kg).map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Talla (cm)
                  <select value={note.height_cm} onChange={set("height_cm")}>
                    <option value="">Seleccionar…</option>
                    {numericOptions(30, 220, 1, note.height_cm).map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  IMC
                  <input value={bmi ?? "—"} disabled />
                </label>
              </div>
            </div>

            {!isNurse && (
              <label className="soap-block">
                <span className="soap-letter">A · Análisis (diagnóstico, CIE-10)</span>
                <DiagnosisSearch
                  code={note.diagnosis_code}
                  label={note.diagnosis_label}
                  onSelect={({ code, label }) => setNote((n) => ({ ...n, diagnosis_code: code, diagnosis_label: label }))}
                />
              </label>
            )}

            {!isNurse && (
              <label className="soap-block">
                <span className="soap-letter">P · Plan</span>
                <textarea
                  rows={3}
                  value={note.plan}
                  onChange={set("plan")}
                  placeholder="Tratamiento, estudios solicitados, recomendaciones…"
                />
              </label>
            )}

            {error && <p className="form-error">{error}</p>}
            {savedMsg && <p className="saved-msg">✓ Registro guardado.</p>}
            {editingNoteId && <p className="hint">Editando un registro existente.</p>}

            <div className="modal-actions">
              {editingNoteId && (
                <button type="button" className="btn-ghost" onClick={cancelEditNote}>
                  Cancelar edición
                </button>
              )}
              <button type="submit" className="btn-primary" disabled={saving}>
                {saving ? "Guardando…" : editingNoteId ? "Actualizar" : isNurse ? "Guardar signos vitales" : "Guardar nota"}
              </button>
            </div>
          </form>
        </section>
      </div>

      {(showRxModal || editingRx) && (
        <PrescriptionModal
          patientId={patientId}
          consultationId={editingRx ? editingRx.consultation_id ?? null : defaultConsultationId}
          existing={editingRx}
          doctorReady={doctorReady}
          onOpenDoctorProfile={onOpenDoctorProfile}
          onClose={() => {
            setShowRxModal(false);
            setEditingRx(null);
            load();
          }}
        />
      )}

      {(showCertModal || editingCert) && (
        <CertificateModal
          patientId={patientId}
          consultationId={editingCert ? editingCert.consultation_id ?? null : defaultConsultationId}
          existing={editingCert}
          doctorReady={doctorReady}
          onOpenDoctorProfile={onOpenDoctorProfile}
          onClose={() => {
            setShowCertModal(false);
            setEditingCert(null);
            load();
          }}
        />
      )}

      {showEditPatient && (
        <PatientModal
          isMedico={true}
          patient={patient}
          onClose={() => setShowEditPatient(false)}
          onUpdated={() => {
            setShowEditPatient(false);
            load();
          }}
        />
      )}
    </div>
  );
}

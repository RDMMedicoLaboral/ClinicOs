import { useEffect, useState } from "react";
import { api } from "../api.js";

const MAX_LOGO_MB = 2;
const EMPTY_DOCTOR_FORM = { username: "", password: "", full_name: "", personal_id: "", professional_license: "", specialty: "", email: "", city: "" };

export default function ClinicAdminModal({ onClose, onSaved }) {
  const [tab, setTab] = useState("clinica");
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      setOverview(await api.clinicAdmin.overview());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal folder-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 720 }}>
        <div className="modal-tab" style={{ background: "#c2632f" }} />
        <h2 className="modal-title">Panel de administración</h2>
        <p className="hint" style={{ marginTop: -8, marginBottom: 14 }}>
          Solo tú, como médico admin/dueño de la clínica, puedes ver y editar esto.
        </p>

        <div className="tab-row" style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
          {[
            ["clinica", "Datos de la clínica"],
            ["medicos", "Médicos"],
            ["equipo", "Equipo (secretarias/enfermeras)"],
            ["medicamentos", "Medicamentos"],
          ].map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={tab === key ? "btn-primary sm" : "btn-ghost sm"}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>

        {loading || !overview ? (
          <p className="hint">Cargando…</p>
        ) : (
          <>
            {tab === "clinica" && (
              <ClinicaTab
                institution={overview.institution}
                onChanged={(institution) => {
                  setOverview((o) => ({ ...o, institution }));
                  onSaved?.();
                }}
              />
            )}
            {tab === "medicos" && <MedicosTab doctors={overview.doctors} onReload={load} />}
            {tab === "equipo" && <EquipoTab staff={overview.staff} />}
            {tab === "medicamentos" && <MedicamentosTab />}
          </>
        )}

        <div className="modal-actions" style={{ marginTop: 18 }}>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}

function ClinicaTab({ institution, onChanged }) {
  const [form, setForm] = useState({ name: institution.name || "", address: institution.address || "", phone: institution.phone || "" });
  const [saving, setSaving] = useState(false);
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoError, setLogoError] = useState(null);
  const [logo, setLogo] = useState(institution.logo_base64 || null);

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const updated = await api.clinicAdmin.updateInstitution(form);
      onChanged(updated);
    } finally {
      setSaving(false);
    }
  }

  function handleLogoFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setLogoError(null);
    if (file.size > MAX_LOGO_MB * 1024 * 1024) {
      setLogoError(`La imagen debe pesar menos de ${MAX_LOGO_MB} MB.`);
      return;
    }
    // PDFKit (la librería que arma los PDF de recetas/certificados) NO
    // soporta WEBP, solo PNG y JPEG — si se sube WEBP, todas las recetas
    // y certificados de la clínica fallan al generarse.
    if (!["image/png", "image/jpeg", "image/jpg"].includes(file.type)) {
      setLogoError("Solo se aceptan imágenes PNG o JPG (WEBP no es compatible con los PDF).");
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      setLogoUploading(true);
      try {
        const result = await api.clinicAdmin.uploadLogo(reader.result);
        setLogo(result.logo_base64);
        onChanged({ ...institution, ...form, logo_base64: result.logo_base64 });
      } catch (err) {
        setLogoError(err.message);
      } finally {
        setLogoUploading(false);
      }
    };
    reader.readAsDataURL(file);
  }

  async function handleRemoveLogo() {
    if (!confirm("¿Quitar el logo de la clínica? Se mostrará el logo genérico de Clínic-Os.")) return;
    setLogoUploading(true);
    try {
      await api.clinicAdmin.removeLogo();
      setLogo(null);
      onChanged({ ...institution, ...form, logo_base64: null });
    } finally {
      setLogoUploading(false);
    }
  }

  return (
    <div>
      <div className="logo-uploader">
        <div className="logo-preview">
          {logo ? <img src={logo} alt="Logo de la clínica" /> : <img src="/assets/logo.png" alt="Logo genérico de Clínic-Os" style={{ opacity: 0.5 }} />}
        </div>
        <div>
          <p className="hint" style={{ margin: "0 0 8px" }}>
            Logo de la clínica {!logo && "(usando el logo genérico de Clínic-Os)"} — se muestra en todas las recetas y certificados de tus médicos.
          </p>
          <label className="btn-ghost sm" style={{ display: "inline-block", cursor: "pointer" }}>
            {logoUploading ? "Subiendo…" : logo ? "Cambiar logo" : "Subir logo"}
            <input type="file" accept="image/png,image/jpeg" onChange={handleLogoFile} disabled={logoUploading} style={{ display: "none" }} />
          </label>
          {logo && (
            <button type="button" className="link-btn" onClick={handleRemoveLogo} disabled={logoUploading} style={{ marginLeft: 10 }}>
              Quitar
            </button>
          )}
          {logoError && <p className="form-error" style={{ marginTop: 6 }}>{logoError}</p>}
        </div>
      </div>

      <form onSubmit={handleSubmit} className="form-grid" style={{ marginTop: 18 }}>
        <label className="span-2">
          Nombre de la clínica
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <label className="span-2">
          Dirección
          <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
        </label>
        <label>
          Teléfono
          <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </label>
        <div className="modal-actions span-2">
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? "Guardando…" : "Guardar datos de la clínica"}
          </button>
        </div>
      </form>
    </div>
  );
}

function MedicosTab({ doctors, onReload }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_DOCTOR_FORM);
  const [error, setError] = useState(null);
  const [suggestion, setSuggestion] = useState(null);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");
  const [tempPassword, setTempPassword] = useState(null);

  async function handleCreate(e) {
    e.preventDefault();
    setError(null);
    setSuggestion(null);
    setSaving(true);
    try {
      await api.clinicAdmin.createDoctor(form);
      setForm(EMPTY_DOCTOR_FORM);
      setShowForm(false);
      onReload();
    } catch (err) {
      setError(err.message);
      if (err.suggestion) setSuggestion(err.suggestion);
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveName(doctor) {
    if (!editName.trim()) return;
    await api.clinicAdmin.updateDoctor(doctor.id, {
      full_name: editName.trim(),
      personal_id: doctor.personal_id || "",
      professional_license: doctor.professional_license || "",
      specialty: doctor.specialty || "",
      email: doctor.email || "",
      city: doctor.city || "",
    });
    setEditingId(null);
    onReload();
  }

  async function handleToggleAdmin(doctor) {
    const makeAdmin = !doctor.is_admin;
    const msg = makeAdmin
      ? `¿Hacer admin/dueño de la clínica a ${doctor.full_name}? Podrá gestionar médicos, el logo y los medicamentos.`
      : `¿Quitarle el rol de admin a ${doctor.full_name}?`;
    if (!confirm(msg)) return;
    try {
      await api.clinicAdmin.setDoctorAdmin(doctor.id, makeAdmin);
      onReload();
    } catch (err) {
      alert(err.message);
    }
  }

  async function handleResetPassword(doctor) {
    if (!confirm(`¿Generar una nueva clave temporal para ${doctor.full_name}?`)) return;
    const result = await api.clinicAdmin.resetDoctorPassword(doctor.id);
    setTempPassword({ username: result.username, password: result.password });
  }

  async function handleRemove(doctor) {
    if (!confirm(`¿Eliminar la cuenta de ${doctor.full_name}? Esto no se puede deshacer.`)) return;
    try {
      await api.clinicAdmin.removeDoctor(doctor.id);
      onReload();
    } catch (err) {
      alert(err.message);
    }
  }

  return (
    <div>
      <ul className="user-list" style={{ maxHeight: 260 }}>
        {doctors.map((d) => (
          <li key={d.id} style={{ alignItems: "flex-start" }}>
            <div style={{ flex: 1 }}>
              {editingId === d.id ? (
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input value={editName} onChange={(e) => setEditName(e.target.value)} autoFocus />
                  <button type="button" className="link-btn" onClick={() => handleSaveName(d)}>
                    Guardar
                  </button>
                  <button type="button" className="link-btn" onClick={() => setEditingId(null)}>
                    Cancelar
                  </button>
                </div>
              ) : (
                <>
                  <strong>{d.full_name}</strong>
                  {d.is_admin && <span className="user-role-tag">Admin</span>}
                  <div className="hint">
                    @{d.username} · {d.patient_count} pacientes · {d.staff_count} en su equipo
                  </div>
                </>
              )}
            </div>
            {editingId !== d.id && (
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => {
                    setEditingId(d.id);
                    setEditName(d.full_name);
                  }}
                >
                  Corregir nombre
                </button>
                <button type="button" className="link-btn" onClick={() => handleToggleAdmin(d)}>
                  {d.is_admin ? "Quitar admin" : "Hacer admin"}
                </button>
                <button type="button" className="link-btn" onClick={() => handleResetPassword(d)}>
                  Nueva clave
                </button>
                <button type="button" className="link-btn" onClick={() => handleRemove(d)}>
                  Eliminar
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {tempPassword && (
        <p className="hint" style={{ background: "#e1eafb", padding: "10px 12px", borderRadius: 8 }}>
          Clave temporal para <strong>@{tempPassword.username}</strong>: <code>{tempPassword.password}</code>
        </p>
      )}

      {!showForm ? (
        <button type="button" className="btn-ghost sm" onClick={() => setShowForm(true)}>
          + Agregar médico
        </button>
      ) : (
        <form onSubmit={handleCreate} className="form-grid" style={{ marginTop: 12 }}>
          <label className="span-2">
            Nombre completo
            <input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} placeholder="Dr. Juan Pérez" autoFocus />
          </label>
          <label>
            Usuario
            <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
          </label>
          <label>
            Contraseña
            <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="Mín. 6 caracteres" />
          </label>
          <label>
            Especialidad
            <input value={form.specialty} onChange={(e) => setForm({ ...form, specialty: e.target.value })} />
          </label>
          <label>
            Cédula profesional
            <input value={form.professional_license} onChange={(e) => setForm({ ...form, professional_license: e.target.value })} />
          </label>

          {error && (
            <p className="form-error span-2">
              {error}
              {suggestion && (
                <>
                  {" "}
                  <button type="button" className="link-btn" onClick={() => setForm((f) => ({ ...f, username: suggestion }))}>
                    Usar "{suggestion}"
                  </button>
                </>
              )}
            </p>
          )}

          <div className="modal-actions span-2">
            <button type="button" className="btn-ghost" onClick={() => setShowForm(false)}>
              Cancelar
            </button>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? "Creando…" : "Crear médico"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function EquipoTab({ staff }) {
  return (
    <div>
      <p className="hint" style={{ marginTop: -4 }}>
        Vista de todo el personal de la clínica. Cada médico gestiona (agrega/elimina) a su propio
        equipo desde "Mi equipo".
      </p>
      <ul className="user-list" style={{ maxHeight: 320 }}>
        {staff.map((s) => (
          <li key={s.id}>
            <div>
              <strong>{s.full_name}</strong>
              <span className="user-role-tag">{s.role === "enfermera" ? "Enfermera" : "Secretaria"}</span>
              <div className="hint">
                @{s.username} · equipo de {s.doctor_name}
              </div>
            </div>
          </li>
        ))}
        {staff.length === 0 && <li className="hint">Todavía no hay secretarias ni enfermeras registradas.</li>}
      </ul>
    </div>
  );
}

function MedicamentosTab() {
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  async function handleFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    setResult(null);
    setUploading(true);
    try {
      const res = await api.clinicAdmin.importMedications(file);
      setResult(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div>
      <p className="hint" style={{ marginTop: -4 }}>
        Sube un Excel (.xlsx) o CSV con columnas <code>Nombre genérico</code>, <code>Nombres comerciales</code> y{" "}
        <code>Presentación</code> (los encabezados pueden variar un poco) para cargar toda la lista de golpe, en vez de
        agregar los medicamentos uno por uno.
      </p>
      <label className="btn-ghost sm" style={{ display: "inline-block", cursor: "pointer" }}>
        {uploading ? "Subiendo…" : "Elegir archivo Excel/CSV"}
        <input type="file" accept=".xlsx,.xls,.csv" onChange={handleFile} disabled={uploading} style={{ display: "none" }} />
      </label>
      {error && <p className="form-error" style={{ marginTop: 10 }}>{error}</p>}
      {result && (
        <p className="hint" style={{ background: "#e1eafb", padding: "10px 12px", borderRadius: 8, marginTop: 10 }}>
          Leídas {result.rows_read} filas · agregados {result.inserted} medicamentos nuevos
          {result.skipped > 0 && ` · ${result.skipped} filas omitidas por faltarles datos`}.
        </p>
      )}
    </div>
  );
}

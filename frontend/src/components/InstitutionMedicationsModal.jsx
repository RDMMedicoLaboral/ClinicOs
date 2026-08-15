import { useEffect, useState } from "react";
import { api } from "../api.js";

export default function InstitutionMedicationsModal({ onClose }) {
  const [meds, setMeds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ generic_name: "", commercial_names: "", presentation: "" });
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    try {
      setMeds(await api.medications.mine());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleCreate(e) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await api.medications.create(form);
      setForm({ generic_name: "", commercial_names: "", presentation: "" });
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id) {
    if (!confirm("¿Eliminar este medicamento de tu lista?")) return;
    await api.medications.remove(id);
    load();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal folder-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-tab" style={{ background: "#6f8c6a" }} />
        <h2 className="modal-title">Medicamentos de la clínica</h2>
        <p className="hint" style={{ marginTop: -8, marginBottom: 10 }}>
          Además del catálogo general de la app, aquí puedes agregar los medicamentos propios de tu clínica (por
          ejemplo la lista que te dio el dueño de la institución). Los ven todos los médicos de tu institución al
          buscar en Receta Electrónica; ninguna otra institución los ve, ni ustedes ven los de otras.
        </p>

        {loading ? (
          <p className="hint">Cargando…</p>
        ) : meds.length === 0 ? (
          <p className="hint">Todavía no han agregado ningún medicamento propio de la clínica.</p>
        ) : (
          <ul className="user-list">
            {meds.map((m) => (
              <li key={m.id}>
                <div>
                  <strong>{m.generic_name}</strong>
                  {m.commercial_names && <span className="user-role-tag">{m.commercial_names}</span>}
                  <div className="hint">{m.presentation}</div>
                </div>
                <button type="button" className="link-btn" onClick={() => handleDelete(m.id)}>
                  Eliminar
                </button>
              </li>
            ))}
          </ul>
        )}

        <h3 className="history-title">Agregar medicamento</h3>
        <form onSubmit={handleCreate} className="form-grid">
          <label className="span-2">
            Nombre genérico
            <input
              value={form.generic_name}
              onChange={(e) => setForm({ ...form, generic_name: e.target.value })}
              placeholder="Paracetamol"
            />
          </label>
          <label className="span-2">
            Nombres comerciales (opcional)
            <input
              value={form.commercial_names}
              onChange={(e) => setForm({ ...form, commercial_names: e.target.value })}
              placeholder="Tylenol, Panadol"
            />
          </label>
          <label className="span-2">
            Presentación
            <input
              value={form.presentation}
              onChange={(e) => setForm({ ...form, presentation: e.target.value })}
              placeholder="Tabletas 500mg"
            />
          </label>

          {error && <p className="form-error span-2">{error}</p>}

          <div className="modal-actions span-2">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cerrar
            </button>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? "Guardando…" : "Agregar"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

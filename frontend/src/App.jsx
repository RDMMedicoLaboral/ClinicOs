import { useEffect, useState, useCallback } from "react";
import { api, getToken, setToken, setUnauthorizedHandler } from "./api.js";
import AgendaView from "./components/AgendaView.jsx";
import PatientModal from "./components/PatientModal.jsx";
import AppointmentModal from "./components/AppointmentModal.jsx";
import PatientRecord from "./components/PatientRecord.jsx";
import DoctorProfileModal from "./components/DoctorProfileModal.jsx";
import LoginScreen from "./components/LoginScreen.jsx";
import UsersModal from "./components/UsersModal.jsx";
import InstitutionMedicationsModal from "./components/InstitutionMedicationsModal.jsx";
import ChangePasswordModal from "./components/ChangePasswordModal.jsx";
import ReminderSettingsModal from "./components/ReminderSettingsModal.jsx";
import NotificationSettingsModal from "./components/NotificationSettingsModal.jsx";
import Footer from "./components/Footer.jsx";

function todayISO() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function shiftDate(iso, days) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function formatHeaderDate(iso) {
  const d = new Date(`${iso}T00:00:00`);
  const s = d.toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long" });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default function App() {
  // ---------- Sesión ----------
  const [authLoading, setAuthLoading] = useState(true);
  const [user, setUser] = useState(null);

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    (async () => {
      try {
        if (getToken()) {
          const { user: me } = await api.auth.me();
          setUser(me);
        }
      } catch {
        setToken(null);
      } finally {
        setAuthLoading(false);
      }
    })();
  }, []);

  function handleLogout() {
    setToken(null);
    setUser(null);
  }

  const isMedico = user?.role === "medico";

  // ---------- Datos de la app ----------
  const [date, setDate] = useState(todayISO());
  const [patients, setPatients] = useState([]);
  const [appointments, setAppointments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showPatientModal, setShowPatientModal] = useState(false);
  const [showApptModal, setShowApptModal] = useState(false);
  const [search, setSearch] = useState("");
  const [record, setRecord] = useState(null); // { patientId, appointmentId } | null
  const [showDoctorProfile, setShowDoctorProfile] = useState(false);
  const [showUsers, setShowUsers] = useState(false);
  const [showMedications, setShowMedications] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [showReminders, setShowReminders] = useState(false);
  const [showNotificationSettings, setShowNotificationSettings] = useState(false);
  const [clinicLogo, setClinicLogo] = useState(null);

  const loadClinicLogo = useCallback(async () => {
    try {
      const profile = await api.doctorProfile.get();
      setClinicLogo(profile.logo_base64 || null);
    } catch {
      setClinicLogo(null);
    }
  }, []);

  const loadPatients = useCallback(async () => {
    setPatients(await api.patients.list());
  }, []);

  const loadAppointments = useCallback(async (d) => {
    setLoading(true);
    try {
      setAppointments(await api.appointments.listByDate(d));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    loadPatients();
  }, [user, loadPatients]);

  useEffect(() => {
    if (!user) return;
    loadClinicLogo();
  }, [user, loadClinicLogo]);

  useEffect(() => {
    if (!user) return;
    loadAppointments(date);
  }, [user, date, loadAppointments]);

  async function handleStatusChange(id, status) {
    setAppointments((prev) => prev.map((a) => (a.id === id ? { ...a, status } : a)));
    try {
      await api.appointments.setStatus(id, status);
    } catch {
      loadAppointments(date);
    }
  }

  async function handleSendReminder(id) {
    await api.reminders.send(id);
    loadAppointments(date);
  }

  const filteredPatients = search
    ? patients.filter((p) => `${p.first_name} ${p.last_name}`.toLowerCase().includes(search.toLowerCase()))
    : patients;

  if (authLoading) return null;

  if (!user) {
    return (
      <LoginScreen
        onAuthenticated={(u) => {
          setUser(u);
        }}
      />
    );
  }

  return (
    <div className="app-shell">
      <header className="top-header">
        <div className="brand">
          <div className="brand-clinic">
            <img src={clinicLogo || "/assets/logo.png"} alt={user.institution_name || "Institución"} className="brand-mark" />
            <div>
              <div className="brand-institution-name">{user.institution_name || "Institución"}</div>
              {user.doctor_name && <div className="brand-doctor-name">Dr(a). {user.doctor_name}</div>}
            </div>
          </div>
          <div className="brand-app">
            <img src="/assets/logo.png" alt="Clínic-Os" className="brand-mark brand-mark-sm" />
            <div>
              <div className="brand-name"><span className="brand-medic">Clínic</span><span className="brand-os">-Os</span></div>
              <div className="brand-app-caption">Software multiclínica</div>
            </div>
          </div>
        </div>

        <div className="top-header-actions">
          {isMedico && (
            <div className="more-menu">
              <button className="btn-ghost" onClick={() => setShowMoreMenu((v) => !v)}>
                Más opciones ▾
              </button>
              {showMoreMenu && (
                <div className="more-menu-panel" onMouseLeave={() => setShowMoreMenu(false)}>
                  <button
                    onClick={() => {
                      setShowDoctorProfile(true);
                      setShowMoreMenu(false);
                    }}
                  >
                    Perfil del médico
                  </button>
                  <button
                    onClick={() => {
                      setShowUsers(true);
                      setShowMoreMenu(false);
                    }}
                  >
                    Gestionar usuarios
                  </button>
                  <button
                    onClick={() => {
                      setShowMedications(true);
                      setShowMoreMenu(false);
                    }}
                  >
                    Medicamentos de la clínica
                  </button>
                  <button
                    onClick={() => {
                      setShowReminders(true);
                      setShowMoreMenu(false);
                    }}
                  >
                    Recordatorios
                  </button>
                  <button
                    onClick={() => {
                      setShowNotificationSettings(true);
                      setShowMoreMenu(false);
                    }}
                  >
                    Envío automático
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="user-badge">
            <div>
              <strong>{user.full_name}</strong>
              <span className="user-role-tag">
                {isMedico ? "Médico" : user.role === "enfermera" ? "Enfermera" : "Secretaria"}
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
              <button className="link-btn" onClick={() => setShowChangePassword(true)}>
                Cambiar contraseña
              </button>
              <button className="link-btn" onClick={handleLogout}>
                Cerrar sesión
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="app-body">
        <main className="main">
          {record && isMedico ? (
            <PatientRecord
              patientId={record.patientId}
              appointmentId={record.appointmentId}
              onOpenDoctorProfile={() => setShowDoctorProfile(true)}
              onBack={() => {
                setRecord(null);
                loadAppointments(date);
              }}
            />
          ) : (
            <>
              <header className="agenda-header">
                <div className="date-nav">
                  <button className="btn-ghost icon" onClick={() => setDate((d) => shiftDate(d, -1))}>
                    ‹
                  </button>
                  <div className="date-label">
                    <div className="date-title">{formatHeaderDate(date)}</div>
                    <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                  </div>
                  <button className="btn-ghost icon" onClick={() => setDate((d) => shiftDate(d, 1))}>
                    ›
                  </button>
                  <button className="btn-ghost" onClick={() => setDate(todayISO())}>
                    Hoy
                  </button>
                </div>
                <button className="btn-primary" onClick={() => setShowApptModal(true)}>
                  + Nueva cita
                </button>
              </header>

              <AgendaView
                appointments={appointments}
                loading={loading}
                isMedico={isMedico}
                onChangeStatus={handleStatusChange}
                onOpenRecord={(patientId, appointmentId) => isMedico && setRecord({ patientId, appointmentId })}
                onSendReminder={handleSendReminder}
              />
            </>
          )}
        </main>

        <aside className="sidebar">
          <button className="btn-primary full" onClick={() => setShowPatientModal(true)}>
            + Nuevo paciente
          </button>

          <input
            className="search-input"
            placeholder="Buscar paciente…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />

          <ul className="patient-list">
            {filteredPatients.map((p) => (
              <li
                key={p.id}
                className={isMedico ? "clickable" : ""}
                onClick={() => isMedico && setRecord({ patientId: p.id, appointmentId: null })}
              >
                <span>
                  {p.first_name} {p.last_name}
                </span>
                {p.allergies && <span className="allergy-dot" title={`Alergia: ${p.allergies}`} />}
              </li>
            ))}
            {filteredPatients.length === 0 && <li className="hint">Sin resultados.</li>}
          </ul>
        </aside>
      </div>

      {showPatientModal && (
        <PatientModal
          isMedico={isMedico}
          onClose={() => setShowPatientModal(false)}
          onCreated={() => {
            setShowPatientModal(false);
            loadPatients();
          }}
        />
      )}

      {showApptModal && (
        <AppointmentModal
          date={date}
          patients={patients}
          onClose={() => setShowApptModal(false)}
          onNewPatient={() => {
            setShowApptModal(false);
            setShowPatientModal(true);
          }}
          onCreated={() => {
            setShowApptModal(false);
            loadAppointments(date);
          }}
        />
      )}

      {showDoctorProfile && isMedico && (
        <DoctorProfileModal
          onClose={() => setShowDoctorProfile(false)}
          onSaved={() => {
            setShowDoctorProfile(false);
            loadClinicLogo();
          }}
        />
      )}

      {showUsers && isMedico && <UsersModal onClose={() => setShowUsers(false)} />}
      {showMedications && isMedico && <InstitutionMedicationsModal onClose={() => setShowMedications(false)} />}

      {showChangePassword && <ChangePasswordModal onClose={() => setShowChangePassword(false)} />}

      {showReminders && isMedico && <ReminderSettingsModal onClose={() => setShowReminders(false)} />}

      {showNotificationSettings && isMedico && (
        <NotificationSettingsModal onClose={() => setShowNotificationSettings(false)} />
      )}

      <Footer />
    </div>
  );
}

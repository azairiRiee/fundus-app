/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  Plus, 
  Search, 
  Filter, 
  CheckCircle2, 
  XCircle,
  Clock, 
  Calendar, 
  User as UserIcon, 
  Phone, 
  LogOut, 
  MoreVertical,
  Trash2,
  Edit2,
  AlertCircle,
  Users,
  Download,
  Printer,
  Lock,
  UserPlus,
  ShieldCheck,
  UserCog,
  CameraOff,
  Eye,
  ScanEye,
  EyeOff,
  Key,
  Activity,
  BarChart3,
  AlertTriangle,
  CircleOff,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  UserX,
  Building2,
  Network,
  Settings2,
  Database,
  Shield,
  LayoutDashboard,
  ClipboardList,
  Inbox,
  ClipboardCheck
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { jsPDF } from 'jspdf';

import clinicLogo from './assets/logo.png';
import fundusBg from './assets/fundus-bg.png';
import roundLogo from './assets/logo2.png';
import textLogo from './assets/logo3.png';

import { db } from './firebase';

import {
  collection,
  addDoc,
  onSnapshot,
  updateDoc,
  deleteDoc,
  doc,
  query,
  orderBy,
  limit,
  getDocs,
  setDoc,
  where,
  writeBatch
} from 'firebase/firestore';

import { analyzeFundus } from "./services/aiService";

const APP_VERSION = "v5.0.0-beta.2";

// ==============================================
// SINAR SHARED FOOTER — EDIT THESE VALUES ONCE
// ==============================================
const APP_FOOTER = {
  title: "SINAR . Sistem Interpretasi & Nota Awal Retinopati",
  createdBy: "Azairi - Zikri - Fairuz",
};

function AppFooter() {
  return (
    <footer className="w-full mt-auto pt-5 pb-3 text-center">
      <p className="text-[10px] font-bold tracking-widest uppercase text-slate-500">
        {APP_FOOTER.title} · {APP_VERSION}
      </p>
      <p className="mt-1 text-[9px] font-semibold tracking-wide text-slate-400">
        Created by {APP_FOOTER.createdBy}
      </p>
    </footer>
  );
}

// =====================================================
// CLINIC / FACILITY MASTER
// Every facility is a standalone SINAR environment.
//
// IMPORTANT:
// - PBOA, HSS and OPD are no longer treated as departments.
// - Clinic identity controls the operational UI/data scope.
// - `isFundusProvider` controls whether the clinic performs fundus
//   screening itself or selects another clinic as its fundus provider.
// - These defaults are only the migration fallback. Super Admin can
//   add new clinics through the app; new clinics are stored in Firestore.
// =====================================================

interface SpecialistClinic {
  id: string;
  name: string;
  shortName?: string;
  address?: string;
  phone?: string;
  active: boolean;
  createdAt: number;
}

interface SpecialistUser {
  id: string;
  password?: string;
  email?: string;
  displayName: string;
  clinicId: string;
  role: 'ADMIN' | 'STAFF' | 'SPECIALIST';
  active: boolean;
  createdAt: number;
}

interface Clinic {
  id: string;
  name: string;
  shortName: string;
  address?: string;
  phone?: string;
  active: boolean;
  isFundusProvider: boolean;
  //--- Persistent clinic identity color; Super Admin can change this from Clinic Management ---//
  colorKey?: string;
  //--- Multiple fundus providers allowed for referral routing ---//
  fundusProviderClinicIds?: string[];
  //--- Specialist clinics explicitly authorized by this clinic for referrals ---//
  specialistClinicIds?: string[];
  //--- TCA days configured by a provider clinic for each referring clinic ---//
  referralTcaDays?: Record<string, number[]>;
}

const DEFAULT_CLINICS: Clinic[] = [
  {
    id: 'LINTANG',
    name: 'Klinik Kesihatan Lintang',
    shortName: 'KK Lintang',
    active: true,
    isFundusProvider: true,
    colorKey: 'blue',
  },
  {
    id: 'PDG_RENGAS',
    name: 'Klinik Kesihatan Padang Rengas',
    shortName: 'KK Padang Rengas',
    active: true,
    isFundusProvider: true,
    colorKey: 'purple',
  },
  {
    id: 'HSS',
    name: 'Hospital Sungai Siput',
    shortName: 'HSS',
    active: true,
    isFundusProvider: false,
    colorKey: 'orange',
  },
  {
    id: 'PBOA',
    name: 'Pasukan Bergerak Orang Asli',
    shortName: 'PBOA',
    active: true,
    isFundusProvider: false,
    colorKey: 'green',
  },
];

//--- User access roles ---//
enum UserRole {
  SUPER_ADMIN = 'SUPER_ADMIN',
  ADMIN = 'ADMIN',
  STAFF = 'STAFF'
}

//---Legacy department type is retained only so old Firestore records remain readable during migration---//
type Department = string;

//---Map the old PBOA/HSS department labels to their new standalone clinic identities---//
const inferClinicIdFromLegacy = (clinicId?: string | null, legacyDepartment?: string | null) => {
  if (legacyDepartment === 'PBOA') return 'PBOA';
  if (legacyDepartment === 'HSS') return 'HSS';
  if (legacyDepartment === 'OPD KKL') return 'LINTANG';
  return clinicId || 'LINTANG';
};

//--- Resolve the patient's referring/source clinic for dashboard breakdowns. ---//
// New records use referringClinicId; legacy records fall back to department.
const getReferringClinicId = (app: Partial<Appointment>) => {
  if (app.referringClinicId) return app.referringClinicId;
  if (app.department === 'PBOA') return 'PBOA';
  if (app.department === 'HSS') return 'HSS';
  if (app.department === 'OPD KKL') return 'LINTANG';
  return app.clinicId || 'LINTANG';
};

//--- Monthly PDF reports use the full clinic master name for every source clinic. ---//
const getSourceDisplayName = (clinic: Clinic) =>
  clinic.name || clinic.shortName || clinic.id;

//---Convert old appointment records into the new standalone-clinic context without deleting legacy fields---//
const normalizeAppointmentClinic = (data: Partial<Appointment>) => ({
  ...data,
  clinicId: inferClinicIdFromLegacy(data.clinicId, data.department),
});

//---Convert old user records into standalone clinic identities during the read phase---//
const normalizeUserClinic = (data: Partial<User>) => ({
  ...data,
  clinicId: inferClinicIdFromLegacy(data.clinicId, data.department),
});

const getClinicById = (clinics: Clinic[], clinicId?: string | null) =>
  clinics.find(clinic => clinic.id === clinicId) || null;

//--- SINAR clinic color system ---//
// Persistent clinic colors are stored in the Clinic Master (`colorKey`).
// Super Admin can change a clinic color without affecting other clinics.
const CLINIC_COLORS = [
  { key: 'blue', label: 'Blue', badge: 'bg-blue-50 text-blue-700 border-blue-200', border: 'border-l-blue-500', dot: 'bg-blue-500' },
  { key: 'purple', label: 'Purple', badge: 'bg-purple-50 text-purple-700 border-purple-200', border: 'border-l-purple-500', dot: 'bg-purple-500' },
  { key: 'green', label: 'Green', badge: 'bg-green-50 text-green-700 border-green-200', border: 'border-l-green-500', dot: 'bg-green-500' },
  { key: 'orange', label: 'Orange', badge: 'bg-orange-50 text-orange-700 border-orange-200', border: 'border-l-orange-500', dot: 'bg-orange-500' },
  { key: 'pink', label: 'Pink', badge: 'bg-pink-50 text-pink-700 border-pink-200', border: 'border-l-pink-500', dot: 'bg-pink-500' },
  { key: 'yellow', label: 'Yellow', badge: 'bg-yellow-50 text-yellow-700 border-yellow-200', border: 'border-l-yellow-500', dot: 'bg-yellow-500' },
  { key: 'cyan', label: 'Cyan', badge: 'bg-cyan-50 text-cyan-700 border-cyan-200', border: 'border-l-cyan-500', dot: 'bg-cyan-500' },
  { key: 'red', label: 'Red', badge: 'bg-red-50 text-red-700 border-red-200', border: 'border-l-red-500', dot: 'bg-red-500' },
  { key: 'indigo', label: 'Indigo', badge: 'bg-indigo-50 text-indigo-700 border-indigo-200', border: 'border-l-indigo-500', dot: 'bg-indigo-500' },
  { key: 'teal', label: 'Teal', badge: 'bg-teal-50 text-teal-700 border-teal-200', border: 'border-l-teal-500', dot: 'bg-teal-500' },
] as const;

type ClinicColorKey = typeof CLINIC_COLORS[number]['key'];

const getClinicColor = (clinic?: Clinic | null) => {
  if (!clinic) return CLINIC_COLORS[0];

  const configured = CLINIC_COLORS.find(color => color.key === clinic.colorKey);
  if (configured) return configured;

  //--- Backward-compatible defaults for existing clinic documents without colorKey ---//
  const legacyDefaults: Record<string, ClinicColorKey> = {
    LINTANG: 'blue',
    PDG_RENGAS: 'purple',
    PBOA: 'green',
    HSS: 'orange',
  };

  return CLINIC_COLORS.find(color => color.key === legacyDefaults[clinic.id]) || CLINIC_COLORS[0];
};

const getClinicBadgeClass = (
  clinics: Clinic[],
  clinicId?: string | null,
  activeClinicId?: string | null
) => {
  const clinic = clinics.find(item => item.id === clinicId);
  return getClinicColor(clinic).badge;
};

const getClinicBorderClass = (
  clinics: Clinic[],
  clinicId?: string | null,
  activeClinicId?: string | null
) => {
  const clinic = clinics.find(item => item.id === clinicId);
  return getClinicColor(clinic).border;
};

const getFundusProviderClinics = (clinics: Clinic[]) =>
  clinics.filter(clinic => clinic.active && clinic.isFundusProvider);

interface User {
  id: string;
  firestoreId?: string;
  email?: string;
  password?: string;
  role: UserRole;

  //---Clinic identity: every non-super-admin account belongs to one clinic---//
  clinicId: string | null;

  displayName: string;

  //--- Legacy department field retained temporarily for backward compatibility only ---//
  department?: string;

  createdAt: number;
}

enum AppointmentStatus {
  PENDING = 'Pending',
  DONE_FUNDUS = 'Done Fundus',
  DONE_REVIEW = 'Done Review',
  DONE = 'Done',
  NO_SHOW = 'No Show'
}

/* =========================
   Image Status Type
========================= */
type ImageStatus =
  | "Pending"
  | "Captured"
  | "Not Obtainable";

  interface AIPrediction {
    label: string;
    confidence: number;
    description: string;
  }

  interface AIResult {
    success: boolean;
    filename: string;
    analysis_time: string;
    predictions: AIPrediction[];
  }

  interface Appointment {
  id: string;
  firestoreId?: string;

  //---Clinic tenant owning this clinical record---//
  clinicId: string;

  patientName: string;

  //--- Legacy department field retained temporarily for backward compatibility only ---//
  department?: string;

  //--- Source/referring facility. This replaces the old department-as-facility concept. ---//
  referringClinicId?: string;

  //--- Facility where the fundus examination is actually performed. ---//
  fundusProviderClinicId?: string;

  icNumber: string;
  phoneNumber: string;
  date: string;
  remarks: string;

  //--- Optional visual acuity recorded during appointment creation ---//
  rightEyeVAUnaided?: string;
  leftEyeVAUnaided?: string;
  rightEyeVAWithGlasses?: string;
  leftEyeVAWithGlasses?: string;
  rightEyeVAPinhole?: string;
  leftEyeVAPinhole?: string;

  // =========================
  // Fundus Images
  // =========================
  rightEyePhoto?: string;
  rightEyePhotoPublicId?: string;

  leftEyePhoto?: string;
  leftEyePhotoPublicId?: string;

  // =========================
  // Image Capture Status
  // =========================
  rightEyeImageStatus?: ImageStatus;
  leftEyeImageStatus?: ImageStatus;

  rightEyeImageReason?: string;
  leftEyeImageReason?: string;

  imageStatusUpdatedBy?: string;
  imageStatusUpdatedAt?: number;

  // =========================
  // AI Analysis
  // =========================

  rightEyeAIResult?: AIResult;

  leftEyeAIResult?: AIResult;

  // =========================
  // Clinical Review
  // =========================
  
  rightEyeReview?: string;
  rightEyeReviewDetails?: {
    status: 'Normal' | 'Abnormal' | 'Ungradable' | '';
    abnormalTypes?: string[];
    npdrSeverity?: 'mild' | 'moderate' | 'severe' | '';
    othersText?: string;
    comment?: string;
  };

  leftEyeReview?: string;
  leftEyeReviewDetails?: {
    status: 'Normal' | 'Abnormal' | 'Ungradable' | '';
    abnormalTypes?: string[];
    npdrSeverity?: 'mild' | 'moderate' | 'severe' | '';
    othersText?: string;
    comment?: string;
  };

  status: AppointmentStatus;
  diseaseTypes: string[];
  otherDisease: string;

  referred?: boolean;
  referralComment?: string;
  referralSent?: boolean;
  specialistClinicId?: string;
  specialistClinicName?: string;
  referralSentAt?: number;

  createdBy: string;
  rightEyeUploadedBy?: string;
  leftEyeUploadedBy?: string;
  rightEyePhotoUploadedAt?: number;
  leftEyePhotoUploadedAt?: number;

  updatedBy: string;
  createdAt: number;
}

interface ActivityLog {
  //---Clinic identity is attached to audit events for future tenant isolation---//
  clinicId?: string | null;
  action: string;
  patient: string;
  by: string;
  timestamp: number;
}

interface MigrationStats {
  appointmentsTotal: number;
  appointmentsWithClinicId: number;
  appointmentsNeedsClinicMigration: number;
  appointmentsNeedsReferralMigration: number;
  appointmentsMissingProvider: number;
  missingProviderByLegacyDepartment: Record<string, number>;
  usersTotal: number;
  usersWithClinicId: number;
  usersNeedsClinicMigration: number;
}

const STORAGE_KEY = 'fundus_appointments';
const USERS_KEY = 'fundus_users';
const ACTIVITY_LOGS_KEY = 'fundus_activity_logs';
const DISEASE_OPTIONS = ['DM', 'HTN', 'LIPID', 'CKD'];
const PBOA_LIMIT = 10;

// --- Helper Components ---

const StatusBadge = ({ status }: { status: AppointmentStatus }) => {
  const configs = {
    [AppointmentStatus.PENDING]: "bg-slate-100 text-slate-700 border-slate-200",
    [AppointmentStatus.DONE_FUNDUS]: "bg-blue-100 text-blue-700 border-blue-200",
    [AppointmentStatus.DONE_REVIEW]: "bg-indigo-100 text-indigo-700 border-indigo-200",
    [AppointmentStatus.DONE]: "bg-emerald-100 text-emerald-700 border-emerald-200",
    [AppointmentStatus.NO_SHOW]: "bg-rose-100 text-rose-700 border-rose-200",
  };

  return (
    <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium border ${configs[status]}`}>
      {status}
    </span>
  );
};

const formatIC = (value: string) => {
  const digits = value.replace(/\D/g, "").slice(0, 12);

  if (digits.length <= 6) return digits;
  if (digits.length <= 8)
    return `${digits.slice(0, 6)}-${digits.slice(6)}`;

  return `${digits.slice(0, 6)}-${digits.slice(6, 8)}-${digits.slice(8)}`;
};

const normalizeIC = (ic: string) => ic.replace(/\D/g, "");

const isCurrentYear = (date: string) => {
  return new Date(date).getFullYear() === new Date().getFullYear();
};

const formatDisplayDate = (date: string) => {
  const d = new Date(date);

  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
};

// --- Main Application ---

export default function App() {
  //--- Read-only V/A summary reused in clinical review and visit-history views ---//
  const renderVisualAcuity = (record: any) => {
    if (!record) return null;
    const rows = [
      { label: 'Unaided', right: record.rightEyeVAUnaided, left: record.leftEyeVAUnaided },
      { label: 'With Glasses', right: record.rightEyeVAWithGlasses, left: record.leftEyeVAWithGlasses },
      { label: 'Pinhole', right: record.rightEyeVAPinhole, left: record.leftEyeVAPinhole },
    ].filter(row => String(row.right || '').trim() || String(row.left || '').trim());

    if (rows.length === 0) return null;

    return (
      <div className="bg-white rounded-xl border border-slate-200 p-3 mb-4">
        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-3">Visual Acuity (V/A)</p>
        <div className="grid grid-cols-[minmax(0,1fr)_64px_64px] gap-x-2 gap-y-2 items-center">
          <span />
          <span className="text-[9px] font-black uppercase text-slate-400 text-center">RE</span>
          <span className="text-[9px] font-black uppercase text-slate-400 text-center">LE</span>
          {rows.map(row => (
            <React.Fragment key={row.label}>
              <span className="text-xs font-medium text-slate-600">{row.label}</span>
              <span className="rounded-lg bg-slate-50 border border-slate-100 px-2 py-1.5 text-xs font-bold text-slate-700 text-center">{row.right || '-'}</span>
              <span className="rounded-lg bg-slate-50 border border-slate-100 px-2 py-1.5 text-xs font-bold text-slate-700 text-center">{row.left || '-'}</span>
            </React.Fragment>
          ))}
        </div>
      </div>
    );
  };
  const [currentUser, setCurrentUser] = useState<User | null>(() => {
    const saved = sessionStorage.getItem('clinic_current_user');
    if (!saved) return null;
    try {
      const parsedUser = JSON.parse(saved) as User;
      return normalizeUserClinic(parsedUser) as User;
    } catch (e) {
      console.error("Failed to parse current user", e);
      return null;
    }
  });
  // Separate specialist portal session; kept isolated from standard clinic accounts.
  const [specialistCurrentUser, setSpecialistCurrentUser] = useState<SpecialistUser | null>(() => {
    const saved = sessionStorage.getItem('specialist_current_user');
    if (!saved) return null;
    try { return JSON.parse(saved) as SpecialistUser; }
    catch (e) { console.error('Failed to parse specialist user session', e); return null; }
  });
  const [showSpecialistStaffManagement, setShowSpecialistStaffManagement] = useState(false);
  const [showSpecialistStaffForm, setShowSpecialistStaffForm] = useState(false);
  const [editingSpecialistStaffId, setEditingSpecialistStaffId] = useState<string | null>(null);
  const [specialistStaffIdInput, setSpecialistStaffIdInput] = useState('');
  const [specialistStaffNameInput, setSpecialistStaffNameInput] = useState('');
  const [specialistStaffPasswordInput, setSpecialistStaffPasswordInput] = useState('');
  const [showSpecialistStaffPassword, setShowSpecialistStaffPassword] = useState(false);
  const [specialistStaffSaving, setSpecialistStaffSaving] = useState(false);
  const [specialistReferralSearch, setSpecialistReferralSearch] = useState('');
  const [specialistReferralPageNumber, setSpecialistReferralPageNumber] = useState(1);
  const [showSpecialistActivityLogs, setShowSpecialistActivityLogs] = useState(false);
  const [specialistComingSoonFeature, setSpecialistComingSoonFeature] = useState<string | null>(null);
  const [specialistReferrals, setSpecialistReferrals] = useState<Array<Record<string, any> & { id: string }>>([]);
  // Specialist-only referral review workspace. This state is isolated from clinic review forms.
  const [selectedSpecialistReferral, setSelectedSpecialistReferral] = useState<(Record<string, any> & { id: string }) | null>(null);
  const [specialistReferralPage, setSpecialistReferralPage] = useState<1 | 2>(1);
  const [specialistReferralSection6, setSpecialistReferralSection6] = useState<Record<string, string>>({});
  const [specialistReferralSaving, setSpecialistReferralSaving] = useState(false);
  const [specialistZoomImage, setSpecialistZoomImage] = useState<string | null>(null);
  const [specialistZoomEye, setSpecialistZoomEye] = useState('');
  const [specialistImageZoom, setSpecialistImageZoom] = useState(1);
  const specialistPinchStartDistanceRef = useRef<number | null>(null);
  const specialistPinchStartZoomRef = useRef(1);
  const specialistPanStartRef = useRef<{ pointerId: number; x: number; y: number; originX: number; originY: number } | null>(null);
  const [specialistImagePan, setSpecialistImagePan] = useState({ x: 0, y: 0 });
  const [specialistAnalyticsMonth, setSpecialistAnalyticsMonth] = useState(new Date());

  // Freeze the page behind specialist dialogs while keeping the dialog's own content scrollable.
  useEffect(() => {
    const shouldLock = Boolean(selectedSpecialistReferral || specialistZoomImage || specialistComingSoonFeature);
    if (!shouldLock) return;
    const html = document.documentElement;
    const body = document.body;
    const previousHtmlOverflow = html.style.overflow;
    const previousBodyOverflow = body.style.overflow;
    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    return () => {
      html.style.overflow = previousHtmlOverflow;
      body.style.overflow = previousBodyOverflow;
    };
  }, [selectedSpecialistReferral, specialistZoomImage, specialistComingSoonFeature]);
  const [users, setUsers] = useState<User[]>([]);

  //---Clinic master is loaded from Firestore; defaults keep the existing app usable during migration---//
  const [clinics, setClinics] = useState<Clinic[]>(DEFAULT_CLINICS);

  //---Super Admin can open a management context without changing another user's clinic identity---//
  const [superAdminClinicContext, setSuperAdminClinicContext] = useState<string | null>(null);

  const currentClinic = getClinicById(
    clinics,
    currentUser?.clinicId
  );

  const fundusProviderClinics = useMemo(
    () => getFundusProviderClinics(clinics),
    [clinics]
  );

  //---Standalone clinic summary groups replace the old department-based dashboard groups---//
  const availableDepartments = useMemo(() => {
    const scopedClinics =
      currentUser?.role === UserRole.SUPER_ADMIN
        ? (superAdminClinicContext
            ? clinics.filter(c => c.id === superAdminClinicContext)
            : clinics.filter(c => c.active))
        : clinics.filter(c => c.id === (currentUser?.clinicId || 'LINTANG') && c.active);

    return scopedClinics.map(clinic => ({
      id: clinic.id,
      clinicId: clinic.id,
      label: clinic.name,
      shortName: clinic.shortName,
    }));
  }, [clinics, currentUser?.clinicId, currentUser?.role, superAdminClinicContext]);

  const defaultDepartment = currentUser?.department || '';
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [authMessage, setAuthMessage] = useState('');
  const [tempUserId, setTempUserId] = useState('');
  const [tempPassword, setTempPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [showStaffForm, setShowStaffForm] = useState(false);
  
  const [showAdminConsole, setShowAdminConsole] = useState(false);
  const [newStaffId, setNewStaffId] = useState('');
  const [newStaffName, setNewStaffName] = useState('');
  const [newStaffPass, setNewStaffPass] = useState('');
  const [showStaffPassword, setShowStaffPassword] = useState(false);
  const [newStaffRole, setNewStaffRole] = useState<UserRole>(UserRole.STAFF);
  const [newStaffClinicId, setNewStaffClinicId] = useState('LINTANG');
  const [activityLogs, setActivityLogs] = useState<ActivityLog[]>([]);
  const [activityLogSearch, setActivityLogSearch] = useState('');
  const [activityLogActionFilter, setActivityLogActionFilter] = useState('ALL');
  const [activityLogClinicFilter, setActivityLogClinicFilter] = useState('ALL');
  const [superAdminSidebarCollapsed, setSuperAdminSidebarCollapsed] = useState(false);
  const [activeSuperAdminView, setActiveSuperAdminView] = useState<'dashboard' | 'clinics' | 'users' | 'fundus' | 'analytics' | 'logs' | 'settings' | 'specialistClinics' | 'specialistUsers' | 'migration'>('dashboard');
  const [specialistClinics, setSpecialistClinics] = useState<SpecialistClinic[]>([]);
  const [specialistUsers, setSpecialistUsers] = useState<SpecialistUser[]>([]);
  const [specialistClinicSearch, setSpecialistClinicSearch] = useState('');
  const [specialistUserSearch, setSpecialistUserSearch] = useState('');
  const [specialistUserClinicFilter, setSpecialistUserClinicFilter] = useState('ALL');
  const [specialistUserRoleFilter, setSpecialistUserRoleFilter] = useState('ALL');
  const [selectedSpecialistUsersClinic, setSelectedSpecialistUsersClinic] = useState<string | null>(null);
  const [showSpecialistClinicForm, setShowSpecialistClinicForm] = useState(false);
  const [editingSpecialistClinicId, setEditingSpecialistClinicId] = useState<string | null>(null);
  const [specialistClinicIdInput, setSpecialistClinicIdInput] = useState('');
  const [specialistClinicNameInput, setSpecialistClinicNameInput] = useState('');
  const [specialistClinicShortNameInput, setSpecialistClinicShortNameInput] = useState('');
  const [specialistClinicAddressInput, setSpecialistClinicAddressInput] = useState('');
  const [specialistClinicPhoneInput, setSpecialistClinicPhoneInput] = useState('');
  const [showSpecialistUserForm, setShowSpecialistUserForm] = useState(false);
  const [editingSpecialistUserId, setEditingSpecialistUserId] = useState<string | null>(null);
  const [specialistUserIdInput, setSpecialistUserIdInput] = useState('');
  const [specialistUserNameInput, setSpecialistUserNameInput] = useState('');
  const [specialistUserPasswordInput, setSpecialistUserPasswordInput] = useState('');
  const [specialistUserClinicInput, setSpecialistUserClinicInput] = useState('');
  const [specialistUserRoleInput, setSpecialistUserRoleInput] = useState<'ADMIN' | 'STAFF'>('STAFF');
  const [specialistSaving, setSpecialistSaving] = useState(false);
  const [superAdminUserSearch, setSuperAdminUserSearch] = useState('');
  const [superAdminUserClinicFilter, setSuperAdminUserClinicFilter] = useState('ALL');
  const [superAdminUserRoleFilter, setSuperAdminUserRoleFilter] = useState('ALL');
  const [selectedSuperAdminUsersClinic, setSelectedSuperAdminUsersClinic] = useState<string | null>(null);
  

  //---Super Admin clinic-management form---//
  const [showSuperAdminConsole, setShowSuperAdminConsole] = useState(false);
  const [showClinicManager, setShowClinicManager] = useState(false);
  const [showNewClinicForm, setShowNewClinicForm] = useState(false);
  const [clinicStatusSaving, setClinicStatusSaving] = useState<string | null>(null);
  const [clinicProviderSaving, setClinicProviderSaving] = useState<string | null>(null);
  const [newClinicId, setNewClinicId] = useState('');
  const [newClinicName, setNewClinicName] = useState('');
  const [newClinicShortName, setNewClinicShortName] = useState('');
  const [newClinicAddress, setNewClinicAddress] = useState('');
  const [newClinicPhone, setNewClinicPhone] = useState('');
  const [editingClinicAddressId, setEditingClinicAddressId] = useState<string | null>(null);
  const [clinicAddressDraft, setClinicAddressDraft] = useState('');
  const [clinicPhoneDraft, setClinicPhoneDraft] = useState('');
  const [clinicAddressSaving, setClinicAddressSaving] = useState<string | null>(null);
  const [newClinicIsFundusProvider, setNewClinicIsFundusProvider] = useState(false);
  //--- Super Admin clinic color assignment ---//
  const [newClinicColorKey, setNewClinicColorKey] = useState<ClinicColorKey>('pink');
  const [clinicColorSaving, setClinicColorSaving] = useState<string | null>(null);

  //--- Super Admin Fundus Network ---//
  const [showFundusNetwork, setShowFundusNetwork] = useState(false);
  //--- Clinic Admin referral TCA schedule ---//
  const [showReferralClinicManager, setShowReferralClinicManager] = useState(false);
  const [referralTcaDraft, setReferralTcaDraft] = useState<Record<string, number[]>>({});
  const [referralTcaSaving, setReferralTcaSaving] = useState(false);
  //--- Super Admin Data & Migration ---//
  const [showDataMigration, setShowDataMigration] = useState(false);
  const [migrationStats, setMigrationStats] = useState<MigrationStats | null>(null);
  const [migrationScanning, setMigrationScanning] = useState(false);
  const [migrationRunning, setMigrationRunning] = useState(false);
  //--- Clinic Master Sync: only create missing default clinic documents; never overwrite existing clinics ---//
  const [clinicMasterSyncRunning, setClinicMasterSyncRunning] = useState(false);
  const [clinicMasterSyncMessage, setClinicMasterSyncMessage] = useState('');
  //---Selected historical provider for each legacy source clinic---//
  const [migrationProviderByLegacyDepartment, setMigrationProviderByLegacyDepartment] = useState<Record<string, string>>({
    'OPD KKL': 'LINTANG',
    'PBOA': '',
    'HSS': '',
  });
  const [migrationMessage, setMigrationMessage] = useState('');
  //--- Each provider/routing action gets its own saving key ---//
  const [fundusNetworkSaving, setFundusNetworkSaving] = useState<string | null>(null);

  //--- Pending referral routing writes prevent stale realtime snapshots from undoing recent clicks ---//
  const pendingFundusRoutingRef = useRef<Record<string, string[]>>({});

  //--- Pending provider ON/OFF writes prevent realtime snapshots from undoing recent clicks ---//
  const pendingFundusProviderRef = useRef<Record<string, boolean>>({});

  //--- Keep the latest clinic state available to queued Fundus Routing writes ---//
  const clinicsRef = useRef<Clinic[]>(DEFAULT_CLINICS);
  clinicsRef.current = clinics;

  //--- Serialize routing writes per referral clinic so rapid checkbox clicks cannot overwrite each other ---//
  const fundusRoutingWriteQueueRef = useRef<Record<string, Promise<void>>>({});

  const [showAccountSettings, setShowAccountSettings] = useState(false);
  const [currentPasswordInput, setCurrentPasswordInput] = useState('');
  const [newPasswordInput, setNewPasswordInput] = useState('');
  const [confirmPasswordInput, setConfirmPasswordInput] = useState('');
  const [newDisplayName, setNewDisplayName] = useState(currentUser?.displayName || '');

  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [showAccountSuccess, setShowAccountSuccess] = useState(false);
  const [showPboaWarning, setShowPboaWarning] =useState(false);
  const [showActivityLogs, setShowActivityLogs] = useState(false);
  const [showMonthlySummary, setShowMonthlySummary] = useState(false);
  
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [userToDelete, setUserToDelete] = useState<User | null>(null);
  
  const [selectedAnalyticsMonth, setSelectedAnalyticsMonth] = useState(new Date());
  //--- Selected clinic for Super Admin monthly clinical detail ---//
  const [selectedSuperAdminClinicId, setSelectedSuperAdminClinicId] = useState<string | null>(null);
  const [showSuperAdminClinicDetail, setShowSuperAdminClinicDetail] = useState(false);
  const [showTCASchedule, setShowTCASchedule] = useState(false);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [selectedPhotoApp, setSelectedPhotoApp] = useState<{app: Appointment, eye: 'right' | 'left'} | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [formIC, setFormIC] = useState('');
  const [formPhone, setFormPhone] = useState('');
  //---Legacy formDepartment state is retained only for old appointment records; new UI uses clinic/referral fields---//
  const [formDepartment, setFormDepartment] = useState<Department>('');
  const [formReferringClinicId, setFormReferringClinicId] = useState('');
  const [formFundusProviderClinicId, setFormFundusProviderClinicId] = useState('');
  const [editingAppointment, setEditingAppointment] = useState<Appointment | null>(null);
  //---Default fundus provider follows the current clinic configuration---//
  useEffect(() => {
    if (!isFormOpen || editingAppointment) return;

    if (currentClinic?.isFundusProvider) {
      setFormReferringClinicId(currentClinic.id);
      setFormFundusProviderClinicId(currentClinic.id);
      return;
    }

    const defaultProvider =
      fundusProviderClinics.find(clinic => clinic.id === 'LINTANG') ||
      fundusProviderClinics[0];

    setFormReferringClinicId(currentClinic?.id || '');
    setFormFundusProviderClinicId(defaultProvider?.id || '');
  }, [isFormOpen, editingAppointment, currentClinic?.id, currentClinic?.isFundusProvider, fundusProviderClinics]);
  //--- Keep the referring clinic inside the allowed source list for the current environment ---//
  useEffect(() => {
    if (!isFormOpen || !currentClinic) return;

    if (!currentClinic.isFundusProvider) {
      if (formReferringClinicId !== currentClinic.id) {
        setFormReferringClinicId(currentClinic.id);
      }
      return;
    }

    //--- Provider environment: own clinic is always allowed; external clinics must route to this provider ---//
    const allowedReferringClinicIds = clinics
      .filter(clinic => {
        if (!clinic.active) return false;
        if (clinic.id === currentClinic.id) return true;
        return (clinic.fundusProviderClinicIds || []).includes(currentClinic.id);
      })
      .map(clinic => clinic.id);

    if (!allowedReferringClinicIds.includes(formReferringClinicId)) {
      setFormReferringClinicId(currentClinic.id);
    }
  }, [
    isFormOpen,
    currentClinic?.id,
    currentClinic?.isFundusProvider,
    formReferringClinicId,
    clinics
  ]);

  const [selectedDate, setSelectedDate] = useState('');
  const [deletingApp, setDeletingApp] = useState<Appointment | null>(null);
  const [isDeletingAppointment, setIsDeletingAppointment] = useState(false);
  const [zoomScale, setZoomScale] = useState(1);
  const [uploadingImageId, setUploadingImageId] = useState<string | null>(null);
  const [isSavingReview, setIsSavingReview] = useState(false);
  const [isSavingAppointment, setIsSavingAppointment] = useState(false);
  const [isSavingStaff, setIsSavingStaff] = useState(false);
  const [isSavingAccount, setIsSavingAccount] = useState(false);
  const [isSavingImageStatus, setIsSavingImageStatus] = useState(false);
  const [isAddingClinic, setIsAddingClinic] = useState(false);
  const [isReferred, setIsReferred] = useState(false);
  const [referralComment, setReferralComment] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isReviewViewMode, setIsReviewViewMode] = useState(false);

  const [rightEyeAIResult, setRightEyeAIResult] = useState<AIResult | null>(null);
  const [leftEyeAIResult, setLeftEyeAIResult] = useState<AIResult | null>(null);
  const [showAIResult, setShowAIResult] = useState(true);
  const [isAIPanelOpen, setIsAIPanelOpen] = useState(false);
  const [expandedPrediction, setExpandedPrediction] = useState<number | null>(0);
  
  const [selectedHistory, setSelectedHistory] = useState<Appointment | null>(null);
  const [showPatientHistory, setShowPatientHistory] = useState(false);
  const [summaryEye, setSummaryEye] = useState<'right' | 'left'>('right');
  const [selectedReviewSummary, setSelectedReviewSummary] = useState<any>(null);
  //--- Referral/report fields are persisted with the appointment and copied to the specialist referral ---//
  const [printReportApp, setPrintReportApp] = useState<Appointment | null>(null);
  const [printReportFields, setPrintReportFields] = useState<Record<string, string>>({});
  const [reportActionMode, setReportActionMode] = useState<'print' | 'refer'>('print');
  const [showReferralClinicPicker, setShowReferralClinicPicker] = useState(false);
  const [selectedReferralClinicId, setSelectedReferralClinicId] = useState('');
  const [isSendingReferral, setIsSendingReferral] = useState(false);
  const [isGeneratingPatientReport, setIsGeneratingPatientReport] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoveredReviewId, setHoveredReviewId] = useState<string | null>(null);

  const [isICLookupOpen, setIsICLookupOpen] = useState(false);
  const [lookupIC, setLookupIC] = useState("");
  const [existingPatient, setExistingPatient] = useState<Appointment | null>(null);
  const [duplicatePatient, setDuplicatePatient] = useState<Appointment | null>(null);
  const [showDuplicateWarning, setShowDuplicateWarning] = useState(false);

  //--- Show only the V/A examination types selected by the user or already recorded ---//
  const [visibleVAMethods, setVisibleVAMethods] = useState<string[]>([]);
  const [vaMethodToAdd, setVaMethodToAdd] = useState('');

  useEffect(() => {
    if (!isFormOpen) return;
    const record = editingAppointment || existingPatient;
    const methods = [
      { key: 'Unaided', right: record?.rightEyeVAUnaided, left: record?.leftEyeVAUnaided },
      { key: 'With Glasses', right: record?.rightEyeVAWithGlasses, left: record?.leftEyeVAWithGlasses },
      { key: 'Pinhole', right: record?.rightEyeVAPinhole, left: record?.leftEyeVAPinhole },
    ];
    setVisibleVAMethods(methods.filter(method => method.right || method.left).map(method => method.key));
    setVaMethodToAdd('');
  }, [isFormOpen, editingAppointment, existingPatient]);


  const [showImageNotObtainable, setShowImageNotObtainable] = useState(false);
const [selectedUnableApp, setSelectedUnableApp] =
  useState<Appointment | null>(null);

const [unableEye, setUnableEye] = useState<
  "right" | "left" | "both"
>("right");

const [unableReason, setUnableReason] = useState(
  "Dense Cataract"
);
const [unableOtherReason, setUnableOtherReason] =
  useState("");

  const [rightEyeDetails, setRightEyeDetails] = useState<Appointment['rightEyeReviewDetails']>({
    status: '',
    abnormalTypes: [],
    npdrSeverity: '',
    othersText: '',
    comment: ''
  });
  
  const [leftEyeDetails, setLeftEyeDetails] = useState<Appointment['leftEyeReviewDetails']>({
    status: '',
    abnormalTypes: [],
    npdrSeverity: '',
    othersText: '',
    comment: ''
  });
  //--- Mobile back button: close the active SINAR modal without leaving the app ---//
  const modalHistoryCountRef = useRef(0);
  const suppressModalHistoryCleanupRef = useRef(false);

  //--- Keep this list limited to the existing modal states; no UI/layout/function is changed here ---//
  const activeModalCount = [
    showPboaWarning,
    showTCASchedule,
    showAdminConsole,
    showActivityLogs,
    showMonthlySummary,
    showSuperAdminConsole,
    showClinicManager,
    showFundusNetwork,
    showReferralClinicManager,
    showDataMigration,
    showAccountSettings,
    showSuperAdminClinicDetail,
    isFormOpen,
    isICLookupOpen,
    !!selectedPhotoApp,
    !!selectedHistory,
    !!selectedReviewSummary,
    !!deletingApp,
    !!userToDelete,
    showDuplicateWarning,
    showImageNotObtainable,
    !!printReportApp,
    showReferralClinicPicker
  ].filter(Boolean).length;

  useEffect(() => {
    //--- Modal opened: add one temporary history entry ---//
    if (activeModalCount > modalHistoryCountRef.current) {
      const entriesToAdd = activeModalCount - modalHistoryCountRef.current;
      for (let i = 0; i < entriesToAdd; i++) {
        window.history.pushState({ sinarModal: true }, '', window.location.href);
      }
      modalHistoryCountRef.current = activeModalCount;
      return;
    }

    //--- Modal closed by the normal UI: remove only our temporary history entry ---//
    if (activeModalCount < modalHistoryCountRef.current) {
      const entriesToRemove = modalHistoryCountRef.current - activeModalCount;
      modalHistoryCountRef.current = activeModalCount;

      //--- Mark UI-driven history cleanup so popstate does not close another modal ---//
      suppressModalHistoryCleanupRef.current = entriesToRemove;
      window.history.back();
    }
  }, [activeModalCount]);

  useEffect(() => {
    const handleMobileBack = () => {
      if (modalHistoryCountRef.current <= 0) return;

      //--- Normal X/Close cleanup: consume the temporary history entry without closing another modal ---//
      if (suppressModalHistoryCleanupRef.current > 0) {
        suppressModalHistoryCleanupRef.current -= 1;
        if (suppressModalHistoryCleanupRef.current > 0) {
          window.history.back();
        }
        return;
      }

      //--- Browser Back consumed one temporary modal history entry ---//
      modalHistoryCountRef.current -= 1;

      //--- Close only the currently active/top modal; existing close functions remain untouched ---//
      if (showReferralClinicPicker) {
        setShowReferralClinicPicker(false);
      } else if (printReportApp) {
        setPrintReportApp(null);
      } else if (showImageNotObtainable) {
        setShowImageNotObtainable(false);
      } else if (deletingApp) {
        setDeletingApp(null);
      } else if (userToDelete) {
        setUserToDelete(null);
      } else if (showDuplicateWarning) {
        setShowDuplicateWarning(false);
      } else if (selectedHistory) {
      setSelectedHistory(null);
      } else if (showPatientHistory) {
      setShowPatientHistory(false);
      } else if (selectedReviewSummary) {
        setSelectedReviewSummary(null);
      } else if (selectedPhotoApp) {
        setSelectedPhotoApp(null);
      } else if (isICLookupOpen) {
        setIsICLookupOpen(false);
      } else if (isFormOpen) {
        setIsFormOpen(false);
      } else if (showClinicManager) {
        setShowClinicManager(false);
      } else if (showFundusNetwork) {
        setShowFundusNetwork(false);
      } else if (showReferralClinicManager) {
        setShowReferralClinicManager(false);
      } else if (showDataMigration) {
        setShowDataMigration(false);
      } else if (showAccountSettings) {
        setShowAccountSettings(false);
      } else if (showSuperAdminClinicDetail) {
        setShowSuperAdminClinicDetail(false);
      } else if (showMonthlySummary) {
        setShowMonthlySummary(false);
      } else if (showActivityLogs) {
        setShowActivityLogs(false);
      } else if (showTCASchedule) {
        setShowTCASchedule(false);
      } else if (showPboaWarning) {
        setShowPboaWarning(false);
      } else if (showAdminConsole) {
        setShowAdminConsole(false);
        setShowStaffForm(false);
        setEditingUser(null);
        setNewStaffId('');
        setNewStaffName('');
        setNewStaffPass('');
        setShowStaffPassword(false);
        setNewStaffRole(UserRole.STAFF);
        setNewStaffClinicId(currentUser?.clinicId ?? 'LINTANG');
      } else if (showSuperAdminConsole) {
        setShowSuperAdminConsole(false);
      }
    };

    window.addEventListener('popstate', handleMobileBack);
    return () => window.removeEventListener('popstate', handleMobileBack);
  }, [
    showImageNotObtainable,
    deletingApp,
    userToDelete,
    showDuplicateWarning,
    selectedHistory,
    showPatientHistory,
    selectedReviewSummary,
    selectedPhotoApp,
    isICLookupOpen,
    isFormOpen,
    showClinicManager,
    showFundusNetwork,
    showReferralClinicManager,
    showDataMigration,
    showAccountSettings,
    showSuperAdminClinicDetail,
    showMonthlySummary,
    showActivityLogs,
    showTCASchedule,
    showPboaWarning,
    showAdminConsole,
    showSuperAdminConsole,
    showReferralClinicPicker,
    printReportApp
  ]);

  useEffect(() => {

  //--- Lock the page behind every modal so the dashboard/background never scrolls together with an open popup ---//
  const modalOpen =
    showPboaWarning ||
    showTCASchedule ||
    showAdminConsole ||
    showActivityLogs ||
    showMonthlySummary ||
    showSuperAdminConsole ||
    showClinicManager ||
    showFundusNetwork ||
    showReferralClinicManager ||
    showDataMigration ||
    showAccountSettings ||
    showSuperAdminClinicDetail ||
    isFormOpen ||
    isICLookupOpen ||
    !!selectedPhotoApp ||
    !!selectedHistory ||
    !!selectedReviewSummary ||
    !!deletingApp ||
    !!userToDelete ||
    showDuplicateWarning ||
    showImageNotObtainable ||
    !!printReportApp ||
    showReferralClinicPicker;

  if (modalOpen) {
    document.body.style.overflow = 'hidden';
  } else {
    document.body.style.overflow = 'auto';
  }

  return () => {
    document.body.style.overflow = 'auto';
  };

}, [
  showPboaWarning,
  showTCASchedule,
  showAdminConsole,
  showActivityLogs,
  showMonthlySummary,
  showSuperAdminConsole,
  showClinicManager,
  showFundusNetwork,
  showReferralClinicManager,
  showDataMigration,
  showAccountSettings,
  showSuperAdminClinicDetail,
  isFormOpen,
  isICLookupOpen,
  selectedPhotoApp,
  selectedHistory,
  selectedReviewSummary,
  deletingApp,
  userToDelete,
  showDuplicateWarning,
  showImageNotObtainable,
  printReportApp,
  showReferralClinicPicker
]);

const analyzeWithAI = async () => {

  let imageUrl = "";

  if (selectedPhotoApp?.eye === "right") {
    imageUrl = selectedPhotoApp.app.rightEyePhoto;
  } else {
    imageUrl = selectedPhotoApp?.app.leftEyePhoto;
  }

  if (!imageUrl) {
    alert("No fundus image available for AI analysis.");
    return;
  }

  setIsAnalyzing(true);

  try {

    const result = await analyzeFundus(imageUrl);
    setShowAIResult(true);
    console.log(result);
    if (selectedPhotoApp?.eye === "right") {
      setRightEyeAIResult(result);
    } else {
      setLeftEyeAIResult(result);
    }

  } catch (error) {

    console.error("AI ERROR:", error);

  } finally {

    setIsAnalyzing(false);

  }

};

// Reset AI panel bila buka patient baru
useEffect(() => {
  setIsAIPanelOpen(false);
}, [selectedPhotoApp?.app?.id]);

const currentAIResult =
  selectedPhotoApp?.eye === "right"
    ? rightEyeAIResult
    : leftEyeAIResult;

const getPredictionColor = (label: string) => {

  const value = label.toLowerCase();

  if (value === "normal") {
    return "text-emerald-400";
  }

  if (
    value.includes("media") ||
    value.includes("opacity") ||
    value.includes("ungradable")
  ) {
    return "text-amber-400";
  }

  return "text-red-400";
};

const applyAISuggestion = (prediction: any) => {

    if (!prediction) return;

    const label = prediction.label.toLowerCase();

    const updateEyeDetails = (details: any) => {

    if (selectedPhotoApp?.eye === "right") {

        setRightEyeDetails(details);

    } else {

        setLeftEyeDetails(details);

    }

};

switch (label) {

    case "normal":

        updateEyeDetails({

            status: "Normal",

            abnormalTypes: [],

            npdrSeverity: "",

            othersText: "",

            comment: ""

        });

        break;

    default:

        alert("Mapping not available yet.");

}

};

const changeAnalyticsMonth = (
  direction: number
) => {

  setSelectedAnalyticsMonth(prev => {

    const d = new Date(prev);

    d.setMonth(
      d.getMonth() + direction
    );

    return d;

  });

};

const today = new Date();

const isCurrentMonth =
  selectedAnalyticsMonth.getMonth() === today.getMonth() &&
  selectedAnalyticsMonth.getFullYear() ===
    today.getFullYear();

  //--- Previous fundus visits for the selected historical record ---//
  //--- Keep the latest record as the main view; older fundus records can be opened from the date list. ---//
  const selectedHistoryVisits = useMemo(() => {
    if (!selectedHistory) return [];

    return appointments
      .filter(app => {
        if (app.id === selectedHistory.id) return false;
        if (normalizeIC(app.icNumber) !== normalizeIC(selectedHistory.icNumber)) return false;
        if (app.status === AppointmentStatus.NO_SHOW) return false;

        //--- Only show records that contain evidence of a fundus visit. ---//
        return !!(
          app.rightEyePhoto ||
          app.leftEyePhoto ||
          app.rightEyeImageStatus ||
          app.leftEyeImageStatus ||
          app.rightEyeReview ||
          app.leftEyeReview ||
          app.rightEyeReviewDetails ||
          app.leftEyeReviewDetails
        );
      })
      .sort((a, b) => {
        const dateDiff = new Date(b.date).getTime() - new Date(a.date).getTime();
        if (dateDiff !== 0) return dateDiff;

        return (b.createdAt || 0) - (a.createdAt || 0);
      });
  }, [appointments, selectedHistory]);

  const handlePatientLookup = () => {

  const patientRecords = appointments
  .filter(
    a =>
      normalizeIC(a.icNumber) === normalizeIC(lookupIC) &&
      a.status !== AppointmentStatus.NO_SHOW
  )
  .sort(
    (a, b) =>
      new Date(b.date).getTime() -
      new Date(a.date).getTime()
  );

  const patient = patientRecords[0] || null;

  const duplicate =
  patientRecords.find(a => isCurrentYear(a.date)) || null;

  setExistingPatient(patient);

  setFormIC(formatIC(lookupIC));

  if (patient) {
    setFormPhone(patient.phoneNumber);
  } else {
    setFormPhone("");
  }

  if (duplicate) {
    setDuplicatePatient(duplicate);
    setShowDuplicateWarning(true);
    setIsICLookupOpen(false);
    return;
  }

  setIsICLookupOpen(false);
  setIsFormOpen(true);
};

  // Sync form context when opening the appointment form
  useEffect(() => {
    if (isFormOpen && editingAppointment) {
      setFormIC(editingAppointment.icNumber);
      setFormPhone(editingAppointment.phoneNumber);
      setFormReferringClinicId(
        editingAppointment.referringClinicId ||
        editingAppointment.clinicId ||
        currentUser?.clinicId ||
        'LINTANG'
      );
      setFormFundusProviderClinicId(
        editingAppointment.fundusProviderClinicId ||
        (getClinicById(clinics, editingAppointment.clinicId)?.isFundusProvider
          ? editingAppointment.clinicId
          : fundusProviderClinics.find(clinic => clinic.id === 'LINTANG')?.id || fundusProviderClinics[0]?.id || '')
      );
    } else if (isFormOpen) {
      //---New appointment: referral/provider defaults are driven by clinic configuration---//
      setFormReferringClinicId(currentUser?.clinicId || 'LINTANG');
      if (currentClinic?.isFundusProvider) {
        setFormFundusProviderClinicId(currentClinic.id);
      } else {
        setFormFundusProviderClinicId(
          fundusProviderClinics.find(clinic => clinic.id === 'LINTANG')?.id ||
          fundusProviderClinics[0]?.id ||
          ''
        );
      }
      setSelectedDate(todayStr);
    }
  }, [isFormOpen, editingAppointment, currentUser?.clinicId, currentClinic?.id, currentClinic?.isFundusProvider, clinics, fundusProviderClinics]);

  //--- Keep selected fundus provider valid against the current Fundus Network routing ---//
  useEffect(() => {
    if (!isFormOpen || !formReferringClinicId || currentClinic?.isFundusProvider) return;

    const referringClinic = clinics.find(
      clinic => clinic.id === formReferringClinicId
    );

    if (!referringClinic) {
      setFormFundusProviderClinicId('');
      return;
    }

    const allowedProviderIds = referringClinic.fundusProviderClinicIds || [];

    if (!allowedProviderIds.includes(formFundusProviderClinicId)) {
      setFormFundusProviderClinicId(allowedProviderIds[0] || '');
    }
  }, [
    isFormOpen,
    formReferringClinicId,
    formFundusProviderClinicId,
    currentClinic?.isFundusProvider,
    clinics
  ]);

  useEffect(() => {
    if (selectedPhotoApp) {
      // Only reset the review details if we are opening a DIFFERENT appointment
      // otherwise we lose unsaved changes when switching between RE and LE tabs
      if (!selectedPhotoApp || !selectedPhotoApp.app) return;
      
      setRightEyeDetails(selectedPhotoApp.app.rightEyeReviewDetails || {
        status: '',
        abnormalTypes: [],
        npdrSeverity: '',
        othersText: '',
        comment: ''
      });
      setLeftEyeDetails(selectedPhotoApp.app.leftEyeReviewDetails || {
        status: '',
        abnormalTypes: [],
        npdrSeverity: '',
        othersText: '',
        comment: ''
      });
      setZoomScale(1);

      // Reset referral state ikut patient yang sedang dibuka
      setIsReferred(selectedPhotoApp.app.referred === true);
      setReferralComment(selectedPhotoApp.app.referralComment || '');
    }
  }, [selectedPhotoApp?.app?.id]);

  const handleICChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    const cleaned = val.replace(/\D/g, '').substring(0, 12);
    let formatted = cleaned;
    if (cleaned.length > 6) {
      formatted = cleaned.substring(0, 6) + '-' + cleaned.substring(6, 8);
      if (cleaned.length > 8) {
        formatted += '-' + cleaned.substring(8);
      }
    } else {
      formatted = cleaned;
    }
    setFormIC(formatted);
  };

  const handlePhoneChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    const cleaned = val.replace(/\D/g, '').substring(0, 11);
    let formatted = cleaned;
    if (cleaned.length > 3) {
      formatted = cleaned.substring(0, 3) + '-' + cleaned.substring(3);
    }
    setFormPhone(formatted);
  };

  const getUserDisplayName = (id: string) => {
    return users.find(u => u.id === id)?.displayName || id;
  };
const isEyeCompleted = (
  review?: string,
  imageStatus?: string
) => {
  return !!review || imageStatus === "Not Obtainable";
};

const isReviewCompleted = (app: Appointment) => {
  return (
    isEyeCompleted(
      app.rightEyeReview,
      app.rightEyeImageStatus
    ) &&
    isEyeCompleted(
      app.leftEyeReview,
      app.leftEyeImageStatus
    )
  );
};

  const addActivityLog = (action: string, patient: string = 'System', byOverride?: string) => {
    const logEntry: ActivityLog = {
      //--- Super Admin activity is global; clinic users are scoped to their own clinic ---//
      clinicId: currentUser?.role === UserRole.SUPER_ADMIN
        ? 'SUPER_ADMIN'
        : (currentUser?.clinicId || ''),
      action,
      patient,
      by: byOverride || getUserDisplayName(currentUser?.id || 'SYSTEM'),
      timestamp: Date.now()
    };

    setActivityLogs(prev => [logEntry, ...prev].slice(0, 50));

    addDoc(
  collection(db, "activityLogs"),
  logEntry
)
.then(async () => {

  const logsSnapshot = await getDocs(
    query(
      collection(db, "activityLogs"),
      orderBy("timestamp", "desc")
    )
  );

  if (logsSnapshot.size > 50) {

    const logs = logsSnapshot.docs;

    for (let i = 50; i < logs.length; i++) {

      await deleteDoc(logs[i].ref);

    }

  }

})
.catch(error => {

  console.error(
    "Failed to save activity log to Firestore",
    error
  );

});
  };

  /* =====================================================
      DELETE CLINIC HANDLER
      Safe delete for Super Admin.
      - Only empty clinics can be permanently deleted.
      - Clinics with users or appointments are protected.
     ===================================================== */
  const handleDeleteClinic = async (clinic: Clinic) => {
    if (currentUser?.role !== UserRole.SUPER_ADMIN) {
      alert('Only Super Admin can delete a clinic.');
      return;
    }

    const confirmed = window.confirm(
      `Delete clinic "${clinic.name}" (${clinic.id})?\n\n` +
      `This is only allowed if the clinic has no users ` +
      `and no appointment records linked to it.`
    );

    if (!confirmed) return;

    try {
      //--- Check linked users before deleting ---//
      const usersSnapshot = await getDocs(
        query(
          collection(db, 'users'),
          where('clinicId', '==', clinic.id),
          limit(1)
        )
      );

      if (!usersSnapshot.empty) {
        alert(
          `Cannot delete ${clinic.name}.\n\n` +
          `There are still user account(s) linked to this clinic.\n` +
          `Remove or reassign those users first.`
        );
        return;
      }

      //--- Check linked appointments before deleting ---//
      const appointmentsSnapshot = await getDocs(
        query(
          collection(db, 'appointments'),
          where('clinicId', '==', clinic.id),
          limit(1)
        )
      );

      if (!appointmentsSnapshot.empty) {
        alert(
          `Cannot delete ${clinic.name}.\n\n` +
          `There are still appointment records linked to this clinic.\n` +
          `The clinic is kept to protect historical clinical data.`
        );
        return;
      }

      //--- Delete the clinic document ---//
      await deleteDoc(doc(db, 'clinics', clinic.id));

      //--- Firestore listener refreshes the clinic list automatically ---//
      addActivityLog(
        'Deleted Clinic',
        `${clinic.name} (${clinic.id})`,
        currentUser.displayName
      );

      alert(`${clinic.name} has been deleted.`);
    } catch (error) {
      console.error('Failed to delete clinic', error);
      alert(
        'Failed to delete clinic. Please check Firestore permissions/indexes and try again.'
      );
    }
  };

  // =====================================================
  // DATA & MIGRATION
  // Safe, idempotent migration of legacy clinic structure.
  // Legacy `department` is preserved; migration only fills the
  // new clinic/referral/provider fields where they are missing.
  // =====================================================
  const scanMigrationData = async () => {
    if (currentUser?.role !== UserRole.SUPER_ADMIN) {
      alert('Only Super Admin can access Data & Migration.');
      return;
    }

    setMigrationScanning(true);
    setMigrationMessage('Scanning Firestore data...');

    try {
      const [appointmentsSnapshot, usersSnapshot] = await Promise.all([
        getDocs(collection(db, 'appointments')),
        getDocs(collection(db, 'users')),
      ]);

      let appointmentsWithClinicId = 0;
      let appointmentsNeedsClinicMigration = 0;
      let appointmentsNeedsReferralMigration = 0;
      let appointmentsMissingProvider = 0;
      const missingProviderByLegacyDepartment: Record<string, number> = {};

      appointmentsSnapshot.docs.forEach(snapshot => {
        const data = snapshot.data() as Partial<Appointment>;
        const inferredClinicId = inferClinicIdFromLegacy(data.clinicId, data.department);
        const inferredReferralId = getReferringClinicId(data);

        if (data.clinicId) appointmentsWithClinicId++;
        if (!data.clinicId || data.clinicId !== inferredClinicId) {
          appointmentsNeedsClinicMigration++;
        }
        if (!data.referringClinicId || data.referringClinicId !== inferredReferralId) {
          appointmentsNeedsReferralMigration++;
        }
        if (!data.fundusProviderClinicId) {
          appointmentsMissingProvider++;

          //--- Preserve the legacy department label so Super Admin can review provider migration by source clinic ---//
          const legacyDepartment = String(data.department || '').trim();
          const breakdownKey = legacyDepartment || 'OTHER / UNKNOWN';
          missingProviderByLegacyDepartment[breakdownKey] =
            (missingProviderByLegacyDepartment[breakdownKey] || 0) + 1;
        }
      });

      let usersWithClinicId = 0;
      let usersNeedsClinicMigration = 0;

      usersSnapshot.docs.forEach(snapshot => {
        const data = snapshot.data() as Partial<User>;
        const inferredClinicId = inferClinicIdFromLegacy(data.clinicId, data.department);

        if (data.clinicId) usersWithClinicId++;
        if (!data.clinicId || data.clinicId !== inferredClinicId) {
          usersNeedsClinicMigration++;
        }
      });

      const stats: MigrationStats = {
        appointmentsTotal: appointmentsSnapshot.size,
        appointmentsWithClinicId,
        appointmentsNeedsClinicMigration,
        appointmentsNeedsReferralMigration,
        appointmentsMissingProvider,
        missingProviderByLegacyDepartment,
        usersTotal: usersSnapshot.size,
        usersWithClinicId,
        usersNeedsClinicMigration,
      };

      setMigrationStats(stats);
      setMigrationMessage('Scan complete. No data was changed.');
    } catch (error) {
      console.error('Failed to scan migration data', error);
      setMigrationMessage('Scan failed. Please check Firestore access.');
    } finally {
      setMigrationScanning(false);
    }
  };

  //--- Sync only missing default clinic master documents into Firestore ---//
  // Existing clinic documents are never overwritten or modified by this operation.
  const syncMissingClinicMaster = async () => {
    if (currentUser?.role !== UserRole.SUPER_ADMIN) {
      alert('Only Super Admin can sync the clinic master.');
      return;
    }

    const confirmed = window.confirm(
      'Sync missing clinic master?\\n\\n' +
      'Only clinic documents that do not exist in Firestore will be created.\\n' +
      'Existing clinic documents and their routing/provider/TCA settings will NOT be changed.'
    );

    if (!confirmed) return;

    setClinicMasterSyncRunning(true);
    setClinicMasterSyncMessage('Checking clinic master...');

    try {
      const snapshot = await getDocs(collection(db, 'clinics'));
      const existingIds = new Set(snapshot.docs.map(docSnapshot => docSnapshot.id));
      const missingClinics = DEFAULT_CLINICS.filter(clinic => !existingIds.has(clinic.id));

      if (missingClinics.length === 0) {
        setClinicMasterSyncMessage('Clinic master is already complete. No missing clinics found.');
        return;
      }

      for (const clinic of missingClinics) {
        await setDoc(
          doc(db, 'clinics', clinic.id),
          {
            ...clinic,
            fundusProviderClinicIds: clinic.fundusProviderClinicIds || [],
            referralTcaDays: clinic.referralTcaDays || {},
          },
          { merge: false }
        );
      }

      addActivityLog(
        'Synced Missing Clinic Master',
        `Created: ${missingClinics.map(clinic => `${clinic.shortName} (${clinic.id})`).join(', ')}`,
        currentUser.displayName
      );

      setClinicMasterSyncMessage(
        `Sync complete: ${missingClinics.length} missing clinic(s) created — ${missingClinics.map(clinic => clinic.shortName).join(', ')}.`
      );
    } catch (error) {
      console.error('Failed to sync missing clinic master', error);
      setClinicMasterSyncMessage('Clinic master sync failed. Please check Firestore access and try again.');
      alert('Failed to sync missing clinic master. Please check Firestore permissions and try again.');
    } finally {
      setClinicMasterSyncRunning(false);
    }
  };

  const migrateClinicStructure = async () => {
    if (currentUser?.role !== UserRole.SUPER_ADMIN) {
      alert('Only Super Admin can run migration.');
      return;
    }

    const confirmed = window.confirm(
      'Run clinic structure migration?\n\n' +
      'This will only fill clinicId and referringClinicId for legacy records.\n' +
      'The old department field will NOT be deleted or changed.'
    );

    if (!confirmed) return;

    setMigrationRunning(true);
    setMigrationMessage('Migrating clinic and referral fields...');

    try {
      const [appointmentsSnapshot, usersSnapshot] = await Promise.all([
        getDocs(collection(db, 'appointments')),
        getDocs(collection(db, 'users')),
      ]);

      let batch = writeBatch(db);
      let batchCount = 0;
      let changedAppointments = 0;
      let changedUsers = 0;

      const commitIfNeeded = async () => {
        if (batchCount === 0) return;
        await batch.commit();
        batch = writeBatch(db);
        batchCount = 0;
      };

      for (const snapshot of appointmentsSnapshot.docs) {
        const data = snapshot.data() as Partial<Appointment>;
        const inferredClinicId = inferClinicIdFromLegacy(data.clinicId, data.department);
        const inferredReferralId = getReferringClinicId(data);
        const patch: Record<string, string> = {};

        if (!data.clinicId || data.clinicId !== inferredClinicId) {
          patch.clinicId = inferredClinicId;
        }
        if (!data.referringClinicId || data.referringClinicId !== inferredReferralId) {
          patch.referringClinicId = inferredReferralId;
        }

        if (Object.keys(patch).length > 0) {
          batch.update(snapshot.ref, patch);
          batchCount++;
          changedAppointments++;
        }

        if (batchCount >= 450) await commitIfNeeded();
      }

      for (const snapshot of usersSnapshot.docs) {
        const data = snapshot.data() as Partial<User>;
        const inferredClinicId = inferClinicIdFromLegacy(data.clinicId, data.department);
        const patch: Record<string, string> = {};

        if (!data.clinicId || data.clinicId !== inferredClinicId) {
          patch.clinicId = inferredClinicId;
        }

        if (Object.keys(patch).length > 0) {
          batch.update(snapshot.ref, patch);
          batchCount++;
          changedUsers++;
        }

        if (batchCount >= 450) await commitIfNeeded();
      }

      await commitIfNeeded();

      addActivityLog(
        'Migrated Clinic Structure',
        `${changedAppointments} appointments / ${changedUsers} users`,
        currentUser.displayName
      );

      setMigrationMessage(
        `Migration complete: ${changedAppointments} appointment record(s) and ${changedUsers} user record(s) updated.`
      );
      await scanMigrationData();
    } catch (error) {
      console.error('Failed to migrate clinic structure', error);
      setMigrationMessage('Migration failed. No further records were processed after the error.');
    } finally {
      setMigrationRunning(false);
    }
  };

  const migrateMissingProvidersByLegacyDepartment = async (
    legacyDepartment: string,
    providerId: string
  ) => {
    if (currentUser?.role !== UserRole.SUPER_ADMIN) {
      alert('Only Super Admin can run migration.');
      return;
    }

    const normalizedDepartment = legacyDepartment.trim();
    const providerClinic = clinics.find(clinic => clinic.id === providerId);

    if (!providerClinic?.active || !providerClinic.isFundusProvider) {
      alert('Please select an active Fundus Provider clinic first.');
      return;
    }

    const pendingCount = migrationStats?.missingProviderByLegacyDepartment?.[normalizedDepartment] || 0;
    if (pendingCount <= 0) {
      alert(`No legacy ${normalizedDepartment} appointments are missing a fundus provider.`);
      return;
    }

    const confirmed = window.confirm(
      `Assign ${providerClinic.name} as the fundus provider for ${pendingCount} legacy ${normalizedDepartment} appointment(s)?\n\n` +
      'Existing provider assignments will NOT be changed.'
    );

    if (!confirmed) return;

    setMigrationRunning(true);
    setMigrationMessage(`Assigning ${providerClinic.shortName} to ${normalizedDepartment} legacy records...`);

    try {
      const appointmentsSnapshot = await getDocs(collection(db, 'appointments'));
      let batch = writeBatch(db);
      let batchCount = 0;
      let changedAppointments = 0;

      const commitIfNeeded = async () => {
        if (batchCount === 0) return;
        await batch.commit();
        batch = writeBatch(db);
        batchCount = 0;
      };

      for (const snapshot of appointmentsSnapshot.docs) {
        const data = snapshot.data() as Partial<Appointment>;
        const department = String(data.department || '').trim();

        //---Only migrate the selected legacy source and never overwrite an existing provider---//
        if (department !== normalizedDepartment) continue;
        if (data.fundusProviderClinicId) continue;

        batch.update(snapshot.ref, {
          fundusProviderClinicId: providerClinic.id,
        });
        batchCount++;
        changedAppointments++;

        if (batchCount >= 450) await commitIfNeeded();
      }

      await commitIfNeeded();

      addActivityLog(
        'Migrated Missing Fundus Provider',
        `${changedAppointments} ${normalizedDepartment} appointments → ${providerClinic.shortName}`,
        currentUser.displayName
      );

      setMigrationMessage(
        `Provider migration complete: ${changedAppointments} ${normalizedDepartment} appointment record(s) assigned to ${providerClinic.shortName}.`
      );
      await scanMigrationData();
    } catch (error) {
      console.error('Failed to migrate missing providers by legacy department', error);
      setMigrationMessage('Provider migration failed.');
    } finally {
      setMigrationRunning(false);
    }
  };

  const pinchStartDistanceRef = useRef<number | null>(null);
  const pinchStartZoomRef = useRef(1);

  //--- Mobile pinch zoom: scale the fundus image itself instead of zooming the modal/page ---//
  const getTouchDistance = (touches: React.TouchList) => {
    if (touches.length < 2) return 0;

    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const handlePinchStart = (e: React.TouchEvent<HTMLImageElement>) => {
    if (e.touches.length !== 2) return;

    pinchStartDistanceRef.current = getTouchDistance(e.touches);
    pinchStartZoomRef.current = zoomScale;
  };

  const handlePinchMove = (e: React.TouchEvent<HTMLImageElement>) => {
    if (e.touches.length !== 2 || !pinchStartDistanceRef.current) return;

    //--- Keep the browser from pinch-zooming the modal/viewport while the image is being pinched ---//
    e.preventDefault();

    const currentDistance = getTouchDistance(e.touches);
    if (!currentDistance) return;

    const nextZoom = Math.min(5, Math.max(1,
      pinchStartZoomRef.current * (currentDistance / pinchStartDistanceRef.current)
    ));

    setZoomScale(Number(nextZoom.toFixed(2)));
  };

  const handlePinchEnd = (e: React.TouchEvent<HTMLImageElement>) => {
    if (e.touches.length < 2) {
      pinchStartDistanceRef.current = null;
    }
  };

  const handleWheel = (e: React.WheelEvent) => {

  if (e.deltaY < 0) {

    setZoomScale(prev => Math.min(prev + 0.2, 5));

  } else {

    setZoomScale(prev => {

      const newScale = Math.max(prev - 0.2, 1);

      // AUTO CENTER BALIK
      if (newScale === 1) {

        const image = document.querySelector(
          '.summary-fundus-image'
        ) as HTMLElement;

        if (image) {

          image.style.transform = 'translate(0px, 0px) scale(1)';

        }

      }

      return newScale;

    });

  }

};

  // Reset zoom when switching eyes or closing
  useEffect(() => {
     setZoomScale(1);
  }, [selectedPhotoApp?.eye, !!selectedPhotoApp]);

  
  // =========================================================
  // LEGACY FUNDUS PROVIDER COMPATIBILITY
  // Old records were created before fundusProviderClinicId existed.
  // Historically, HSS/PBOA/OPD KKL referrals were performed at KK Lintang.
  // Keep those records visible to Lintang until data migration is completed.
  // New records MUST use fundusProviderClinicId.
  // =========================================================
  const isLegacyLintangProviderRecord = (app: Appointment) => {
    if (!app) return false;
    if ((app.fundusProviderClinicId || '').trim()) return false;

    const legacyClinicId = (app.clinicId || '').trim();
    const legacyDepartment = (app.department || '').trim();
    const legacyReferringClinicId = (app.referringClinicId || '').trim();

    return (
      legacyClinicId === 'LINTANG' ||
      legacyClinicId === 'PBOA' ||
      legacyClinicId === 'HSS' ||
      legacyDepartment === 'OPD KKL' ||
      legacyDepartment === 'PBOA' ||
      legacyDepartment === 'HSS' ||
      legacyReferringClinicId === 'PBOA' ||
      legacyReferringClinicId === 'HSS'
    );
  };

  // Calculate Monthly Stats
  // KK Lintang workload: include ALL referring/source departments; exclude No Show only.
  // Pending Fundus and Pending Review are intentionally non-overlapping.
  //---Clinic-scoped appointment view for UI/statistics---//
  // Legacy records without clinicId are treated as LINTANG during migration.
  const visibleAppointments = useMemo(() => {
    const activeClinicId = currentUser?.clinicId || 'LINTANG';

    return appointments.filter(app => {
      if (currentUser?.role === UserRole.SUPER_ADMIN) return true;
      return (app.clinicId || 'LINTANG') === activeClinicId;
    });
  }, [appointments, currentUser?.clinicId, currentUser?.role]);

  // =========================================================
  // FUNDUS PROVIDER WORKLOAD
  // Provider clinics must count every patient whose fundus service
  // is performed by the current clinic, including HSS/PBOA referrals.
  // Non-provider clinics continue to see their own operational cases.
  // =========================================================
  const isCurrentClinicFundusProvider = !!currentClinic?.isFundusProvider;

  const providerWorkloadAppointments = useMemo(() => {
    if (!currentUser) return [];

    if (currentUser.role === UserRole.SUPER_ADMIN) {
      return appointments;
    }

    const activeClinicId = currentUser.clinicId || 'LINTANG';

    return appointments.filter(app => {
      const ownClinic = (app.clinicId || 'LINTANG') === activeClinicId;
      const fundusHere = (app.fundusProviderClinicId || '') === activeClinicId;
      const legacyFundusHere =
        activeClinicId === 'LINTANG' &&
        isLegacyLintangProviderRecord(app);

      return isCurrentClinicFundusProvider
        ? ownClinic || fundusHere || legacyFundusHere
        : ownClinic;
    });
  }, [appointments, currentUser, isCurrentClinicFundusProvider]);

  //--- Monthly analytics only count appointments whose scheduled date has arrived.
  // Future TCA appointments remain excluded until their actual appointment date.
  const isAnalyticsDateReached = (dateValue: string | number | Date) => {
    const appointmentDate = new Date(dateValue);
    if (Number.isNaN(appointmentDate.getTime())) return false;

    const today = new Date();
    today.setHours(23, 59, 59, 999);

    return appointmentDate <= today;
  };

  const monthlyStats = useMemo(() => {
    const currentMonth = selectedAnalyticsMonth.getMonth();
    const currentYear = selectedAnalyticsMonth.getFullYear();

    const thisMonthApps = providerWorkloadAppointments.filter(app => {
      if (!app || !app.date) return false;

      const appDate = new Date(app.date);

      return (
        appDate.getMonth() === currentMonth &&
        appDate.getFullYear() === currentYear &&
        isAnalyticsDateReached(app.date) &&
        app.status !== AppointmentStatus.NO_SHOW
      );
    });

    const isFundusComplete = (app: Appointment) => {
      const rightDone =
        !!app.rightEyePhoto ||
        app.rightEyeImageStatus === "Not Obtainable";

      const leftDone =
        !!app.leftEyePhoto ||
        app.leftEyeImageStatus === "Not Obtainable";

      return rightDone && leftDone;
    };

    const isCaseComplete = (app: Appointment) =>
      isFundusComplete(app) && isReviewCompleted(app);

    return {
      // Total KK Lintang workload for the selected month.
      total: thisMonthApps.length,

      // One or both eyes still need fundus capture / Not Obtainable marking.
      fundusPending: thisMonthApps.filter(
        app => !isFundusComplete(app)
      ).length,

      // Fundus is complete, but clinical review is still incomplete.
      reviewPending: thisMonthApps.filter(
        app =>
          isFundusComplete(app) &&
          !isReviewCompleted(app)
      ).length,

      // Unique cases that are not fully completed.
      totalPending: thisMonthApps.filter(
        app => !isCaseComplete(app)
      ).length,
    };
  }, [providerWorkloadAppointments, selectedAnalyticsMonth]);

// ===== MONTHLY RETEN KK LINTANG =====
const monthlyRetenStats = useMemo(() => {

  const currentMonth = selectedAnalyticsMonth.getMonth();
  const currentYear = selectedAnalyticsMonth.getFullYear();

  // Semua appointment dalam bulan yang dipilih
  // No Show tidak dikira sebagai screening
  const monthlyApps = providerWorkloadAppointments.filter(app => {

    if (!app || !app.date) return false;

    const appDate = new Date(app.date);

    return (
      appDate.getMonth() === currentMonth &&
      appDate.getFullYear() === currentYear &&
      isAnalyticsDateReached(app.date) &&
      app.status !== AppointmentStatus.NO_SHOW
    );

  });


  // Helper:
  // Sekurang-kurangnya satu fundus image berjaya diambil
  const hasPhotograph = (app: Appointment) => {
    return !!(
      app.rightEyePhoto ||
      app.leftEyePhoto
    );
  };


  // Helper:
// Determine overall screening outcome
// Shared two-eye calculation rule used by Monthly/Yearly/Super Admin summaries.
const getScreeningOutcome = (
  app: Appointment
): 'Normal' | 'Abnormal' | 'Ungradable' | 'Not Obtainable' | 'Not Review Yet' => {

  const rightNotObtainable = app.rightEyeImageStatus === 'Not Obtainable';
  const leftNotObtainable = app.leftEyeImageStatus === 'Not Obtainable';

  const rightStatus =
    app.rightEyeReviewDetails?.status ||
    (app.rightEyeReview === 'Normal' || app.rightEyeReview === 'Abnormal' || app.rightEyeReview === 'Ungradable'
      ? app.rightEyeReview
      : '');

  const leftStatus =
    app.leftEyeReviewDetails?.status ||
    (app.leftEyeReview === 'Normal' || app.leftEyeReview === 'Abnormal' || app.leftEyeReview === 'Ungradable'
      ? app.leftEyeReview
      : '');

  const rightCompleted = rightNotObtainable || !!rightStatus;
  const leftCompleted = leftNotObtainable || !!leftStatus;

  // Both eyes Not Obtainable: case is complete and does not require review.
  if (rightNotObtainable && leftNotObtainable) {
    return 'Not Obtainable';
  }

  // Any reviewed abnormal eye takes priority over Not Obtainable.
  if (rightStatus === 'Abnormal' || leftStatus === 'Abnormal') {
    return 'Abnormal';
  }

  // One eye Not Obtainable does NOT complete the review for the other eye.
  if (!rightCompleted || !leftCompleted) {
    return 'Not Review Yet';
  }

  // One Normal eye + one Not Obtainable eye.
  if (rightNotObtainable || leftNotObtainable) {
    return 'Not Obtainable';
  }

  // Ungradable is a completed clinical review outcome, distinct from Normal/Abnormal.
  if (rightStatus === 'Ungradable' || leftStatus === 'Ungradable') {
    return 'Ungradable';
  }

  // Both eyes reviewed and Normal.
  if (rightStatus === 'Normal' && leftStatus === 'Normal') {
    return 'Normal';
  }

  // Defensive fallback for an unexpected completed review value.
  return 'Abnormal';
};


// Compatibility helpers
// Kekalkan nama lama supaya code lain tidak crash.

const isNormal = (app: Appointment) => {
  return getScreeningOutcome(app) === 'Normal';
};


const isAbnormal = (app: Appointment) => {
  return getScreeningOutcome(app) === 'Abnormal';
};


const isNotObtainable = (app: Appointment) => {
  return getScreeningOutcome(app) === 'Not Obtainable';
};


  // Helper:
  // Check finding pada kedua-dua mata
  const hasFinding = (
    app: Appointment,
    finding: string
  ) => {

    const right =
      app.rightEyeReviewDetails?.abnormalTypes || [];

    const left =
      app.leftEyeReviewDetails?.abnormalTypes || [];

    return (
      right.includes(finding) ||
      left.includes(finding)
    );

  };


  // Helper:
  // Check NPDR severity
  const hasNPDRSeverity = (
    app: Appointment,
    severity: 'mild' | 'moderate' | 'severe'
  ) => {

    return (
      app.rightEyeReviewDetails?.npdrSeverity === severity ||
      app.leftEyeReviewDetails?.npdrSeverity === severity
    );

  };
// =====================================================
// DYNAMIC MONTHLY DEPARTMENT SUMMARY
// Generates screening counts for every department
// registered in the clinic-aware department master list.
//
// Adding a new department automatically includes it
// in the monthly summary.
// =====================================================

const monthlyDepartmentSummary =
  clinics.reduce(
    (stats, clinic) => {
      if (isCurrentClinicFundusProvider) {
        //--- Provider clinic: breakdown by referring/source clinic. ---//
        stats[clinic.id] = monthlyApps.filter(
          app => getReferringClinicId(app) === clinic.id
        ).length;
      } else {
        //--- Non-provider clinic: only its own operational workload. ---//
        stats[clinic.id] = monthlyApps.filter(
          app => (app.clinicId || 'LINTANG') === clinic.id
        ).length;
      }

      return stats;
    },
    {} as Record<string, number>
  );

return {

  //--- Dynamic department statistics for Monthly Reten ---//
  monthlyDepartmentSummary,

  // =========================
  // SCREENING SUMMARY
  // =========================

  opd: monthlyApps.filter(
    app => app.department === 'OPD KKL'
  ).length,

  pboa: monthlyApps.filter(
    app => app.department === 'PBOA'
  ).length,

  //--- HSS count is calculated dynamically from monthly appointments ---//
  hss: monthlyApps.filter(
    app => app.department === 'HSS'
  ).length,

  total: monthlyApps.length,

    // =========================
    // OUTCOME SCREENING
    // =========================

normal: monthlyApps.filter(
  app => getScreeningOutcome(app) === 'Normal'
).length,

abnormal: monthlyApps.filter(
  app => getScreeningOutcome(app) === 'Abnormal'
).length,

ungradable: monthlyApps.filter(
  app => getScreeningOutcome(app) === 'Ungradable'
).length,

notObtainable: monthlyApps.filter(
  app => getScreeningOutcome(app) === 'Not Obtainable'
).length,

notReviewYet: monthlyApps.filter(
  app => getScreeningOutcome(app) === 'Not Review Yet'
).length,

    // =========================
    // RETEN FINDINGS
    // =========================

    mildNPDR: monthlyApps.filter(
      app => hasNPDRSeverity(app, 'mild')
    ).length,

    moderateNPDR: monthlyApps.filter(
      app => hasNPDRSeverity(app, 'moderate')
    ).length,

    severeNPDR: monthlyApps.filter(
      app => hasNPDRSeverity(app, 'severe')
    ).length,

    pdr: monthlyApps.filter(
      app => hasFinding(app, 'PDR')
    ).length,

    maculopathy: monthlyApps.filter(
      app => hasFinding(app, 'Maculopathy')
    ).length,

    aded: monthlyApps.filter(
      app => hasFinding(app, 'ADED')
    ).length,

    cataract: monthlyApps.filter(app => {

  const hasCataractFinding =
    hasFinding(app, 'Cataract');

  const hasDenseCataract =
    app.rightEyeImageReason?.trim().toLowerCase() === 'dense cataract' ||
    app.leftEyeImageReason?.trim().toLowerCase() === 'dense cataract';

  return hasCataractFinding || hasDenseCataract;

}).length,

    others: monthlyApps.filter(
      app => hasFinding(app, 'Others')
    ).length,

    referred: monthlyApps.filter(
      app => app.referred === true
    ).length,


    // =========================
    // PHOTOGRAPHS TAKEN
    // =========================

    photographs: monthlyApps.filter(
      hasPhotograph
    ).length

  };

}, [providerWorkloadAppointments, selectedAnalyticsMonth]);

// =====================================================
// DEPARTMENT STATISTICS HELPER
// Counts appointments dynamically by department.
//
// This allows new departments such as HSS to be included
// without creating a separate hardcoded filter for each one.
// =====================================================

const getDepartmentCount = (
  apps: Appointment[],
  department: Department
) => {
  return apps.filter(
    app => app.department === department
  ).length;
};

  const monthlyDepartmentStats = useMemo(() => {

  const currentMonth =
selectedAnalyticsMonth.getMonth();

const currentYear =
selectedAnalyticsMonth.getFullYear();

  const thisMonthApps = visibleAppointments.filter(app => {

    if (!app || !app.date) return false;

    const appDate = new Date(app.date);

    return (
      appDate.getMonth() === currentMonth &&
      appDate.getFullYear() === currentYear &&
      isAnalyticsDateReached(app.date) &&
      app.status !== AppointmentStatus.NO_SHOW
    );

  });

  // =====================================================
// DYNAMIC MONTHLY DEPARTMENT STATISTICS
// Calculates monthly statistics for every department
// listed in the clinic-aware department master list.
//
// Adding a new department will automatically include it
// in these statistics without creating new hardcoded
// OPD/PBOA variables.
// =====================================================

const departmentStats = availableDepartments.reduce(
  (stats, department) => {

    const departmentApps = thisMonthApps.filter(
      app => (app.clinicId || 'LINTANG') === department.id
    );

    const fundusCount = departmentApps.filter(
      app =>
        !app.rightEyePhoto ||
        !app.leftEyePhoto
    ).length;

    const reviewCount = departmentApps.filter(
      app =>
        (app.rightEyePhoto ||
          app.leftEyePhoto) &&
        (!app.rightEyeReview ||
          !app.leftEyeReview)
    ).length;

    const incompleteCount = departmentApps.filter(
      app =>
        !(
          app.rightEyePhoto &&
          app.leftEyePhoto &&
          app.rightEyeReview &&
          app.leftEyeReview
        )
    ).length;

    stats[department.id] = {
      total: departmentApps.length,
      fundus: fundusCount,
      review: reviewCount,
      incomplete: incompleteCount,
    };

    return stats;
  },
  {} as Record<
    Department,
    {
      total: number;
      fundus: number;
      review: number;
      incomplete: number;
    }
  >
);

  return {
    //--- Dynamic statistics for all departments ---//
    departmentStats,

    totalOPD:
      thisMonthApps.filter(
        app => app.department === 'OPD KKL'
      ).length,

    totalPBOA:
      thisMonthApps.filter(
        app => app.department === 'PBOA'
      ).length,

    fundusOPD:
      thisMonthApps.filter(
        app =>
          app.department === 'OPD KKL' &&
          (!app.rightEyePhoto || !app.leftEyePhoto)
      ).length,

    fundusPBOA:
      thisMonthApps.filter(
        app =>
          app.department === 'PBOA' &&
          (!app.rightEyePhoto || !app.leftEyePhoto)
      ).length,

    reviewOPD:
      thisMonthApps.filter(
        app =>
          app.department === 'OPD KKL' &&
          (app.rightEyePhoto || app.leftEyePhoto) &&
          (!app.rightEyeReview || !app.leftEyeReview)
      ).length,

    reviewPBOA:
      thisMonthApps.filter(
        app =>
          app.department === 'PBOA' &&
          (app.rightEyePhoto || app.leftEyePhoto) &&
          (!app.rightEyeReview || !app.leftEyeReview)
      ).length,

    incompleteOPD:
      thisMonthApps.filter(
        app =>
          app.department === 'OPD KKL' &&
          !(app.rightEyePhoto &&
            app.leftEyePhoto &&
            app.rightEyeReview &&
            app.leftEyeReview)
      ).length,

    incompletePBOA:
      thisMonthApps.filter(
        app =>
          app.department === 'PBOA' &&
          !(app.rightEyePhoto &&
            app.leftEyePhoto &&
            app.rightEyeReview &&
            app.leftEyeReview)
      ).length

  };

}, [visibleAppointments, selectedAnalyticsMonth]);

  // =====================================================
  // SUPER ADMIN MONTHLY CLINIC SUMMARY
  // Shows the current selected month across every active clinic.
  // Provider clinics count fundus work performed by that clinic,
  // including referrals from HSS/PBOA/other source clinics.
  // Non-provider clinics count their own operational records.
  // =====================================================
  const superAdminMonthlyClinicStats = useMemo(() => {
    const month = selectedAnalyticsMonth.getMonth();
    const year = selectedAnalyticsMonth.getFullYear();

    const isFundusComplete = (app: Appointment) => {
      const rightDone = !!app.rightEyePhoto || app.rightEyeImageStatus === 'Not Obtainable';
      const leftDone = !!app.leftEyePhoto || app.leftEyeImageStatus === 'Not Obtainable';
      return rightDone && leftDone;
    };

    return clinics
      .filter(clinic => clinic.active)
      .map(clinic => {
        const clinicApps = appointments.filter(app => {
          if (!app?.date || app.status === AppointmentStatus.NO_SHOW) return false;
          const d = new Date(app.date);
          if (
            d.getMonth() !== month ||
            d.getFullYear() !== year ||
            !isAnalyticsDateReached(app.date)
          ) return false;

          if (clinic.isFundusProvider) {
            const providerMatch = (app.fundusProviderClinicId || '').trim() === clinic.id;
            const legacyLintangMatch = clinic.id === 'LINTANG' && isLegacyLintangProviderRecord(app);
            return providerMatch || legacyLintangMatch;
          }

          return (app.clinicId || 'LINTANG') === clinic.id;
        });

        const pendingFundus = clinicApps.filter(app => !isFundusComplete(app)).length;
        const pendingReview = clinicApps.filter(
          app => isFundusComplete(app) && !isReviewCompleted(app)
        ).length;
        const completed = clinicApps.filter(
          app => isFundusComplete(app) && isReviewCompleted(app)
        ).length;

        return {
          clinic,
          total: clinicApps.length,
          pendingFundus,
          pendingReview,
          completed,
        };
      });
  }, [appointments, clinics, selectedAnalyticsMonth]);

  // =====================================================
  // SUPER ADMIN MONTHLY CLINICAL DETAIL
  // Uses the same selected month as the clinic summary cards.
  // Provider clinics count fundus work performed by that clinic;
  // referral clinics count their own operational records.
  // =====================================================
  const superAdminClinicMonthlyDetail = useMemo(() => {
    if (!selectedSuperAdminClinicId) return null;

    const clinic = clinics.find(c => c.id === selectedSuperAdminClinicId);
    if (!clinic) return null;

    const month = selectedAnalyticsMonth.getMonth();
    const year = selectedAnalyticsMonth.getFullYear();

    //--- Local helpers keep the Super Admin detail summary independent from monthlyRetenStats scope ---//
    const hasFindingForDetail = (app: Appointment, finding: string) => {
      const right = app.rightEyeReviewDetails?.abnormalTypes || [];
      const left = app.leftEyeReviewDetails?.abnormalTypes || [];
      return right.includes(finding) || left.includes(finding);
    };

    const hasNPDRSeverityForDetail = (
      app: Appointment,
      severity: 'mild' | 'moderate' | 'severe'
    ) => {
      return (
        app.rightEyeReviewDetails?.npdrSeverity === severity ||
        app.leftEyeReviewDetails?.npdrSeverity === severity
      );
    };

    const getScreeningOutcomeForDetail = (
      app: Appointment
    ): 'Normal' | 'Abnormal' | 'Ungradable' | 'Not Obtainable' | 'Not Review Yet' => {
      const rightNotObtainable = app.rightEyeImageStatus === 'Not Obtainable';
      const leftNotObtainable = app.leftEyeImageStatus === 'Not Obtainable';

      const rightStatus =
        app.rightEyeReviewDetails?.status ||
        (app.rightEyeReview === 'Normal' || app.rightEyeReview === 'Abnormal' || app.rightEyeReview === 'Ungradable'
          ? app.rightEyeReview
          : '');

      const leftStatus =
        app.leftEyeReviewDetails?.status ||
        (app.leftEyeReview === 'Normal' || app.leftEyeReview === 'Abnormal' || app.leftEyeReview === 'Ungradable'
          ? app.leftEyeReview
          : '');

      const rightCompleted = rightNotObtainable || !!rightStatus;
      const leftCompleted = leftNotObtainable || !!leftStatus;

      if (rightNotObtainable && leftNotObtainable) return 'Not Obtainable';
      if (rightStatus === 'Abnormal' || leftStatus === 'Abnormal') return 'Abnormal';
      if (!rightCompleted || !leftCompleted) return 'Not Review Yet';
      if (rightNotObtainable || leftNotObtainable) return 'Not Obtainable';
      if (rightStatus === 'Ungradable' || leftStatus === 'Ungradable') return 'Ungradable';
      if (rightStatus === 'Normal' && leftStatus === 'Normal') return 'Normal';
      return 'Abnormal';
    };

    const clinicApps = appointments.filter(app => {
      if (!app?.date || app.status === AppointmentStatus.NO_SHOW) return false;

      const d = new Date(app.date);
      if (
        d.getMonth() !== month ||
        d.getFullYear() !== year ||
        !isAnalyticsDateReached(app.date)
      ) return false;

      if (clinic.isFundusProvider) {
        const providerMatch = (app.fundusProviderClinicId || '').trim() === clinic.id;
        const legacyLintangMatch = clinic.id === 'LINTANG' && isLegacyLintangProviderRecord(app);
        return providerMatch || legacyLintangMatch;
      }

      return (app.clinicId || 'LINTANG') === clinic.id;
    });

    return {
      clinic,
      total: clinicApps.length,
      normal: clinicApps.filter(app => getScreeningOutcomeForDetail(app) === 'Normal').length,
      abnormal: clinicApps.filter(app => getScreeningOutcomeForDetail(app) === 'Abnormal').length,
      ungradable: clinicApps.filter(app => getScreeningOutcomeForDetail(app) === 'Ungradable').length,
      notObtainable: clinicApps.filter(app => getScreeningOutcomeForDetail(app) === 'Not Obtainable').length,
      notReviewYet: clinicApps.filter(app => getScreeningOutcomeForDetail(app) === 'Not Review Yet').length,
      mildNPDR: clinicApps.filter(app => hasNPDRSeverityForDetail(app, 'mild')).length,
      moderateNPDR: clinicApps.filter(app => hasNPDRSeverityForDetail(app, 'moderate')).length,
      severeNPDR: clinicApps.filter(app => hasNPDRSeverityForDetail(app, 'severe')).length,
      pdr: clinicApps.filter(app => hasFindingForDetail(app, 'PDR')).length,
      maculopathy: clinicApps.filter(app => hasFindingForDetail(app, 'Maculopathy')).length,
      aded: clinicApps.filter(app => hasFindingForDetail(app, 'ADED')).length,
      cataract: clinicApps.filter(app => {
        const hasCataractFinding = hasFindingForDetail(app, 'Cataract');
        const hasDenseCataract =
          app.rightEyeImageReason?.trim().toLowerCase() === 'dense cataract' ||
          app.leftEyeImageReason?.trim().toLowerCase() === 'dense cataract';
        return hasCataractFinding || hasDenseCataract;
      }).length,
    };
  }, [appointments, clinics, selectedAnalyticsMonth, selectedSuperAdminClinicId]);

  const yearlyStats = useMemo(() => {
    const currentYear = new Date().getFullYear();

    // Practice Summary = KK Lintang service workload for the current year.
    // Department is only a referring/source breakdown.
    // Only appointments whose scheduled date has arrived are included.
    const thisYearApps = providerWorkloadAppointments.filter(app => {
      if (!app || !app.date) return false;

      const appDate = new Date(app.date);

      return (
        appDate.getFullYear() === currentYear &&
        isAnalyticsDateReached(app.date) &&
        app.status !== AppointmentStatus.NO_SHOW
      );
    });

    const isFundusComplete = (app: Appointment) => {
      const rightDone =
        !!app.rightEyePhoto ||
        app.rightEyeImageStatus === "Not Obtainable";

      const leftDone =
        !!app.leftEyePhoto ||
        app.leftEyeImageStatus === "Not Obtainable";

      return rightDone && leftDone;
    };

    const isPendingReview = (app: Appointment) =>
      isFundusComplete(app) && !isReviewCompleted(app);

    // =====================================================
    // PROVIDER SOURCE-CLINIC BREAKDOWN
    // Provider clinics count every case performed here, but the
    // small breakdown shows where those patients came from.
    // This restores the old dashboard behaviour without treating
    // HSS/PBOA as the operational clinicId.
    // =====================================================

    const sourceClinicStats = clinics.reduce(
      (stats, clinic) => {
        const sourceApps = thisYearApps.filter(
          app => getReferringClinicId(app) === clinic.id
        );

        stats[clinic.id] = {
          total: sourceApps.length,
          pendingReview: sourceApps.filter(isPendingReview).length,
        };

        return stats;
      },
      {} as Record<string, { total: number; pendingReview: number }>
    );

    const reviewPendingOPD = thisYearApps.filter(
      app =>
        app.department === 'OPD KKL' &&
        isPendingReview(app)
    ).length;

    const reviewPendingPBOA = thisYearApps.filter(
      app =>
        app.department === 'PBOA' &&
        isPendingReview(app)
    ).length;

    return {
      //--- Provider dashboard breakdown by referring/source clinic ---//
      sourceClinicStats,

      opd: sourceClinicStats['LINTANG']?.total ?? 0,
      pboa: sourceClinicStats['PBOA']?.total ?? 0,

      reviewPendingOPD: sourceClinicStats['LINTANG']?.pendingReview ?? 0,
      reviewPendingPBOA: sourceClinicStats['PBOA']?.pendingReview ?? 0,

      // Unique current-year cases awaiting clinical review.
      reviewPending: thisYearApps.filter(
        isPendingReview
      ).length,

      total: thisYearApps.length,
      year: currentYear
    };
  }, [providerWorkloadAppointments, clinics]);

  const isAppointmentComplete = (app: Appointment) => {
  if (!app) return false;

  const rightDone =
    !!app.rightEyePhoto ||
    app.rightEyeImageStatus === "Not Obtainable";

  const leftDone =
    !!app.leftEyePhoto ||
    app.leftEyeImageStatus === "Not Obtainable";

  return (
    rightDone &&
    leftDone &&
    isReviewCompleted(app)
  );
};

  const currentPatient =
  selectedPhotoApp?.app || selectedReviewSummary;

const patientHistory = currentPatient
  ? appointments
      .filter(
        app =>
          app.icNumber === currentPatient.icNumber &&
          app.id !== currentPatient.id &&
          app.status !== AppointmentStatus.NO_SHOW
      )
      .sort(
        (a, b) => (b.createdAt || 0) - (a.createdAt || 0)
      )
  : [];

 // Search & Filter State
const [searchQuery, setSearchQuery] = useState('');

const [filterDateFrom, setFilterDateFrom] = useState('');
const [filterDateTo, setFilterDateTo] = useState('');

const [filterStatus, setFilterStatus] = useState<AppointmentStatus | 'All' | 'Active'>('Active');
const [filterReview, setFilterReview] = useState<'All' | 'Pending' | 'Abnormal' | 'Normal'>('All');
const [filterDepartment, setFilterDepartment] = useState<'All' | Department>('All');
const [currentPage, setCurrentPage] = useState(1);

// Always return to the first page when search/filter criteria change.
useEffect(() => {
  setCurrentPage(1);
}, [
  searchQuery,
  filterDateFrom,
  filterDateTo,
  filterStatus,
  filterReview,
  filterDepartment
]);

const ITEMS_PER_PAGE = 5;

  // Load Data
useEffect(() => {

  // Load Appointments from localStorage first
 /* const savedApps = localStorage.getItem(STORAGE_KEY);

  if (savedApps) {
    try {

      const parsed = JSON.parse(savedApps);

      if (Array.isArray(parsed)) {
        setAppointments(
          parsed.filter(
            (app: any) => app && typeof app === 'object'
          )
        );
      }

    } catch (e) {
      console.error(
        "Failed to parse appointments",
        e
      );
    }
  }
*/
  const savedActivityLogs = localStorage.getItem(ACTIVITY_LOGS_KEY);

  if (savedActivityLogs) {
    try {
      const parsedLogs = JSON.parse(savedActivityLogs);

      if (Array.isArray(parsedLogs)) {
        setActivityLogs(
          parsedLogs.filter(
            (log: any) => log && typeof log === 'object'
          )
        );
      }
    } catch (e) {
      console.error(
        "Failed to parse activity logs",
        e
      );
    }
  }

  // Realtime Clinic Master Sync
  const unsubscribeClinics = onSnapshot(
    collection(db, "clinics"),
    (snapshot) => {
      if (snapshot.empty) {
        setClinics(DEFAULT_CLINICS);
        return;
      }

      //---Merge Firestore clinic configuration over migration defaults.
      //---Some legacy clinic documents contain only configuration fields (e.g. routing)
      //---and do not contain name/shortName. Do NOT discard those documents.
      //---Always hydrate known clinics from DEFAULT_CLINICS, then overlay Firestore fields.---//
      const firestoreClinics = snapshot.docs
        .map(docSnapshot => ({
          id: docSnapshot.id,
          ...(docSnapshot.data() as Partial<Clinic>),
        }))
        .filter(clinic => Boolean(clinic.id)) as Clinic[];

      const merged = DEFAULT_CLINICS.map(defaultClinic => {
        const firestoreClinic = firestoreClinics.find(clinic => clinic.id === defaultClinic.id);
        return firestoreClinic
          ? {
              ...defaultClinic,
              ...firestoreClinic,
              shortName: firestoreClinic.shortName || defaultClinic.shortName || defaultClinic.name,
              active: firestoreClinic.active ?? defaultClinic.active,
              isFundusProvider: firestoreClinic.isFundusProvider ?? defaultClinic.isFundusProvider,
            }
          : defaultClinic;
      });

      firestoreClinics.forEach(clinic => {
        if (!merged.some(existing => existing.id === clinic.id)) {
          merged.push({
            ...clinic,
            name: clinic.name || clinic.id,
            shortName: clinic.shortName || clinic.name || clinic.id,
            active: clinic.active ?? true,
            isFundusProvider: clinic.isFundusProvider ?? false,
          });
        }
      });

      //--- Preserve local routing changes until Firestore confirms the same value ---//
      const mergedWithPendingChanges = merged.map(clinic => {
        let nextClinic = clinic;

        //--- Preserve pending provider ON/OFF state until Firestore confirms it ---//
        const pendingProvider = pendingFundusProviderRef.current[clinic.id];
        if (pendingProvider !== undefined) {
          if (clinic.isFundusProvider === pendingProvider) {
            delete pendingFundusProviderRef.current[clinic.id];
          } else {
            nextClinic = {
              ...nextClinic,
              isFundusProvider: pendingProvider,
            };
          }
        }

        //--- Preserve pending referral routing until Firestore confirms it ---//
        const pendingRouting = pendingFundusRoutingRef.current[clinic.id];
        if (pendingRouting) {
          const serverProviders = [...(clinic.fundusProviderClinicIds || [])].sort();
          const pendingProviders = [...pendingRouting].sort();

          if (
            serverProviders.length === pendingProviders.length &&
            serverProviders.every((id, index) => id === pendingProviders[index])
          ) {
            delete pendingFundusRoutingRef.current[clinic.id];
          } else {
            nextClinic = {
              ...nextClinic,
              fundusProviderClinicIds: pendingRouting,
            };
          }
        }

        return nextClinic;
      });

      setClinics(mergedWithPendingChanges);
    },
    (error) => {
      console.warn("Clinic master sync unavailable; using migration defaults.", error);
      setClinics(DEFAULT_CLINICS);
    }
  );

  // Realtime Firestore Sync
const unsubscribe = onSnapshot(
  collection(db, "appointments"),
  (snapshot) => {

    const firestoreApps = snapshot.docs.map(docSnapshot => {
  const data = docSnapshot.data() as Partial<Appointment>;
  return {
    firestoreId: docSnapshot.id,
    ...normalizeAppointmentClinic(data),
  };
}) as Appointment[];

    if (firestoreApps.length > 0) {
      setAppointments(firestoreApps);
    }

  }
);


// Realtime Users Sync
const unsubscribeUsers = onSnapshot(
  collection(db, "users"),
  (snapshot) => {

    let firestoreUsers = snapshot.docs.map(doc => {
      const data = doc.data() as Partial<User>;
      return {
        firestoreId: doc.id,
        ...normalizeUserClinic(data),
      };
    }) as User[];

    setUsers(firestoreUsers);

  }
);

// Realtime Specialist Master Sync — isolated from screening clinic and staff collections.
const unsubscribeSpecialistClinics = onSnapshot(
  collection(db, 'specialistClinics'),
  snapshot => setSpecialistClinics(snapshot.docs.map(item => ({
    id: item.id,
    ...(item.data() as Omit<SpecialistClinic, 'id'>),
  } as SpecialistClinic))),
  error => console.warn('Specialist clinic master sync unavailable.', error)
);

const unsubscribeSpecialistUsers = onSnapshot(
  collection(db, 'specialistUsers'),
  snapshot => setSpecialistUsers(snapshot.docs.map(item => ({
    id: item.id,
    ...(item.data() as Omit<SpecialistUser, 'id'>),
  } as SpecialistUser))),
  error => console.warn('Specialist user master sync unavailable.', error)
);

// Realtime Activity Logs Sync
const unsubscribeActivityLogs = onSnapshot(
  query(
    collection(db, "activityLogs"),
    orderBy("timestamp", "desc"),
    limit(50)
  ),
  (snapshot) => {

    const firestoreActivityLogs = snapshot.docs.map(docSnapshot => ({
      ...docSnapshot.data(),
      //--- Preserve missing clinicId as empty; only Super Admin should see legacy/global logs ---//
      clinicId: (docSnapshot.data() as Partial<ActivityLog>).clinicId ?? '',
    })) as ActivityLog[];

    setActivityLogs(firestoreActivityLogs);

  }
);

return () => {
  unsubscribeClinics();
  unsubscribe();
  unsubscribeUsers();
  unsubscribeActivityLogs();
  unsubscribeSpecialistClinics();
  unsubscribeSpecialistUsers();
};

}, []);

// Specialist referral inbox: subscribe only after a specialist clinic is known.
// The clinic ID is part of the effect dependencies so logging in/switching sessions
// cannot leave the listener stuck with the initial null specialistCurrentUser.
useEffect(() => {
  const specialistClinicId = specialistCurrentUser?.clinicId;

  if (!specialistClinicId) {
    setSpecialistReferrals([]);
    return;
  }

  const referralsQuery = query(
    collection(db, 'specialistReferrals'),
    where('specialistClinicId', '==', specialistClinicId)
  );

  const unsubscribe = onSnapshot(
    referralsQuery,
    snapshot => setSpecialistReferrals(snapshot.docs.map(item => ({
      id: item.id,
      ...(item.data() as Record<string, any>),
    }))),
    error => {
      console.warn('Specialist referral inbox sync unavailable.', error);
      setSpecialistReferrals([]);
    }
  );

  return () => unsubscribe();
}, [specialistCurrentUser?.clinicId]);


// Reset transient Super Admin UI when changing sidebar sections.
// Saved Firestore data is untouched; only open forms, modals, and selections reset.
useEffect(() => {
  setShowStaffForm(false);
  setShowAdminConsole(false);
  setShowSuperAdminConsole(false);
  setShowClinicManager(false);
  setShowFundusNetwork(false);
  setShowActivityLogs(false);
  setShowReferralClinicManager(false);
  setShowDataMigration(false);
  setShowNewClinicForm(false);
  setShowSpecialistClinicForm(false);
  setEditingSpecialistClinicId(null);
  setShowSpecialistUserForm(false);
  setEditingSpecialistUserId(null);
  setEditingUser(null);
  setUserToDelete(null);
  setSelectedSpecialistUsersClinic(null);
  setSpecialistUserClinicFilter('ALL');
  setSpecialistUserRoleFilter('ALL');
  setSelectedSuperAdminUsersClinic(null);
  setSuperAdminUserClinicFilter('ALL');
}, [activeSuperAdminView]);

// Sync Appointments with localStorage
/*useEffect(() => {

  try {

    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(appointments)
    );

  } catch (e) {

    console.error(
      "Failed to save appointments to localStorage",
      e
    );

    if (
      e instanceof Error &&
      e.name === 'QuotaExceededError'
    ) {

      alert(
        "Local storage is full. Some data might not be saved. Try removing some photos or clearing browser data."
      );

    }

  }

}, [visibleAppointments]);


// Sync Activity Logs with localStorage
useEffect(() => {

  try {

    localStorage.setItem(
      ACTIVITY_LOGS_KEY,
      JSON.stringify(activityLogs)
    );

  } catch (e) {

    console.error(
      "Failed to save activity logs to localStorage",
      e
    );

  }

}, [activityLogs]);


// Sync Users with localStorage
useEffect(() => {

  if (users.length > 0) {

    try {

      localStorage.setItem(
        USERS_KEY,
        JSON.stringify(users)
      );

    } catch (e) {

      console.error(
        "Failed to save users to localStorage",
        e
      );

    }

  }

}, [users]);
*/

// Sync Current User
useEffect(() => {

  if (currentUser) {

    sessionStorage.setItem(
      'clinic_current_user',
      JSON.stringify(currentUser)
    );

  } else {

    sessionStorage.removeItem(
      'clinic_current_user'
    );

  }

}, [currentUser]);

useEffect(() => {
  if (specialistCurrentUser) sessionStorage.setItem('specialist_current_user', JSON.stringify(specialistCurrentUser));
  else sessionStorage.removeItem('specialist_current_user');
}, [specialistCurrentUser]);

// AUTO LOGOUT AFTER 1 HOUR IDLE
useEffect(() => {

  let timeout: NodeJS.Timeout;

  const resetTimer = () => {

    clearTimeout(timeout);

    timeout = setTimeout(() => {

      sessionStorage.removeItem('clinic_current_user');
      sessionStorage.removeItem('specialist_current_user');

      window.location.reload();

    }, 60 * 60 * 1000);

  };

  window.addEventListener('mousemove', resetTimer);
  window.addEventListener('keydown', resetTimer);
  window.addEventListener('click', resetTimer);
  window.addEventListener('scroll', resetTimer);

  resetTimer();

  return () => {

    clearTimeout(timeout);

    window.removeEventListener('mousemove', resetTimer);
    window.removeEventListener('keydown', resetTimer);
    window.removeEventListener('click', resetTimer);
    window.removeEventListener('scroll', resetTimer);

  };

}, []);
  // Auth Handlers
  const handleLogin = (e: React.FormEvent) => {

  e.preventDefault();

  setLoginError('');

  setIsAuthenticating(true);

  setAuthMessage('Verifying Credentials...');

  setTimeout(() => {

    const id = tempUserId.trim().toLowerCase();

    const pass = tempPassword;

    const user = users.find(
      u => u.id.toLowerCase() === id && u.password === pass
    );
    const specialistUser = specialistUsers.find(
      u => u.id.toLowerCase() === id && u.password === pass && u.active !== false
    );

    if (specialistUser && !user) {
      setCurrentUser(null);
      setSpecialistCurrentUser(specialistUser);
      sessionStorage.removeItem('clinic_current_user');
      addDoc(collection(db, 'activityLogs'), {
        clinicId: `SPECIALIST:${specialistUser.clinicId}`,
        action: 'Specialist User Logged In',
        patient: `${specialistUser.displayName} (${specialistUser.id})`,
        by: specialistUser.displayName,
        timestamp: Date.now(),
      }).catch(error => console.warn('Could not write specialist login log', error));
    } else if (user) {
      setSpecialistCurrentUser(null);
      sessionStorage.removeItem('specialist_current_user');

      const normalizedUser: User = {
        ...user,
        clinicId: user.clinicId ?? 'LINTANG',
      };

      setCurrentUser(normalizedUser);
      addActivityLog('Logged In', `${user.displayName} (${user.id})`, user.displayName);

    } else {

      setLoginError('Invalid User ID or Password');
      addActivityLog('Failed Login Attempt', id || 'Unknown User', 'System');

    }

    setIsAuthenticating(false);

  }, 1500);

};

  const handleLogout = () => {

  setIsAuthenticating(true);

  setAuthMessage('Ending Clinical Session...');

  setTimeout(() => {

    setAuthMessage('Protecting Patient Data...');
    addActivityLog('Logged Out', currentUser ? `${currentUser.displayName} (${currentUser.id})` : 'System');

    setTimeout(() => {

      sessionStorage.removeItem('clinic_current_user');
      sessionStorage.removeItem('specialist_current_user');
      setCurrentUser(null);
      setSpecialistCurrentUser(null);

      setTempUserId('');
      setTempPassword('');

      setIsAuthenticating(false);

    }, 1200);

  }, 1200);

};

const addStaffMember = async (e: React.FormEvent) => {
  e.preventDefault();

  if (
    !newStaffId.trim() ||
    !newStaffPass.trim() ||
    !newStaffName.trim()
  ) {
    return;
  }

  const id = newStaffId.trim().toUpperCase();

  // Check duplicate ID — case insensitive
  if (
    users.some(
      u => u.id.trim().toLowerCase() === id.toLowerCase()
    )
  ) {
    alert(`Staff User ID "${id}" sudah digunakan. Sila pilih ID yang berbeza.`);
    return;
  }

  const newUser: User = {
    id,
    password: newStaffPass,
    displayName: newStaffName.trim(),
    role: currentUser?.role === UserRole.SUPER_ADMIN ? newStaffRole : UserRole.STAFF,
    clinicId: currentUser?.role === UserRole.SUPER_ADMIN
      ? (newStaffRole === UserRole.SUPER_ADMIN ? null : newStaffClinicId)
      : (currentUser?.clinicId ?? 'LINTANG'),
    createdAt: Date.now()
  };

  try {
    setIsSavingStaff(true);
    // Save to Firestore first
    await addDoc(
      collection(db, "users"),
      newUser
    );

    // Only log after successful creation
    addActivityLog(
      'Created Staff Account',
      `${newUser.displayName} (${newUser.id})`
    );

    // Reset form
    setNewStaffId('');
    setNewStaffName('');
    setNewStaffPass('');
    setShowStaffPassword(false);
    setNewStaffRole(UserRole.STAFF);
    setNewStaffClinicId(currentUser?.clinicId ?? 'LINTANG');

  } catch (error) {
    console.error(
      'Failed to create staff account',
      error
    );

    alert(
      'Failed to create staff account. Please try again.'
    );
  } finally {
    setIsSavingStaff(false);
  }
};
  
const updateStaffMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser?.firestoreId) return;

    const updatedId = editingUser.id.trim().toUpperCase();
    const updatedName = editingUser.displayName.trim();
    if (!updatedId || !updatedName) {
      alert('Sila isi Staff User ID dan Display Name.');
      return;
    }

    // Clinic admins may promote/demote users within their own clinic only.
    // They cannot create or assign Super Admin access, or move accounts between clinics.
    if (currentUser?.role === UserRole.ADMIN) {
      if (
        editingUser.role === UserRole.SUPER_ADMIN ||
        editingUser.clinicId !== currentUser.clinicId
      ) {
        alert('Admin klinik hanya boleh mengurus akaun dalam klinik sendiri dengan role STAFF atau ADMIN.');
        return;
      }
    }

    // User IDs must be unique across all clinics, regardless of letter case.
    const duplicateUser = users.find(
      u => u.firestoreId !== editingUser.firestoreId &&
        u.id.trim().toLowerCase() === updatedId.toLowerCase()
    );
    if (duplicateUser) {
      alert(`Staff User ID "${updatedId}" sudah digunakan oleh akaun lain. Sila pilih ID yang berbeza.`);
      return;
    }

    setIsSavingStaff(true);
    try {
      const oldId = users.find(u => u.firestoreId === editingUser.firestoreId)?.id || editingUser.id;
      const updatedUserData: any = {
        id: updatedId,
        // Only Super Admin can assign Super Admin; clinic admins can assign STAFF/ADMIN within their clinic.
        role: currentUser?.role === UserRole.SUPER_ADMIN
          ? editingUser.role
          : (editingUser.role === UserRole.ADMIN ? UserRole.ADMIN : UserRole.STAFF),
        clinicId: currentUser?.role === UserRole.SUPER_ADMIN && editingUser.role === UserRole.SUPER_ADMIN
          ? null
          : (currentUser?.role === UserRole.ADMIN ? currentUser.clinicId : editingUser.clinicId),
        displayName: updatedName,
        ...(editingUser.department ? { department: editingUser.department } : {}),
        ...(newStaffPass.trim() ? { password: newStaffPass.trim() } : {}),
      };
      await updateDoc(doc(db, "users", editingUser.firestoreId), updatedUserData);

      const savedUser: User = { ...editingUser, ...updatedUserData };
      addActivityLog('Updated Staff Account', `${updatedName} (${updatedId})`);

      if (currentUser && (currentUser.firestoreId === editingUser.firestoreId || currentUser.id === oldId)) {
        setCurrentUser(savedUser);
      }

      setEditingUser(null);
      setShowStaffForm(false);
      setNewStaffPass('');
      setShowStaffPassword(false);
    } catch (error) {
      console.error('Failed to update staff account', error);
      alert('Gagal mengemas kini akaun. Sila cuba lagi.');
    } finally {
      setIsSavingStaff(false);
    }
  };

  const handleAccountUpdate = async () => {

  if (!currentUser?.firestoreId) return;

  // Verify current password
  if (currentPasswordInput !== currentUser.password) {

    alert('Current password is incorrect');

    return;

  }

  // Check password confirmation
  if (newPasswordInput !== confirmPasswordInput) {

    alert('New passwords do not match');

    return;

  }

  // Password minimum length
  if (newPasswordInput.length < 4) {

    alert('Password must be at least 4 characters');

    return;

  }

  try {

    setIsSavingAccount(true);

    await updateDoc(
      doc(db, "users", currentUser.firestoreId),
      {

        displayName: newDisplayName,

        password: newPasswordInput

      }
    );

    // Update current user locally
    setCurrentUser({
      ...currentUser,
      displayName: newDisplayName,
      password: newPasswordInput
    });

    addActivityLog('Updated Own Account', `${newDisplayName} (${currentUser.id})`, newDisplayName);

    // Clear fields
    setCurrentPasswordInput('');
    setNewPasswordInput('');
    setConfirmPasswordInput('');

    setShowAccountSettings(false);

    setShowAccountSuccess(true);

setTimeout(() => {

  setShowAccountSuccess(false);

}, 2000);

  } catch (error) {

    console.error(error);

    alert('Failed to update account');

  } finally {

    setIsSavingAccount(false);

  }

};

  const removeStaffMember = (id: string) => {
    if (id === 'admin') return;
    const userToRemove = users.find(
  u => u.id === id
);

if (!userToRemove?.firestoreId) return;

deleteDoc(
  doc(
    db,
    "users",
    userToRemove.firestoreId
  )
);
    addActivityLog('Deleted Staff Account', `${userToRemove.displayName} (${userToRemove.id})`);
    setUserToDelete(null);
  };

  // Appointment Handlers
  
  const compressImage = (
  file: File,
  maxWidth = 2560,
  quality = 0.92
): Promise<File> => {
  return new Promise((resolve, reject) => {
    const img = new Image();

    img.onload = () => {
      const canvas = document.createElement("canvas");

      let { width, height } = img;

      if (width > maxWidth) {
        height = Math.round((height * maxWidth) / width);
        width = maxWidth;
      }

      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext("2d");

      if (!ctx) {
        reject("Canvas error");
        return;
      }

      ctx.drawImage(img, 0, 0, width, height);

      canvas.toBlob(
        blob => {
          if (!blob) {
            reject("Compression failed");
            return;
          }

          resolve(
            new File([blob], file.name, {
              type: "image/jpeg",
              lastModified: Date.now(),
            })
          );
        },
        "image/jpeg",
        quality
      );
    };

    img.onerror = reject;

    img.src = URL.createObjectURL(file);
  });
};

  const uploadToCloudinary = async (file: File) => {

  // Compress image first
  const compressedFile = await compressImage(file);

  console.log(
    "Original:",
    (file.size / 1024 / 1024).toFixed(2),
    "MB"
  );

  console.log(
    "Compressed:",
    (compressedFile.size / 1024 / 1024).toFixed(2),
    "MB"
  );

  const formData = new FormData();

  formData.append("file", compressedFile);
  formData.append("upload_preset", "fundus_upload");

  const response = await fetch(
    "https://api.cloudinary.com/v1_1/dkz7ubrr8/image/upload",
    {
      method: "POST",
      body: formData
    }
  );

  const data = await response.json();

  return {
    url: data.secure_url,
    publicId: data.public_id
  };
};

  const handleImageUpload = (id: string, eye: 'right' | 'left', e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const uploadImage = async () => {

  try {

  setUploadingImageId(`${id}-${eye}`);

  const image = await uploadToCloudinary(file);

    const appToUpdate = appointments.find(
  app =>
    app.id === id ||
    app.firestoreId === id
);

if (!appToUpdate?.firestoreId) {
  console.log("NO FIRESTORE ID");
  return;
}

    const rightCompleted =
  eye === "right"
    ? true
    : !!appToUpdate?.rightEyePhoto ||
      appToUpdate?.rightEyeImageStatus === "Not Obtainable";

const leftCompleted =
  eye === "left"
    ? true
    : !!appToUpdate?.leftEyePhoto ||
      appToUpdate?.leftEyeImageStatus === "Not Obtainable";

let nextStatus = appToUpdate?.status;

if (rightCompleted && leftCompleted) {
  nextStatus = AppointmentStatus.DONE_FUNDUS;
}
    const updatedData = {

  status: nextStatus,

  [eye === 'right'
    ? 'rightEyePhoto'
    : 'leftEyePhoto'
  ]: image.url,

  [eye === 'right'
    ? 'rightEyePhotoPublicId'
    : 'leftEyePhotoPublicId'
  ]: image.publicId,

  [eye === 'right'
    ? 'rightEyeUploadedBy'
    : 'leftEyeUploadedBy'
  ]: currentUser?.id || 'UNKNOWN',

  [eye === 'right'
    ? 'rightEyePhotoUploadedAt'
    : 'leftEyePhotoUploadedAt'
  ]: Date.now(),

  updatedBy: currentUser?.id || 'unknown',
  updatedAt: Date.now()
};

    await updateDoc(
  doc(
    db,
    "appointments",
    appToUpdate.firestoreId
  ),
  updatedData
);

addActivityLog(
  `Uploaded ${eye === 'right' ? 'Right Eye' : 'Left Eye'} Fundus Image`,
  appToUpdate.patientName || '-'
);

  } catch (e) {

    console.error(
      "Image upload failed",
      e
    );

  } finally {

    await new Promise(resolve => setTimeout(resolve, 300));
    setUploadingImageId(null);

}

};

uploadImage();
    }
  };

  const removeImage = (id: string, eye: 'right' | 'left') => {
    const appToUpdate = appointments.find(app => app && app.id === id);
    setAppointments(prev => (prev || []).map(app => 
      (app && app.id === id) ? { ...app, [eye === 'right' ? 'rightEyePhoto' : 'leftEyePhoto']: undefined } : app
    ));
    addActivityLog(
      `Removed ${eye === 'right' ? 'Right Eye' : 'Left Eye'} Fundus Image`,
      appToUpdate?.patientName || '-'
    );
  };

  const saveReview = async (
  id: string,
  rightReview: string,
  leftReview: string,
  rightDetails?: Appointment['rightEyeReviewDetails'],
  leftDetails?: Appointment['leftEyeReviewDetails']
) => {

  try {

    setIsSavingReview(true);

    const appToUpdate = appointments.find(
      app =>
        app.id === id ||
        app.firestoreId === id
    );

    if (!appToUpdate?.firestoreId) return;

    const isEditedReview =
      !!selectedPhotoApp?.app?.rightEyeReview ||
      !!selectedPhotoApp?.app?.leftEyeReview;

    const rightCompleted =
  !!appToUpdate.rightEyePhoto ||
  appToUpdate.rightEyeImageStatus === "Not Obtainable";

const leftCompleted =
  !!appToUpdate.leftEyePhoto ||
  appToUpdate.leftEyeImageStatus === "Not Obtainable";

const hasFundusCompleted =
  rightCompleted &&
  leftCompleted;

const hasReviews =
  isReviewCompleted({
    ...appToUpdate,
    rightEyeReview: rightReview,
    leftEyeReview: leftReview,
    rightEyeReviewDetails: rightDetails,
    leftEyeReviewDetails: leftDetails
  });

let nextStatus =
  AppointmentStatus.DONE_FUNDUS;

if (
  hasFundusCompleted &&
  hasReviews
) {
  nextStatus =
    AppointmentStatus.DONE;
}

    await updateDoc(
      doc(
        db,
        "appointments",
        appToUpdate.firestoreId
      ),
      {

        rightEyeReview: rightReview,
        leftEyeReview: leftReview,

        rightEyeReviewDetails: rightDetails,
        leftEyeReviewDetails: leftDetails,

        status: nextStatus,

        updatedBy:
          currentUser?.id || 'unknown',

        updatedAt: Date.now(),

referred: isReferred,

referralComment: isReferred
  ? referralComment.trim()
  : '',

isEdited:
  isEditedReview

      }
    );

    addActivityLog(
      isEditedReview ? 'Edited Clinical Review' : 'Saved Clinical Review',
      appToUpdate.patientName || '-'
    );

    setIsReviewViewMode(true);

    setRightEyeAIResult(null);
    setLeftEyeAIResult(null);
    setSelectedPhotoApp(null);

  } catch (e) {

  console.error(
    "Failed to save review",
    e
  );

} finally {

  setIsSavingReview(false);

}

};

  const exportToCSV = () => {
    if (!appointments || appointments.length === 0) return;
    
    const headers = ['Date', 'Patient Name', 'IC Number', 'Phone', 'Diseases', 'Status', 'Right Eye Review', 'Left Eye Review', 'Created By'];
    const month = selectedAnalyticsMonth.getMonth();
const year = selectedAnalyticsMonth.getFullYear();

const monthlyAppointments = visibleAppointments.filter(app => {
  if (!app || !app.date) return false;

  const d = new Date(app.date);

  return (
    d.getMonth() === month &&
    d.getFullYear() === year &&
    isAnalyticsDateReached(app.date)
  );
});

const rows = monthlyAppointments.map(app => [
  app.date || '',
  app.patientName || '',
  app.icNumber || '',
  app.phoneNumber || '',
  (app.diseaseTypes || []).join('; ') +
    (app.otherDisease ? `; ${app.otherDisease}` : ''),
  app.status || '',
  (app.rightEyeReview || '').replace(/,/g, ' '),
  (app.leftEyeReview || '').replace(/,/g, ' '),
  app.createdBy || ''
]);

    const csvContent = [headers, ...rows].map(e => e.join(",")).join("\n");
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    const fileMonth = selectedAnalyticsMonth.toLocaleString(
  "en-US",
  {
    month: "long",
    year: "numeric"
  }
).replace(" ", "_");

link.setAttribute(
  "download",
  `Klinik_Kesihatan_Lintang_Fundus_Report_${fileMonth}.csv`
);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    addActivityLog(
  'Exported Monthly Summary CSV',
  `${monthlyAppointments.length} records`
);
  };

  //--- Convert Vite logo assets into data URLs so jsPDF can embed the SINAR branding ---//
  const loadPdfImage = async (src: string): Promise<string | null> => {
    try {
      const response = await fetch(src);
      const blob = await response.blob();

      return await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : null);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    } catch {
      return null;
    }
  };

  //--- Open a print-only completion popup. These values are used for this PDF only. ---//
  const printPatientReport = (app: Appointment) => {
    setReportActionMode('print');
    setShowReferralClinicPicker(false);
    setPrintReportFields({
      ...(app.referralFormFields || {}),
      dmDuration: app.referralFormFields?.dmDuration || '', hba1c: app.referralFormFields?.hba1c || '', urineAlbumin: app.referralFormFields?.urineAlbumin || '', serumCreatinine: app.referralFormFields?.serumCreatinine || '', history: app.referralFormFields?.history || '',
      otherDiseases: app.referralFormFields?.otherDiseases || [...(app.diseaseTypes || []), app.otherDisease].filter(Boolean).join(', '),
      rightEyeVAUnaided: app.rightEyeVAUnaided || '', leftEyeVAUnaided: app.leftEyeVAUnaided || '',
      rightEyeVAWithGlasses: app.rightEyeVAWithGlasses || '', leftEyeVAWithGlasses: app.leftEyeVAWithGlasses || '',
      rightEyeVAPinhole: app.rightEyeVAPinhole || '', leftEyeVAPinhole: app.leftEyeVAPinhole || '',
      staffName: app.referralFormFields?.staffName || '', staffDesignation: app.referralFormFields?.staffDesignation || '', staffStamp: app.referralFormFields?.staffStamp || '', staffDate: app.referralFormFields?.staffDate || new Date().toLocaleDateString('en-GB'),
      ophthalmologyReport: app.referralFormFields?.ophthalmologyReport || '', ophthalmologyRecommendation: app.referralFormFields?.ophthalmologyRecommendation || '', ophthalmologyAppointment: app.referralFormFields?.ophthalmologyAppointment || '',
      ophthalmologySignature: app.referralFormFields?.ophthalmologySignature || '', ophthalmologyStamp: app.referralFormFields?.ophthalmologyStamp || '', ophthalmologyDate: app.referralFormFields?.ophthalmologyDate || '', referralReason: app.referralFormFields?.referralReason || app.referralComment || '',
      // Returned specialist report is authoritative for Section 6 and must override any old blank print fields.
      ...((app as any).specialistReport || {})
    });
    setPrintReportApp(app);
  };

  //--- Open the same editable report form in referral mode; this does not change clinical-review saving. ---//
  const startPatientReferral = (app: Appointment) => {
    // Specialist referrals are restricted to clinic Admin and Super Admin accounts.
    if (currentUser?.role !== UserRole.ADMIN && currentUser?.role !== UserRole.SUPER_ADMIN) {
      alert('Hanya Admin boleh menghantar referral kepada klinik pakar.');
      return;
    }
    if (!isReviewCompleted(app)) {
      alert('Sila lengkapkan clinical review kedua-dua mata dahulu.');
      return;
    }
    if (app.referred !== true) {
      alert('Tandakan Kes Dirujuk semasa Clinical Review dan simpan dahulu sebelum menghantar referral.');
      return;
    }
    setReportActionMode('refer');
    setSelectedReferralClinicId('');
    setShowReferralClinicPicker(false);
    setPrintReportFields({
      ...(app.referralFormFields || {}),
      dmDuration: app.referralFormFields?.dmDuration || '', hba1c: app.referralFormFields?.hba1c || '', urineAlbumin: app.referralFormFields?.urineAlbumin || '', serumCreatinine: app.referralFormFields?.serumCreatinine || '', history: app.referralFormFields?.history || '',
      otherDiseases: app.referralFormFields?.otherDiseases || [...(app.diseaseTypes || []), app.otherDisease].filter(Boolean).join(', '),
      rightEyeVAUnaided: app.rightEyeVAUnaided || '', leftEyeVAUnaided: app.leftEyeVAUnaided || '',
      rightEyeVAWithGlasses: app.rightEyeVAWithGlasses || '', leftEyeVAWithGlasses: app.leftEyeVAWithGlasses || '',
      rightEyeVAPinhole: app.rightEyeVAPinhole || '', leftEyeVAPinhole: app.leftEyeVAPinhole || '',
      staffName: app.referralFormFields?.staffName || '', staffDesignation: app.referralFormFields?.staffDesignation || '', staffStamp: app.referralFormFields?.staffStamp || '', staffDate: app.referralFormFields?.staffDate || new Date().toLocaleDateString('en-GB'),
      ophthalmologyReport: app.referralFormFields?.ophthalmologyReport || '', ophthalmologyRecommendation: app.referralFormFields?.ophthalmologyRecommendation || '', ophthalmologyAppointment: app.referralFormFields?.ophthalmologyAppointment || '',
      ophthalmologySignature: app.referralFormFields?.ophthalmologySignature || '', ophthalmologyStamp: app.referralFormFields?.ophthalmologyStamp || '', ophthalmologyDate: app.referralFormFields?.ophthalmologyDate || '', referralReason: app.referralFormFields?.referralReason || app.referralComment || ''
    });
    setPrintReportApp(app);
  };

  const sendPatientReferral = async () => {
    const app = printReportApp;
    const targetClinic = specialistClinics.find(clinic => clinic.id === selectedReferralClinicId && clinic.active);
    if (!app || !targetClinic) {
      alert('Sila pilih klinik pakar yang aktif.');
      return;
    }
    if (!(currentClinic?.specialistClinicIds || []).includes(targetClinic.id)) {
      alert('Klinik anda tidak dibenarkan merujuk ke klinik pakar ini. Sila hubungi Super Admin.');
      return;
    }
    if (!currentUser || !currentClinic) {
      alert('Maklumat klinik asal tidak dapat dikenal pasti. Sila log masuk semula.');
      return;
    }
    setIsSendingReferral(true);
    try {
      const appointmentDocId = app.firestoreId || app.id;
      // Persist the completed referral form against the original appointment first.
      // These are additive fields; existing clinical-review data is left untouched.
      if (appointmentDocId) {
        await updateDoc(doc(db, 'appointments', appointmentDocId), {
          referralFormFields: { ...printReportFields },
          referralFormUpdatedAt: Date.now(),
          referralFormUpdatedBy: currentUser.displayName || currentUser.id,
          updatedAt: Date.now(),
        });
      } else {
        throw new Error('Appointment Firestore document ID is missing; cannot safely persist referral form.');
      }
      const referralPayload = {
        patientName: app.patientName || '',
        icNumber: app.icNumber || '',
        phoneNumber: app.phoneNumber || '',
        date: app.date || '',
        appointmentId: app.firestoreId || app.id,
        referringClinicId: currentClinic.id,
        referringClinicName: currentClinic.name,
        fromClinicId: currentClinic.id,
        fromClinicName: currentClinic.name,
        specialistClinicId: targetClinic.id,
        specialistClinicName: targetClinic.name,
        referralReason: (printReportFields.referralReason || app.referralComment || '').trim(),
        reason: (printReportFields.referralReason || app.referralComment || '').trim(),
        notes: (printReportFields.history || '').trim(),
        formFields: { ...printReportFields },
        patient: {
          name: app.patientName || '',
          icNumber: app.icNumber || '',
          phoneNumber: app.phoneNumber || '',
        },
        appointmentSnapshot: {
          patientName: app.patientName || '',
          icNumber: app.icNumber || '',
          phoneNumber: app.phoneNumber || '',
          clinicName: currentClinic.name || '',
          date: app.date || '',
          referred: app.referred === true,
          referralComment: (printReportFields.referralReason || app.referralComment || '').trim(),
          diseaseTypes: app.diseaseTypes || [],
          otherDisease: app.otherDisease || '',
          rightEyeVAUnaided: app.rightEyeVAUnaided || '',
          leftEyeVAUnaided: app.leftEyeVAUnaided || '',
          rightEyeVAWithGlasses: app.rightEyeVAWithGlasses || '',
          leftEyeVAWithGlasses: app.leftEyeVAWithGlasses || '',
          rightEyeVAPinhole: app.rightEyeVAPinhole || '',
          leftEyeVAPinhole: app.leftEyeVAPinhole || '',
          rightEyePhoto: app.rightEyePhoto || '',
          leftEyePhoto: app.leftEyePhoto || '',
          rightEyeUploadedBy: app.rightEyeUploadedBy || '',
          leftEyeUploadedBy: app.leftEyeUploadedBy || '',
          rightEyePhotoUploadedAt: app.rightEyePhotoUploadedAt || null,
          leftEyePhotoUploadedAt: app.leftEyePhotoUploadedAt || null,
          rightEyeImageStatus: app.rightEyeImageStatus || '',
          leftEyeImageStatus: app.leftEyeImageStatus || '',
          rightEyeImageReason: app.rightEyeImageReason || '',
          leftEyeImageReason: app.leftEyeImageReason || '',
          rightEyeReview: app.rightEyeReview || '',
          leftEyeReview: app.leftEyeReview || '',
          rightEyeReviewDetails: app.rightEyeReviewDetails || null,
          leftEyeReviewDetails: app.leftEyeReviewDetails || null,
        },
        status: 'New',
        createdAt: Date.now(),
        referredAt: Date.now(),
        referredBy: currentUser.displayName || currentUser.id,
        updatedAt: Date.now(),
      };
      await addDoc(collection(db, 'specialistReferrals'), referralPayload);
      if (appointmentDocId) {
        await updateDoc(doc(db, 'appointments', appointmentDocId), {
          referralSent: true,
          specialistClinicId: targetClinic.id,
          specialistClinicName: targetClinic.name,
          referralSentAt: Date.now(),
          referralComment: referralPayload.referralReason,
          updatedAt: Date.now(),
        });
      }
      addActivityLog('Sent Specialist Referral', `${app.patientName || '-'} → ${targetClinic.name}`);
      setShowReferralClinicPicker(false);
      setPrintReportApp(null);
      alert(`Referral berjaya dihantar ke ${targetClinic.name}.`);
    } catch (error) {
      console.error('Failed to send specialist referral', error);
      alert('Referral tidak berjaya dihantar. Sila semak sambungan dan kebenaran Firestore.');
    } finally {
      setIsSendingReferral(false);
    }
  };

  //--- Generate A4 PDF using saved patient data plus temporary print-only popup values. ---//
  const generatePatientReport = async (app: Appointment, fields: Record<string, string>) => {
    setIsGeneratingPatientReport(true);
    try {
      // Specialist findings are saved on the appointment when the referral is returned.
      // They take precedence over temporary print-popup values for Section 6 only.
      const returnedSpecialistReport = (app as any).specialistReport || {};
      const hasDigitalSpecialistReport = Boolean(
        ((app as any).specialistReportStatus === 'Returned' || (app as any).specialistReportReturnedAt) &&
        String(returnedSpecialistReport.ophthalmologyDoctorName || '').trim()
      );
      fields = { ...fields, ...returnedSpecialistReport };
      const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      const margin = 10;
      const contentWidth = pageWidth - margin * 2;
      const navy: [number, number, number] = [20, 48, 88];
      const blue: [number, number, number] = [44, 105, 180];
      const paleBlue: [number, number, number] = [220, 234, 248];
      const lineColor: [number, number, number] = [160, 181, 205];
      const muted: [number, number, number] = [88, 105, 128];
      const ink: [number, number, number] = [30, 41, 59];
      let y = 8;

      const line = (x1: number, y1: number, x2: number, y2: number) => {
        doc.setDrawColor(...lineColor);
        doc.setLineWidth(0.22);
        doc.line(x1, y1, x2, y2);
      };
      const valueOrBlank = (value: unknown) => String(value ?? '').trim();
      const formatDateDDMMYYYY = (value: unknown) => {
        const raw = valueOrBlank(value);
        if (!raw) return '';
        // Handle HTML date-input values without timezone conversion.
        const isoDate = raw.match(/^(\\d{4})-(\\d{2})-(\\d{2})$/);
        if (isoDate) return `${isoDate[3]}/${isoDate[2]}/${isoDate[1]}`;
        // Preserve Malaysian day/month/year values that are already formatted.
        const localDate = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (localDate) return `${localDate[1].padStart(2, '0')}/${localDate[2].padStart(2, '0')}/${localDate[3]}`;
        const parsed = new Date(raw);
        return Number.isNaN(parsed.getTime()) ? raw : parsed.toLocaleDateString('en-GB');
      };
      const blankField = (label: string, x: number, yy: number, width: number, value?: unknown, lineY = 5.5, underlineFilled = false) => {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.2);
        doc.setTextColor(...ink);
        const labelText = `${label}:`;
        doc.text(labelText, x, yy);
        const labelW = Math.min(doc.getTextWidth(labelText) + 1.5, width * 0.46);
        const val = valueOrBlank(value);
        if (val) {
          doc.setFont('helvetica', 'bold');
          doc.text(doc.splitTextToSize(val, Math.max(5, width - labelW)).slice(0, 2), x + labelW, yy);
        }
        if (!val || underlineFilled) {
          // Keep a form-style writing line, including beneath prefilled patient/staff values.
          line(x + labelW, yy + (underlineFilled ? 1.25 : 0.55), x + width, yy + (underlineFilled ? 1.25 : 0.55));
        }
      };
      const section = (number: number, title: string) => {
        doc.setFillColor(...paleBlue);
        doc.roundedRect(margin, y, contentWidth, 7, 1.5, 1.5, 'F');
        doc.setFillColor(...navy);
        doc.circle(margin + 4.1, y + 3.5, 2.35, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(6.8);
        doc.text(String(number), margin + 4.1, y + 4.1, { align: 'center' });
        doc.setTextColor(...navy);
        doc.setFontSize(7.7);
        doc.text(title.toUpperCase(), margin + 8, y + 4.6);
        y += 10;
      };
      const eyeFinding = (eye: 'right' | 'left') => {
        const details = eye === 'right' ? app.rightEyeReviewDetails : app.leftEyeReviewDetails;
        const review = eye === 'right' ? app.rightEyeReview : app.leftEyeReview;
        const imageStatus = eye === 'right' ? app.rightEyeImageStatus : app.leftEyeImageStatus;
        const imageReason = eye === 'right' ? app.rightEyeImageReason : app.leftEyeImageReason;
        if (imageStatus === 'Not Obtainable') return { status: '', abnormal: false, ungradable: false, types: [] as string[], severity: '', others: imageReason || 'Imej tidak dapat diperoleh', comment: '' };
        return {
          status: details?.status || review || '',
          abnormal: (details?.status || review || '').toLowerCase() === 'abnormal',
          ungradable: (details?.status || review || '').toLowerCase() === 'ungradable',
          types: details?.abnormalTypes || [],
          severity: details?.npdrSeverity || '',
          others: details?.othersText || '',
          comment: details?.comment || ''
        };
      };
      const checkbox = (x: number, yy: number, label: string, checked: boolean, labelSize = 6.5) => {
        doc.setDrawColor(80, 95, 112);
        doc.setLineWidth(0.25);
        doc.rect(x, yy - 2.3, 3, 3);
        if (checked) {
          doc.setDrawColor(...blue);
          doc.line(x + 0.5, yy - 0.8, x + 1.2, yy - 0.1);
          doc.line(x + 1.2, yy - 0.1, x + 2.6, yy - 2);
        }
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(labelSize);
        doc.setTextColor(...ink);
        doc.text(label, x + 4.5, yy);
      };
      const logo = await loadPdfImage(roundLogo);
      const sinarWordmark = await loadPdfImage(textLogo);
      // Align the PDF header with the popup preview: fixed-width logo column,
      // undistorted logo assets, and title/clinic details centered in the remaining column.
      // Match the popup header dimensions in A4 units (popup is laid out in CSS pixels).
      // Logo column: 76px, gap: 12px, round logo: 48px, wordmark: max 76px x 16px.
      const pxToMm = (px: number) => px * 25.4 / 96;
      const headerLogoColW = pxToMm(76);
      const headerGap = pxToMm(12);
      const headerTextW = contentWidth - headerLogoColW - headerGap;
      const headerTextCenterX = margin + headerLogoColW + headerGap + headerTextW / 2;
      if (logo) {
        try { doc.addImage(logo, logo.startsWith('data:image/png') ? 'PNG' : 'JPEG', margin + (headerLogoColW - pxToMm(48)) / 2, y, pxToMm(48), pxToMm(48)); } catch { /* continue without logo */ }
      }
      if (sinarWordmark) {
        try {
          // CSS object-contain equivalent: fit the wordmark inside 76x16px without stretching it.
          const wordmarkProps = doc.getImageProperties(sinarWordmark);
          const wordmarkMaxW = pxToMm(76);
          const wordmarkMaxH = pxToMm(16);
          const wordmarkScale = Math.min(wordmarkMaxW / wordmarkProps.width, wordmarkMaxH / wordmarkProps.height);
          const wordmarkW = wordmarkProps.width * wordmarkScale;
          const wordmarkH = wordmarkProps.height * wordmarkScale;
          doc.addImage(sinarWordmark, 'PNG', margin + (headerLogoColW - wordmarkW) / 2, y + pxToMm(48 + 4 + (16 - wordmarkH * 96 / 25.4) / 2), wordmarkW, wordmarkH);
        } catch { /* continue without wordmark */ }
      }
      // This text stack mirrors the preview's centered title/name/address/phone block.
      doc.setTextColor(...navy);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(12); // popup: text-base on desktop
      doc.text('REKOD PEMERIKSAAN FUNDUS & RUJUKAN', headerTextCenterX, y + 5, { align: 'center' });
      const reportClinic = getClinicById(clinics, superAdminClinicContext || currentUser?.clinicId) || currentClinic;
      const reportClinicName = reportClinic?.name || reportClinic?.shortName || reportClinic?.id || '';
      const reportClinicAddress = String(reportClinic?.address || '').trim();
      const reportClinicPhone = String(reportClinic?.phone || '').trim();
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5); // popup: 10px
      doc.setTextColor(...muted);
      if (reportClinicName) {
        doc.text(doc.splitTextToSize(reportClinicName, headerTextW).slice(0, 1), headerTextCenterX, y + 9.2, { align: 'center' });
      }
      let clinicHeaderY = y + 12.0; // address starts after the same small gap as preview
      if (reportClinicAddress) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(6.75); // popup: 9px
        const addressLines = reportClinicAddress.split(/\r?\n/).flatMap(line => doc.splitTextToSize(line.trim(), headerTextW));
        const visibleAddressLines = addressLines.filter(Boolean); // preserve every address line
        visibleAddressLines.forEach((addressLine, index) => {
          doc.text(addressLine, headerTextCenterX, clinicHeaderY + index * pxToMm(11), { align: 'center' });
        });
        if (visibleAddressLines.length) clinicHeaderY += visibleAddressLines.length * pxToMm(11);
      }
      if (reportClinicPhone) {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(6.75);
        doc.text(`Tel: ${reportClinicPhone}`, headerTextCenterX, clinicHeaderY, { align: 'center' });
        clinicHeaderY += pxToMm(13);
      }
      // Popup header uses 12px bottom padding and a 3px navy divider.
      y += Math.max(pxToMm(80), clinicHeaderY - y + pxToMm(8));
      doc.setDrawColor(...navy);
      doc.setLineWidth(0.8);
      doc.line(margin, y, pageWidth - margin, y);
      doc.setLineWidth(0.22);
      y += 4;

      // 1. Patient information: fields without saved values deliberately remain blank for handwriting.
      section(1, 'Maklumat Pesakit');
      const gap = 5;
      const colW = (contentWidth - gap) / 2;
      blankField('Nama Pesakit', margin + 2, y, colW - 2, app.patientName, 5.5, true); 
      blankField('No. K/P', margin + colW + gap, y, colW - 2, app.icNumber, 5.5, true); y += 7;
      blankField('Klinik Kesihatan (Asal)', margin + 2, y, colW - 2, getClinicById(clinics, getReferringClinicId(app))?.name || '', 5.5, true);
      blankField('No. Telefon', margin + colW + gap, y, colW - 2, app.phoneNumber, 5.5, true); y += 7;
      const patientInfoX = margin + 2;
      const rightInfoX = margin + colW + gap;
      const compactFieldW = colW * 0.68;
      blankField('Diabetes Mellitus sejak', patientInfoX, y, compactFieldW, fields.dmDuration, 5.5, true);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.2); doc.setTextColor(...ink);
      blankField('HbA1c', rightInfoX, y, colW - 2, fields.hba1c, 5.5, true); y += 7;
      blankField('Penyakit Lain', margin + 2, y, colW - 2, fields.otherDiseases || '', 5.5, true);
      blankField('Tarikh Pemeriksaan', rightInfoX, y, colW - 2, formatDateDDMMYYYY(app.date), 5.5, true); y += 7;
      blankField('Sejarah ringkas', margin + 2, y, contentWidth - 4, fields.history, 5.5, true); y += 7;

      // 2. Visual acuity: show saved values and leave all missing entries writable.
      section(2, 'Visual Acuity (V/A)');
      const tx = margin + 2;
      const tw = contentWidth - 4;
      const labelW = tw * 0.36;
      const eyeW = (tw - labelW) / 2;
      doc.setFillColor(243, 247, 252);
      doc.rect(tx, y, tw, 6.2, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(6.7); doc.setTextColor(...navy);
      doc.text('PEMERIKSAAN', tx + 3, y + 4.1);
      doc.text('RE (MATA KANAN)', tx + labelW + eyeW / 2, y + 4.1, { align: 'center' });
      doc.text('LE (MATA KIRI)', tx + labelW + eyeW + eyeW / 2, y + 4.1, { align: 'center' });
      y += 6.2;
      const vaRows: [string, unknown, unknown][] = [
        ['Unaided', fields.rightEyeVAUnaided, fields.leftEyeVAUnaided],
        ['With Glasses', fields.rightEyeVAWithGlasses, fields.leftEyeVAWithGlasses],
        ['Pinhole', fields.rightEyeVAPinhole, fields.leftEyeVAPinhole]
      ];
      vaRows.forEach(([label, right, left]) => {
        line(tx, y + 6, tx + tw, y + 6);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(...ink);
        doc.text(label, tx + 3, y + 4);
        const rv = valueOrBlank(right); const lv = valueOrBlank(left);
        if (rv) doc.text(rv, tx + labelW + eyeW / 2, y + 4, { align: 'center' }); else line(tx + labelW + 8, y + 4.5, tx + labelW + eyeW - 8, y + 4.5);
        if (lv) doc.text(lv, tx + labelW + eyeW + eyeW / 2, y + 4, { align: 'center' }); else line(tx + labelW + eyeW + 8, y + 4.5, tx + tw - 8, y + 4.5);
        y += 6;
      });
      // Enclose only the header and three V/A rows; avoid an unnecessary fourth blank row.
      doc.setDrawColor(...lineColor); doc.rect(tx, y - 18, tw, 18);
      doc.line(tx + labelW, y - 18, tx + labelW, y);
      doc.line(tx + labelW + eyeW, y - 18, tx + labelW + eyeW, y);
      y += 4;

      // 3. Fundus photographs, each with upload date and staff fields.
      section(3, 'Gambar Fundus');
      const photoGap = 5;
      const photoW = (contentWidth - photoGap) / 2;
      const photoH = 55;
      const rightPhoto = app.rightEyePhoto ? await loadPdfImage(app.rightEyePhoto) : null;
      const leftPhoto = app.leftEyePhoto ? await loadPdfImage(app.leftEyePhoto) : null;
      const photoBoxes = [
        { x: margin, title: 'MATA KANAN (RE)', data: rightPhoto, uploadedBy: app.rightEyeUploadedBy, uploadedAt: app.rightEyePhotoUploadedAt },
        { x: margin + photoW + photoGap, title: 'MATA KIRI (LE)', data: leftPhoto, uploadedBy: app.leftEyeUploadedBy, uploadedAt: app.leftEyePhotoUploadedAt }
      ];
      photoBoxes.forEach(photo => {
        doc.setDrawColor(...lineColor); doc.roundedRect(photo.x, y, photoW, photoH + 17, 1.8, 1.8, 'S');
        doc.setFont('helvetica', 'bold'); doc.setFontSize(6.8); doc.setTextColor(...navy);
        doc.text(photo.title, photo.x + photoW / 2, y + 4.5, { align: 'center' });
        if (photo.data) {
          try {
            const format = photo.data.startsWith('data:image/png') ? 'PNG' : 'JPEG';
            const imgW = 59; const imgH = 49;
            doc.addImage(photo.data, format, photo.x + (photoW - imgW) / 2, y + 6, imgW, imgH, undefined, 'FAST');
          } catch (error) { console.warn('Could not embed fundus photo in PDF', error); }
        } else {
          doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(...muted);
          doc.text('Tiada gambar fundus', photo.x + photoW / 2, y + 27, { align: 'center' });
        }
        doc.setFont('helvetica', 'normal'); doc.setFontSize(6.2); doc.setTextColor(...ink);
        const uploadedAtText = photo.uploadedAt ? new Date(photo.uploadedAt).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
        doc.text(`Tarikh / masa imej: ${uploadedAtText || '____ / ____ / ______  ______'}`, photo.x + photoW / 2, y + 60, { align: 'center' });
        doc.text(`Dimuat naik oleh: ${photo.uploadedBy ? getUserDisplayName(photo.uploadedBy) : '________________'}`, photo.x + photoW / 2, y + 64, { align: 'center' });
      });
      y += photoH + 21;

      // 4. Examination findings — match the compact two-card layout in the print preview.
      section(4, 'Dapatan Pemeriksaan');
      const findingGap = 5;
      const findingW = (contentWidth - findingGap) / 2;
      const eyeSummary = (eye: 'right' | 'left') => {
        const details = eye === 'right' ? app.rightEyeReviewDetails : app.leftEyeReviewDetails;
        const review = eye === 'right' ? app.rightEyeReview : app.leftEyeReview;
        const imageStatus = eye === 'right' ? app.rightEyeImageStatus : app.leftEyeImageStatus;
        const imageReason = eye === 'right' ? app.rightEyeImageReason : app.leftEyeImageReason;
        return {
          title: eye === 'right' ? 'MATA KANAN (RE)' : 'MATA KIRI (LE)',
          status: imageStatus === 'Not Obtainable'
            ? `Not Obtainable${imageReason ? ` — ${imageReason}` : ''}`
            : (details?.status || review || 'Belum direkodkan'),
          types: (details?.abnormalTypes || []).join(', '),
          severity: details?.npdrSeverity || '',
          notes: [details?.othersText, details?.comment].filter(Boolean).join(' — ')
        };
      };
      const rightFinding = eyeSummary('right');
      const leftFinding = eyeSummary('left');
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.2);
      const findingRows = (finding: ReturnType<typeof eyeSummary>) => ([
        { label: 'Status:', value: finding.status || '—' },
        { label: 'Jenis abnormaliti:', value: finding.types || '—' },
        { label: 'NPDR severity:', value: finding.severity || '—' },
        { label: 'Catatan:', value: finding.notes || '—' }
      ]);
      const preparedFindingRows = [findingRows(rightFinding), findingRows(leftFinding)].map(rows =>
        rows.map(row => ({ ...row, lines: doc.splitTextToSize(row.value, findingW - 30) }))
      );
      const findingBodyLines = Math.max(...preparedFindingRows.map(rows => rows.reduce((sum, row) => sum + Math.max(1, row.lines.length), 0)));
      const findingHeaderH = 5.5;
      const findingLineH = 3.2;
      const findingHeight = findingHeaderH + 2 + findingBodyLines * findingLineH + 2;
      const drawEyeFindingSummary = (x: number, finding: ReturnType<typeof eyeSummary>, rows: typeof preparedFindingRows[number]) => {
        doc.setFillColor(243, 247, 252);
        doc.rect(x, y, findingW, findingHeaderH, 'F');
        doc.setFont('helvetica', 'bold'); doc.setFontSize(6.6); doc.setTextColor(...navy);
        doc.text(finding.title, x + 3, y + 3.8);
        let rowY = y + findingHeaderH + 3.2;
        rows.forEach(row => {
          doc.setFont('helvetica', 'bold'); doc.setFontSize(6.2); doc.setTextColor(...ink);
          doc.text(row.label, x + 3, rowY);
          doc.setFont('helvetica', 'normal');
          doc.text(row.lines, x + 27, rowY);
          rowY += Math.max(1, row.lines.length) * findingLineH;
        });
        doc.setDrawColor(...lineColor);
        doc.roundedRect(x, y, findingW, findingHeight, 1.2, 1.2, 'S');
      };
      drawEyeFindingSummary(margin, rightFinding, preparedFindingRows[0]);
      drawEyeFindingSummary(margin + findingW + findingGap, leftFinding, preparedFindingRows[1]);
      y += findingHeight + 3; y += 2;
      // Referral reason: wrap the full text across as many lines as needed (no 2-line truncation).
      blankField('Kes Dirujuk', margin + 2, y, 38, app.referred === true ? 'Ya' : app.referred === false ? 'Tidak' : '');
      const referralLabel = 'Jika Ya, nyatakan sebab:';
      const referralX = margin + 45;
      const referralTextX = referralX + 34;
      const referralTextWidth = Math.max(10, margin + contentWidth - referralTextX);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.2);
      doc.setTextColor(...ink);
      doc.text(referralLabel, referralX, y);
      const referralText = valueOrBlank(fields.referralReason);
      if (referralText) {
        doc.setFont('helvetica', 'bold');
        const referralLines = doc.splitTextToSize(referralText, referralTextWidth);
        doc.text(referralLines, referralTextX, y);
        // jsPDF's small-font line spacing is approximately 3.2 mm; reserve room for every line.
        y += Math.max(8, referralLines.length * 3.2 + 3);
      } else {
        line(referralTextX, y + 0.55, margin + contentWidth, y + 0.55);
        y += 8;
      }

      // 5. Referring staff verification — compact block on page 1.
      // Keep this section short so existing clinical content and fields remain unchanged.
      doc.setFillColor(...paleBlue);
      doc.roundedRect(margin, y, contentWidth, 7, 1.5, 1.5, 'F');
      doc.setFillColor(...navy);
      doc.circle(margin + 4.1, y + 3.5, 2.35, 'F');
      doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(6.8);
      doc.text('5', margin + 4.1, y + 4.1, { align: 'center' });
      doc.setTextColor(...navy); doc.setFontSize(7.7);
      doc.text('PENGESAHAN PETUGAS', margin + 8, y + 4.6);
      y += 11;
      blankField('Nama Petugas', margin + 2, y, colW - 2, fields.staffName, 5.5, true);
      blankField('Jawatan', margin + colW + gap, y, colW - 2, fields.staffDesignation, 5.5, true);
      y += 8;
      const staffColW = (contentWidth - 8) / 3;
      blankField('Tandatangan', margin + 2, y, staffColW, '');
      blankField('Cop Rasmi', margin + 4 + staffColW, y, staffColW, fields.staffStamp);
      blankField('Tarikh', margin + 6 + staffColW * 2, y, staffColW, fields.staffDate);
      y += 8;

      // Page 1 now contains sections 1–5. Specialist-only fields continue on page 2.
      doc.setFont('helvetica', 'normal'); doc.setFontSize(6); doc.setTextColor(...muted);
      doc.text(`Dijana oleh SINAR pada ${new Date().toLocaleString('en-GB')}`, pageWidth - margin, pageHeight - 5, { align: 'right' });
      doc.addPage();
      y = 12;
      doc.setTextColor(...navy); doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
      doc.text('SAMBUNGAN REKOD PEMERIKSAAN FUNDUS & RUJUKAN', margin, y);
      y += 6;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...muted);
      doc.text(`Nama: ${app.patientName || ''}    No. K/P: ${app.icNumber || ''}`, margin, y);
      y += 4;
      line(margin, y, pageWidth - margin, y);
      y += 5;

      // 6. Specialist report: returned text is printed directly above the original dotted writing lines.
      section(6, 'Untuk Kegunaan Pakar Oftalmologi'); y += 5;
      const drawRuledText = (label: string, value: unknown, rows: number) => {
        doc.setFont('helvetica', 'bold'); doc.setFontSize(7.2); doc.setTextColor(...ink);
        doc.text(`${label}:`, margin + 2, y);
        y += 3;
        const textValue = valueOrBlank(value);
        const availableW = contentWidth - 4;
        const wrapped = textValue ? doc.splitTextToSize(textValue, availableW) : [];
        const lineCount = Math.max(rows, wrapped.length);
        for (let i = 0; i < lineCount; i++) {
          if (wrapped[i]) {
            doc.setFont('helvetica', 'normal'); doc.setFontSize(7.2); doc.setTextColor(...ink);
            doc.text(wrapped[i], margin + 2, y + 3.1);
          }
          line(margin + 2, y + 4.2, pageWidth - margin - 2, y + 4.2);
          y += 6;
        }
        y += 4;
      };
      drawRuledText('Laporan', fields.ophthalmologyReport, 3);
      drawRuledText('Syor', fields.ophthalmologyRecommendation, 3);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(7.2); doc.setTextColor(...ink);
      doc.text('Temujanji di Klinik Oftalmologi:', margin + 2, y);
      const appointmentText = formatDateDDMMYYYY(fields.ophthalmologyAppointment);
      const appointmentX = margin + 48;
      // Give the ophthalmology appointment date a longer writing/display line.
      const appointmentW = Math.min(pxToMm(92), contentWidth - 52);
      if (appointmentText) { doc.setFont('helvetica', 'normal'); doc.text(doc.splitTextToSize(appointmentText, appointmentW), appointmentX, y); }
      line(appointmentX, y + 0.7, appointmentX + appointmentW, y + 0.7);
      y += 11;
      const doctorColGap = 8;
      const doctorColW = (contentWidth - doctorColGap) / 2;
      blankField('Nama Doktor', margin + 2, y, doctorColW, fields.ophthalmologyDoctorName);
      blankField('Jawatan', margin + doctorColW + doctorColGap, y, doctorColW - 2, fields.ophthalmologyDesignation);
      y += 8;
      const specialistReturnedAt = (app as any).specialistReportReturnedAt;
      const specialistReturnedDate = specialistReturnedAt?.toDate ? specialistReturnedAt.toDate().toLocaleDateString('en-GB') : specialistReturnedAt ? new Date(specialistReturnedAt).toLocaleDateString('en-GB') : '';
      blankField('Tarikh', margin + 2, y, doctorColW, specialistReturnedDate || fields.ophthalmologyDate || '');

      // Only digitally returned specialist reports are exempt from physical signature/stamp.
      // Walk-in printouts keep the signature/stamp requirement and therefore omit this disclaimer.
      if (hasDigitalSpecialistReport) {
        doc.setFont('helvetica', 'italic'); doc.setFontSize(6); doc.setTextColor(...muted);
        doc.text('Dokumen ini dijana secara digital dan tidak memerlukan tandatangan atau cop rasmi.', margin, pageHeight - 9);
      }
      doc.setFont('helvetica', 'normal'); doc.setFontSize(6); doc.setTextColor(...muted);
      doc.text(`Dijana oleh SINAR pada ${new Date().toLocaleString('en-GB')}`, pageWidth - margin, pageHeight - 5, { align: 'right' });
      const safeName = (app.patientName || 'Patient').replace(/[^a-z0-9-_]/gi, '_');
      const safeDate = (app.date || new Date().toISOString().slice(0, 10)).replace(/[^0-9-]/g, '');
      doc.save(`SINAR_Fundus_${safeName}_${safeDate}.pdf`);
      addActivityLog('Printed Patient Fundus Report', app.patientName || '-');
      setPrintReportApp(null);
    } catch (error) {
      console.error('Failed to generate patient report', error);
      alert('Tak berjaya jana laporan pesakit. Sila cuba lagi.');
    } finally {
      setIsGeneratingPatientReport(false);
    }
  };

  //--- Generate a real downloadable PDF for the selected month; no browser print dialog required ---//
  const exportToPDF = async () => {
    const month = selectedAnalyticsMonth.getMonth();
    const year = selectedAnalyticsMonth.getFullYear();

    const monthlyAppointments = providerWorkloadAppointments.filter(app => {
      if (!app || !app.date) return false;
      const d = new Date(app.date);
      return (
        d.getMonth() === month &&
        d.getFullYear() === year &&
        isAnalyticsDateReached(app.date) &&
        app.status !== AppointmentStatus.NO_SHOW
      );
    });

    const monthLabel = selectedAnalyticsMonth.toLocaleString('en-US', {
      month: 'long',
      year: 'numeric'
    });
    const clinicName = currentClinic?.name || 'SINAR Clinic';
    const generatedAt = new Date().toLocaleString('en-GB', {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    const referralRows = clinics
      .map(clinic => {
        const count = monthlyAppointments.filter(app => {
          if (isCurrentClinicFundusProvider) {
            return getReferringClinicId(app) === clinic.id;
          }
          return (app.clinicId || 'LINTANG') === clinic.id;
        }).length;
        return { clinic, count };
      })
      .filter(row => row.count > 0);

    //--- Referred cases: use the same "Kes Dirujuk" flag from Clinical Review ---//
    const referredCases = monthlyAppointments.filter(app => app.referred === true);

    const getCaseFinding = (app: Appointment) => {
      const findings = new Set<string>();
      const right = app.rightEyeReviewDetails?.abnormalTypes || [];
      const left = app.leftEyeReviewDetails?.abnormalTypes || [];
      [...right, ...left].forEach(f => findings.add(f));
      if (app.rightEyeReviewDetails?.npdrSeverity) {
        findings.add(`NPDR ${app.rightEyeReviewDetails.npdrSeverity}`);
      }
      if (app.leftEyeReviewDetails?.npdrSeverity) {
        findings.add(`NPDR ${app.leftEyeReviewDetails.npdrSeverity}`);
      }
      if (app.rightEyeReviewDetails?.othersText?.trim()) {
        findings.add(app.rightEyeReviewDetails.othersText.trim());
      }
      if (app.leftEyeReviewDetails?.othersText?.trim()) {
        findings.add(app.leftEyeReviewDetails.othersText.trim());
      }
      return findings.size ? Array.from(findings).join(', ') : '-';
    };

    const getSourceName = (app: Appointment) => {
      const sourceId = getReferringClinicId(app);
      const sourceClinic = clinics.find(c => c.id === sourceId);

      //--- Referred-case table also uses the full clinic master name. ---//
      return sourceClinic
        ? getSourceDisplayName(sourceClinic)
        : sourceId || '-';
    };

    const percentage = (value: number, total: number) =>
      total > 0 ? `${((value / total) * 100).toFixed(1)}%` : '0.0%';

    const outcomeRows = [
      ['Normal', monthlyRetenStats.normal],
      ['Abnormal', monthlyRetenStats.abnormal],
      ['Ungradable', monthlyRetenStats.ungradable],
      ['Not Obtainable', monthlyRetenStats.notObtainable],
      ['Not Review Yet', monthlyRetenStats.notReviewYet]
    ];

    const findingRows = [
      ['Mild NPDR', monthlyRetenStats.mildNPDR],
      ['Moderate NPDR', monthlyRetenStats.moderateNPDR],
      ['Severe NPDR', monthlyRetenStats.severeNPDR],
      ['PDR', monthlyRetenStats.pdr],
      ['Maculopathy', monthlyRetenStats.maculopathy],
      ['ADED', monthlyRetenStats.aded],
      ['Cataract', monthlyRetenStats.cataract],
      ['Others', monthlyRetenStats.others]
    ];

    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 14;
    const contentWidth = pageWidth - margin * 2;
    let y = 14;

    const blue = [21, 87, 166] as const;
    const lightBlue = [234, 243, 255] as const;
    const text = [23, 32, 51] as const;
    const muted = [100, 116, 139] as const;

    //--- Use the same circular SINAR logo and wordmark shown in the app header ---//
    const pdfRoundLogo = await loadPdfImage(roundLogo);
    const pdfTextLogo = await loadPdfImage(textLogo);

    const ensureSpace = (height: number) => {
      if (y + height > pageHeight - 16) {
        doc.addPage();
        y = 14;
        drawHeader(true);
      }
    };

    const drawHeader = (continuation = false) => {
      //--- Match the official SINAR PDF header with logo2/logo3 branding ---//
      if (pdfRoundLogo) {
        doc.addImage(pdfRoundLogo, 'PNG', margin, y - 1, 12, 12);
      }

      if (pdfTextLogo) {
        doc.addImage(pdfTextLogo, 'PNG', margin + 15, y + 0.5, 30, 7);
      } else {
        doc.setTextColor(...blue);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(20);
        doc.text('SINAR', margin + 15, y + 5);
      }

      doc.setFontSize(8);
      doc.setTextColor(...muted);
      doc.text('Sistem Interpretasi & Nota Awal Retinopati', margin + 15, y + 10);
      doc.setFontSize(9);
      doc.setTextColor(...text);
      doc.setFont('helvetica', 'bold');
      doc.text(clinicName, margin + 15, y + 15);

      doc.setFontSize(12);
      doc.text('Monthly Clinical Summary', pageWidth - margin, y + 5, { align: 'right' });
      doc.setFontSize(9);
      doc.setFont('helvetica', 'normal');
      doc.text(monthLabel, pageWidth - margin, y + 10, { align: 'right' });
      doc.setFontSize(7);
      doc.setTextColor(...muted);
      doc.text(continuation ? 'Continuation page' : `Report generated: ${generatedAt}`, pageWidth - margin, y + 15, { align: 'right' });

      doc.setDrawColor(...blue);
      doc.setLineWidth(0.7);
      doc.line(margin, y + 20, pageWidth - margin, y + 20);
      y += 27;
    };

    const sectionTitle = (title: string) => {
      ensureSpace(12);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(...blue);
      doc.text(title.toUpperCase(), margin, y);
      y += 6;
    };

    const drawTable = (
      headers: string[],
      rows: string[][],
      widths: number[],
      options?: { fontSize?: number; headerFill?: readonly [number, number, number] }
    ) => {
      const fontSize = options?.fontSize || 7.5;
      const headerFill = options?.headerFill || lightBlue;
      const rowHeightMin = 6;
      const cellPadding = 2;

      const drawRow = (cells: string[], isHeader = false, isTotal = false) => {
        const wrapped = cells.map((cell, i) =>
          doc.splitTextToSize(String(cell ?? ''), Math.max(8, widths[i] - cellPadding * 2))
        );
        const rowHeight = Math.max(rowHeightMin, ...wrapped.map(lines => lines.length * 3.5 + cellPadding * 2));
        ensureSpace(rowHeight + 2);

        let x = margin;
        cells.forEach((_, i) => {
          if (isHeader) doc.setFillColor(...headerFill);
          else if (isTotal) doc.setFillColor(237, 245, 255);
          else doc.setFillColor(255, 255, 255);
          doc.setDrawColor(216, 226, 238);
          doc.rect(x, y, widths[i], rowHeight, 'FD');
          doc.setFont('helvetica', isHeader || isTotal ? 'bold' : 'normal');
          doc.setFontSize(fontSize);
          doc.setTextColor(...text);
          const alignRight = i > 0 && widths.length <= 3;
          doc.text(wrapped[i], alignRight ? x + widths[i] - cellPadding : x + cellPadding, y + cellPadding + 2.6, {
            align: alignRight ? 'right' : 'left'
          });
          x += widths[i];
        });
        y += rowHeight;
      };

      drawRow(headers, true);
      rows.forEach(row => drawRow(row));
    };

    const drawFooter = () => {
      doc.setDrawColor(219, 227, 238);
      doc.setLineWidth(0.3);
      doc.line(margin, pageHeight - 12, pageWidth - margin, pageHeight - 12);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.5);
      doc.setTextColor(...muted);
      doc.text('SINAR | Sistem Interpretasi & Nota Awal Retinopati', margin, pageHeight - 7);
      doc.text(`${clinicName} | ${monthLabel}`, pageWidth - margin, pageHeight - 7, { align: 'right' });
    };

    //--- Header and summary ---//
    drawHeader();
    sectionTitle('1. Overall Summary');
    const cardGap = 3;
    const cardWidth = (contentWidth - cardGap * 3) / 4;
    const cards = [
      ['TOTAL CASES', monthlyStats.total],
      ['PENDING REVIEW', monthlyStats.reviewPending],
      ['PENDING FUNDUS', monthlyStats.fundusPending],
      ['INCOMPLETE CASES', monthlyStats.totalPending]
    ];
    cards.forEach((card, index) => {
      const x = margin + index * (cardWidth + cardGap);
      doc.setFillColor(index === 1 ? 250 : index === 2 ? 255 : 248, index === 1 ? 247 : index === 2 ? 250 : 251, index === 1 ? 255 : index === 2 ? 240 : 255);
      doc.setDrawColor(219, 231, 245);
      doc.roundedRect(x, y, cardWidth, 17, 2, 2, 'FD');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(6.5);
      doc.setTextColor(...muted);
      doc.text(String(card[0]), x + 3, y + 5);
      doc.setFontSize(15);
      doc.setTextColor(...text);
      doc.text(String(card[1]), x + 3, y + 13.5);
    });
    y += 23;

    sectionTitle('2. Screening Outcome');
    drawTable(
      ['Outcome', 'Cases', 'Percentage'],
      [...outcomeRows.map(([label, count]) => [String(label), String(count), percentage(Number(count), monthlyRetenStats.total)]),
        ['Total', String(monthlyRetenStats.total), '100%']],
      [95, 38, 49]
    );
    y += 5;

    sectionTitle('3. Clinical Findings');
    drawTable(
      ['Finding', 'Cases', 'Percentage'],
      findingRows.map(([label, count]) => [String(label), String(count), percentage(Number(count), monthlyRetenStats.total)]),
      [95, 38, 49]
    );
    y += 5;

    sectionTitle('4. Referral / Source Breakdown');
    drawTable(
      ['Clinic / Source', 'Cases', 'Percentage'],
      [...referralRows.map(({ clinic, count }) => [getSourceDisplayName(clinic), String(count), percentage(count, monthlyRetenStats.total)]),
        ['Total', String(monthlyRetenStats.total), '100%']],
      [95, 38, 49]
    );
    y += 5;

    sectionTitle(`5. Referred Cases (${referredCases.length})`);
    if (referredCases.length === 0) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(...muted);
      doc.text('No referred cases recorded for this month.', margin, y);
      y += 8;
    } else {
      const referredRows = referredCases.map(app => [
        app.date ? new Date(app.date).toLocaleDateString('en-GB') : '-',
        app.patientName || '-',
        getSourceName(app),
        getCaseFinding(app),
        app.referralComment?.trim() || '-'
      ]);
      drawTable(
        ['Date', 'Patient', 'Source', 'Finding', 'Referral Note'],
        referredRows,
        [22, 38, 31, 46, 35],
        { fontSize: 6.5 }
      );
    }

    ensureSpace(24);
    doc.setFillColor(245, 249, 255);
    doc.setDrawColor(220, 232, 246);
    doc.roundedRect(margin, y, contentWidth, 18, 2, 2, 'FD');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(...text);
    doc.text('Notes', margin + 4, y + 5);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.setTextColor(...muted);
    const notes = doc.splitTextToSize(
      `Data shown are based on SINAR clinical records for ${monthLabel} and exclude No Show appointments. Screening outcomes and clinical findings follow the same calculation rules used by Monthly Analytics. Referred cases are taken directly from the Clinical Review "Kes Dirujuk" flag.`,
      contentWidth - 8
    );
    doc.text(notes, margin + 4, y + 9);

    const pageCount = doc.getNumberOfPages();
    for (let page = 1; page <= pageCount; page++) {
      doc.setPage(page);
      drawFooter();
    }

    const safeClinic = clinicName.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '');
    const safeMonth = monthLabel.replace(/\s+/g, '_');
    doc.save(`${safeClinic || 'SINAR'}_Monthly_Clinical_Summary_${safeMonth}.pdf`);

    addActivityLog(
      'Exported Monthly Summary PDF',
      `${monthlyAppointments.length} records`
    );
  };

  const upsertAppointment = async (
  data: Partial<Appointment>
) => {

  try {
    setIsSavingAppointment(true);
    //--- Validate referral/provider routing against Fundus Network before saving ---//
    const referringClinicId =
      formReferringClinicId ||
      editingAppointment?.referringClinicId ||
      currentUser?.clinicId ||
      'LINTANG';

    const providerClinicId =
      formFundusProviderClinicId ||
      editingAppointment?.fundusProviderClinicId ||
      currentClinic?.id ||
      '';

    const referringClinic = clinics.find(
      clinic => clinic.id === referringClinicId
    );

    if (!referringClinic || !providerClinicId) {
      alert('Sila pilih Klinik Perujuk dan Klinik Rujukan Fundus.');
      return;
    }

    const validProvider =
      referringClinic.id === providerClinicId &&
      referringClinic.isFundusProvider
        ? true
        : (referringClinic.fundusProviderClinicIds || []).includes(providerClinicId);

    if (!validProvider) {
      alert('Klinik Rujukan Fundus tidak dibenarkan untuk klinik perujuk ini berdasarkan Fundus Network.');
      return;
    }

    //--- Referral TCA schedule: warn only when the selected date is outside configured days ---//
    const configuredTcaDays =
      referringClinic.id !== providerClinicId
        ? clinics.find(clinic => clinic.id === providerClinicId)?.referralTcaDays?.[referringClinic.id] || []
        : [];

    if (data.date && configuredTcaDays.length > 0) {
      const appointmentDate = new Date(`${data.date}T00:00:00`);
      const appointmentDay = appointmentDate.getDay();

      if (!configuredTcaDays.includes(appointmentDay)) {
        const dayLabels: Record<number, string> = {
          0: 'Sunday',
          1: 'Monday',
          2: 'Tuesday',
          3: 'Wednesday',
          4: 'Thursday',
          5: 'Friday',
          6: 'Saturday',
        };

        const allowedLabels = configuredTcaDays
          .map(day => dayLabels[day])
          .filter(Boolean)
          .join(', ');

        const proceed = window.confirm(
          `Hari TCA untuk ${referringClinic.name} ialah ${allowedLabels} sahaja.\n\n` +
          `Tarikh yang dipilih ialah ${dayLabels[appointmentDay] || 'hari tidak diketahui'}.\n\n` +
          `Nak teruskan?`
        );

        if (!proceed) return;
      }
    }

//---Standalone clinics no longer use department-specific scheduling rules---//
    if (editingAppointment) {

      if (!editingAppointment.firestoreId) return;

      await updateDoc(
  doc(
    db,
    "appointments",
    editingAppointment.firestoreId
  ),
  {
    ...data,
    //---Preserve the owning clinic; referral/provider are separate relationships---//
    clinicId: editingAppointment.clinicId ?? currentUser?.clinicId ?? 'LINTANG',
    referringClinicId,
    fundusProviderClinicId: providerClinicId
  }
);

      addActivityLog('Updated Appointment', data.patientName || editingAppointment.patientName || '-');

    } else {

      const newApp: Appointment = {

        id: Math.random()
          .toString(36)
          .substr(2, 9),

        //---Clinic tenant is stamped onto every new clinical record---//
        clinicId: currentUser?.clinicId || 'LINTANG',

        //---Referral/provider relationship for standalone clinic architecture---//
        referringClinicId,
        fundusProviderClinicId: providerClinicId,

        patientName:
          data.patientName || '',

        icNumber:
          data.icNumber || '',

        phoneNumber:
          data.phoneNumber || '',

        //---No department is assigned in the standalone-clinic model---//
        date:
          data.date || '',

        remarks:
          data.remarks || '',

        //--- Optional visual acuity; empty values are allowed ---//
        rightEyeVAUnaided: data.rightEyeVAUnaided || '',
        leftEyeVAUnaided: data.leftEyeVAUnaided || '',
        rightEyeVAWithGlasses: data.rightEyeVAWithGlasses || '',
        leftEyeVAWithGlasses: data.leftEyeVAWithGlasses || '',
        rightEyeVAPinhole: data.rightEyeVAPinhole || '',
        leftEyeVAPinhole: data.leftEyeVAPinhole || '',

        status:
          AppointmentStatus.PENDING,

        diseaseTypes:
          data.diseaseTypes || [],

        otherDisease:
          data.otherDisease || '',

        createdBy:
          currentUser?.id || 'unknown',

        updatedBy:
          currentUser?.id || 'unknown',

        createdAt: Date.now()

      };

      await addDoc(
        collection(db, "appointments"),
        newApp
      );

      addActivityLog('Created Appointment', newApp.patientName || '-');

    }

    closeForm();

  } catch (e) {

    console.error(
      "Failed to save appointment",
      e
    );

  } finally {

    setIsSavingAppointment(false);

  }

};

  const confirmDelete = (app: Appointment) => {
    setDeletingApp(app);
  };

  const deleteAppointment = async (
  id: string
) => {

  if (isDeletingAppointment) return;

  setIsDeletingAppointment(true);

  try {

    const appToDelete = appointments.find(
      app =>
        app.id === id ||
        app.firestoreId === id
    );

    if (!appToDelete?.firestoreId) return;

    // Delete linked specialist referrals first in the same batch so the specialist
    // inbox cannot retain a referral after its source clinic appointment is removed.
    const linkedReferrals = await getDocs(query(
      collection(db, 'specialistReferrals'),
      where('appointmentId', '==', appToDelete.firestoreId)
    ));
    const deleteBatch = writeBatch(db);
    linkedReferrals.docs.forEach(referralDoc => deleteBatch.delete(referralDoc.ref));
    deleteBatch.delete(doc(db, 'appointments', appToDelete.firestoreId));
    await deleteBatch.commit();

    addActivityLog('Deleted Appointment', appToDelete.patientName || '-');

    setDeletingApp(null);

  } catch (e) {

    console.error(
      "Failed to delete appointment",
      e
    );

  } finally {

    setIsDeletingAppointment(false);

  }

};

const saveImageNotObtainable = async () => {

  if (!selectedUnableApp?.firestoreId) return;

  try {

    setIsSavingImageStatus(true);

    const reason =
      unableReason === "Others"
        ? unableOtherReason
        : unableReason;

    const updateData: any = {

      imageStatusUpdatedBy:
        currentUser?.id || "unknown",

      imageStatusUpdatedAt:
        Date.now()

    };

    if (
      unableEye === "right" ||
      unableEye === "both"
    ) {

      updateData.rightEyeImageStatus =
        "Not Obtainable";

      updateData.rightEyeImageReason =
        reason;

    }

    if (
      unableEye === "left" ||
      unableEye === "both"
    ) {

      updateData.leftEyeImageStatus =
        "Not Obtainable";

      updateData.leftEyeImageReason =
        reason;

    }
// Determine final image status
const finalRightStatus =
  updateData.rightEyeImageStatus ??
  selectedUnableApp.rightEyeImageStatus;

const finalLeftStatus =
  updateData.leftEyeImageStatus ??
  selectedUnableApp.leftEyeImageStatus;

const rightCompleted =
  !!selectedUnableApp.rightEyePhoto ||
  finalRightStatus === "Not Obtainable";

const leftCompleted =
  !!selectedUnableApp.leftEyePhoto ||
  finalLeftStatus === "Not Obtainable";

// 🔥 NEW LOGIC
const bothNotObtainable =
  finalRightStatus === "Not Obtainable" &&
  finalLeftStatus === "Not Obtainable";

if (bothNotObtainable) {

  updateData.status = AppointmentStatus.DONE;

} else if (rightCompleted && leftCompleted) {

  updateData.status = AppointmentStatus.DONE_FUNDUS;

}
    await updateDoc(

      doc(
        db,
        "appointments",
        selectedUnableApp.firestoreId
      ),

      updateData

    );

    addActivityLog(

      "Marked Image Not Obtainable",

      selectedUnableApp.patientName

    );

    setShowImageNotObtainable(false);

  } catch (error) {

    console.error(error);

  } finally {

    setIsSavingImageStatus(false);

  }

};

  const updateStatus = async (
  firestoreId: string,
  status: AppointmentStatus
) => {

  try {

    const appToUpdate = appointments.find(
      app => app && app.firestoreId === firestoreId
    );

    await updateDoc(
      doc(db, "appointments", firestoreId),
      {
        status,
        updatedBy: currentUser?.id || 'unknown',
        updatedAt: Date.now()
      }
    );

    addActivityLog(`Updated Status to ${status}`, appToUpdate?.patientName || '-');

  } catch (e) {

    console.error(
      "Failed to update status",
      e
    );

  }

};

  const closeForm = () => {
    setIsFormOpen(false);
    setEditingAppointment(null);
    setExistingPatient(null);
  };

  // Derived Values
  const todayStr = new Date().toLocaleDateString('en-CA');
  const isToday = (dateString: string) => {

  const today = new Date();

  const formattedToday =
    today.toLocaleDateString('en-CA');

  return dateString === formattedToday;

};
  
const sortedAndFilteredAppointments = useMemo(() => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return appointments
    .filter(app => {

      // =========================
      // DEPARTMENT ACCESS
      // =========================

      //---SUPER ADMIN boleh akses semua clinic---//
      if (currentUser?.role === UserRole.SUPER_ADMIN) {
        return true;
      }

      //---User boleh melihat rekod yang dimiliki clinic sendiri---//
      const activeClinicId = currentUser?.clinicId || 'LINTANG';
      const isOwnClinicRecord = (app.clinicId || 'LINTANG') === activeClinicId;

      //---Jika clinic ini ialah fundus provider, ia juga perlu melihat
      //   appointment dari clinic lain yang dirujuk untuk dibuat di sini.---//
      const isFundusProviderRecord =
        (app.fundusProviderClinicId || '') === activeClinicId;

      //---Legacy HSS/PBOA/OPD records were historically performed at Lintang.---//
      const isLegacyProviderRecord =
        activeClinicId === 'LINTANG' &&
        isLegacyLintangProviderRecord(app);

      //---Contoh: PBOA -> KK Lintang.
      //   Rekod kekal milik PBOA, tetapi KK Lintang tetap nampak
      //   kerana Lintang ialah fundus provider.---//
      return isOwnClinicRecord || isFundusProviderRecord || isLegacyProviderRecord;
    })

    .filter(app => {
      if (!app) return false;

      const patientName = app.patientName || '';
      const icNumber = app.icNumber || '';

      const q = searchQuery.toLowerCase();

      const matchesSearch =
        patientName.toLowerCase().includes(q) ||
        icNumber.includes(searchQuery);

      // =========================
      // DATE RANGE FILTER
      // =========================

      const matchesDateFrom =
        !filterDateFrom ||
        app.date >= filterDateFrom;

      const matchesDateTo =
        !filterDateTo ||
        app.date <= filterDateTo;

      const matchesDate =
        matchesDateFrom &&
        matchesDateTo;

      // =========================
      // ACTIVE QUEUE
      // =========================

      const appointmentDate = new Date(app.date);
      appointmentDate.setHours(0, 0, 0, 0);

      const matchesActiveQueue =
        filterStatus === 'All' ||
        appointmentDate <= today;

      // =========================
      // REVIEW FILTER
      // =========================

      const hasPhotos =
        !!(app.rightEyePhoto || app.leftEyePhoto);

      const hasBothReviews =
        isReviewCompleted(app);

      const isAbnormal =
        app.rightEyeReviewDetails?.status === 'Abnormal' ||
        app.leftEyeReviewDetails?.status === 'Abnormal';

      const isNormal =
        hasBothReviews &&
        app.rightEyeReviewDetails?.status === 'Normal' &&
        app.leftEyeReviewDetails?.status === 'Normal';

      const matchesReview =
        filterReview === 'All' ||
        (filterReview === 'Pending' &&
          hasPhotos &&
          !hasBothReviews) ||
        (filterReview === 'Abnormal' &&
          isAbnormal) ||
        (filterReview === 'Normal' &&
          isNormal) ||
        (filterReview === 'Ungradable' && isUngradable);

      return (
        matchesSearch &&
        matchesDate &&
        matchesActiveQueue &&
        matchesReview
      );
    })

    // =========================
    // SORT
    // LATEST DATE → OLDEST DATE
    // =========================

    .sort((a, b) => {

      const dateCompare =
        new Date(b.date).getTime() -
        new Date(a.date).getTime();

      if (dateCompare !== 0) {
        return dateCompare;
      }

      // Same date → latest created first
      return (b.createdAt || 0) - (a.createdAt || 0);
    });

}, [
  appointments,
  currentUser,
  searchQuery,
  filterDateFrom,
  filterDateTo,
  filterStatus,
  filterReview,
  filterDepartment
]);

  const totalPages = Math.ceil(
  sortedAndFilteredAppointments.length /
  ITEMS_PER_PAGE
);

const paginatedAppointments =
  sortedAndFilteredAppointments.slice(
    (currentPage - 1) * ITEMS_PER_PAGE,
    currentPage * ITEMS_PER_PAGE
  );

// Specialist referral follow-up indicators for the clinic dashboard.
const isCurrentClinicReferral = (app: Appointment) => currentUser?.role === UserRole.SUPER_ADMIN || (app.referringClinicId || app.clinicId) === (currentUser?.clinicId || 'LINTANG');
const specialistReviewPendingAppointments = appointments.filter(app => isCurrentClinicReferral(app) && app.referralSent === true && !(app as any).specialistReportStatus && app.specialistClinicId);
const specialistReportsReturnedAppointments = appointments.filter(app => isCurrentClinicReferral(app) && (app as any).specialistReportStatus === 'Returned');

  const allTodayAppointments = useMemo(() => {

  return appointments

    .filter(app => {
      if (currentUser?.role === UserRole.SUPER_ADMIN) return true;

      //---Clinic sendiri sentiasa boleh melihat rekodnya---//
      const activeClinicId = currentUser?.clinicId || 'LINTANG';
      const isOwnClinicRecord = (app.clinicId || 'LINTANG') === activeClinicId;

      //---Fundus provider juga perlu melihat referral dari clinic lain
      //   apabila fundusProviderClinicId menunjuk kepada clinic ini.---//
      const isFundusProviderRecord =
        (app.fundusProviderClinicId || '') === activeClinicId;

      const isLegacyProviderRecord =
        activeClinicId === 'LINTANG' &&
        isLegacyLintangProviderRecord(app);

      return isOwnClinicRecord || isFundusProviderRecord || isLegacyProviderRecord;
    })

    .filter(app =>
      app && isToday(app.date)
    )

    .sort((a, b) =>
      (a.createdAt || 0) -
      (b.createdAt || 0)
    );

}, [appointments, currentUser]);

  const todayAppointments = useMemo(() => {
    return allTodayAppointments
      .filter(app => {
        // Hide from daily queue if completed or No Show
        return !isAppointmentComplete(app) && app.status !== AppointmentStatus.NO_SHOW;
      });
  }, [allTodayAppointments]);

  // =====================================================
  // DYNAMIC TODAY DEPARTMENT STATISTICS
  // Counts today's appointments for every department
  // registered in the clinic-aware department master list.
  //
  // Adding a new department automatically includes it
  // in today's statistics.
  // =====================================================

  const todayDepartmentStats = useMemo(() => {

    const todayApps = visibleAppointments.filter(
      app => app && isToday(app.date)
    );

    return availableDepartments.reduce(
      (stats, department) => {

        stats[department.id] =
          todayApps.filter(
            app => (app.clinicId || 'LINTANG') === department.id
          ).length;

        return stats;

      },
      {} as Record<Department, number>
    );

  }, [visibleAppointments]);

// =====================================================
// TCA SCHEDULE
// Provider clinics see all upcoming appointments that they will perform,
// including patients referred from HSS/PBOA/other clinics.
// Non-provider clinics see their own upcoming appointments.
// The schedule is grouped by appointment date and source clinic.
// =====================================================

const tcaSchedule = useMemo(() => {

  const grouped: Record<
    string,
    Record<string, number> & { total: number }
  > = {};

  //--- Use provider workload so a fundus provider receives referrals here. ---//
  const tcaAppointments = providerWorkloadAppointments.filter(app => {
    if (!app?.date) return false;

    const appointmentDate = new Date(app.date);
    if (Number.isNaN(appointmentDate.getTime())) return false;

    //--- TCA schedule starts from tomorrow; today's cases stay in Today Queue. ---//
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    appointmentDate.setHours(0, 0, 0, 0);

    return appointmentDate >= today;
  });

  tcaAppointments.forEach(app => {
    const appointmentDate = new Date(app.date);
    appointmentDate.setHours(0, 0, 0, 0);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    //--- Do not show today's appointments in TCA. ---//
    if (appointmentDate <= today) return;

    const dateKey = app.date;
    const sourceClinicId = isCurrentClinicFundusProvider
      ? getReferringClinicId(app)
      : (app.clinicId || 'LINTANG');

    if (!grouped[dateKey]) {
      grouped[dateKey] = { total: 0 };
    }

    grouped[dateKey][sourceClinicId] =
      (grouped[dateKey][sourceClinicId] || 0) + 1;

    grouped[dateKey].total++;
  });

  return Object.entries(grouped).sort(
    ([a], [b]) => new Date(a).getTime() - new Date(b).getTime()
  );

}, [providerWorkloadAppointments, isCurrentClinicFundusProvider]);

// =====================================================
// DYNAMIC TOMORROW TCA STATISTICS
// Counts tomorrow's TCA appointments for each standalone clinic.
//
// The existing notification UI can continue using this
// data while we gradually migrate it to dynamic departments.
// =====================================================

const tomorrowTCA = useMemo(() => {

  const tomorrow = new Date();

  tomorrow.setDate(
    tomorrow.getDate() + 1
  );

  const tomorrowStr =
    tomorrow.toLocaleDateString('en-CA');

  return availableDepartments.reduce(
    (stats, department) => {

      stats[department.id] =
        visibleAppointments.filter(
          app =>
            app.date === tomorrowStr &&
            (app.clinicId || 'LINTANG') === department.id
        ).length;

      return stats;

    },
    {} as Record<Department, number>
  );

}, [visibleAppointments]);

// =====================================================
// TOMORROW TCA SUMMARY
// Provides a simple total for all departments.
//
// This keeps the notification logic clean while the
// department data itself remains fully dynamic.
// =====================================================

const tomorrowTCATotal = Object.values(
  tomorrowTCA
).reduce(
  (total, count) => total + count,
  0
);

  //--- Activity logs are clinic-scoped for Admin/Staff; Super Admin sees the global audit trail ---//
  const visibleActivityLogs = useMemo(() => {
    if (currentUser?.role === UserRole.SUPER_ADMIN) return activityLogs;

    const activeClinicId = currentUser?.clinicId;
    if (!activeClinicId) return [];

    //--- Do not use a LINTANG fallback here: legacy/global logs must never leak into clinic views ---//
    return activityLogs.filter(log => log.clinicId === activeClinicId);
  }, [activityLogs, currentUser?.clinicId, currentUser?.role]);

  //--- Persist a clinic's identity color in the Clinic Master ---//
  const handleClinicColorChange = async (clinic: Clinic, colorKey: ClinicColorKey) => {
    if (clinic.colorKey === colorKey) return;

    setClinicColorSaving(clinic.id);
    try {
      await updateDoc(doc(db, 'clinics', clinic.id), { colorKey });
      addActivityLog(
        'Updated Clinic Color',
        `${clinic.name} → ${CLINIC_COLORS.find(color => color.key === colorKey)?.label || colorKey}`,
        currentUser?.displayName || 'System'
      );
    } catch (error) {
      console.error('Failed to update clinic color', error);
      alert('Failed to update clinic color. Please try again.');
    } finally {
      setClinicColorSaving(null);
    }
  };

  // --- Specialist Portal: separate dashboard and staff administration ---
  const saveSpecialistStaff = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!specialistCurrentUser || specialistCurrentUser.role !== 'ADMIN') return;
    const id = specialistStaffIdInput.trim().toUpperCase();
    const displayName = specialistStaffNameInput.trim();
    if (!id || !displayName || (!editingSpecialistStaffId && !specialistStaffPasswordInput.trim())) return;
    if (!editingSpecialistStaffId && specialistUsers.some(u => u.id.toLowerCase() === id.toLowerCase())) {
      alert('User ID already exists.'); return;
    }
    setSpecialistStaffSaving(true);
    try {
      const existing = specialistUsers.find(u => u.id === editingSpecialistStaffId);
      const payload: Omit<SpecialistUser, 'id'> = {
        displayName,
        clinicId: specialistCurrentUser.clinicId,
        role: existing?.role || 'STAFF',
        active: existing?.active ?? true,
        createdAt: existing?.createdAt || Date.now(),
        ...(specialistStaffPasswordInput.trim() ? { password: specialistStaffPasswordInput } : {}),
      };
      await setDoc(doc(db, 'specialistUsers', editingSpecialistStaffId || id), payload, { merge: !!editingSpecialistStaffId });
      setShowSpecialistStaffForm(false);
      setEditingSpecialistStaffId(null);
      setSpecialistStaffIdInput(''); setSpecialistStaffNameInput(''); setSpecialistStaffPasswordInput('');
    } catch (error) {
      console.error('Failed to save specialist staff account', error);
      alert('Unable to save staff account. Please check Firestore permissions.');
    } finally { setSpecialistStaffSaving(false); }
  };

  const specialistLogout = () => {
    // Keep the specialist logout transition consistent with the clinic dashboard.
    setIsAuthenticating(true);
    setAuthMessage('Ending Clinical Session...');
    setTimeout(() => {
      setAuthMessage('Protecting Patient Data...');
      addDoc(collection(db, 'activityLogs'), {
        clinicId: `SPECIALIST:${specialistCurrentUser?.clinicId || ''}`,
        action: 'Specialist User Logged Out',
        patient: `${specialistCurrentUser?.displayName || 'Specialist user'} (${specialistCurrentUser?.id || ''})`,
        by: specialistCurrentUser?.displayName || 'System',
        timestamp: Date.now(),
      }).catch(error => console.warn('Could not write specialist logout log', error));
      setTimeout(() => {
        sessionStorage.removeItem('specialist_current_user');
        setSpecialistCurrentUser(null);
        setShowSpecialistStaffManagement(false);
        setTempUserId('');
        setTempPassword('');
        setIsAuthenticating(false);
      }, 1200);
    }, 1200);
  };

  const openSpecialistReferral = (referral: Record<string, any> & { id: string }) => {
    setSelectedSpecialistReferral(referral);
    setSpecialistReferralPage(1);
    setSpecialistReferralSection6({
      ...(referral.specialistSection6 || {}),
      ophthalmologyReport: referral.specialistSection6?.ophthalmologyReport || '',
      ophthalmologyRecommendation: referral.specialistSection6?.ophthalmologyRecommendation || '',
      ophthalmologyAppointment: referral.specialistSection6?.ophthalmologyAppointment || '',
      ophthalmologyDoctorName: referral.specialistSection6?.ophthalmologyDoctorName || '',
      ophthalmologyDesignation: referral.specialistSection6?.ophthalmologyDesignation || '',
      ophthalmologyDate: referral.specialistSection6?.ophthalmologyDate || '',
    });
  };

  const saveSpecialistReferral = async (sendBack: boolean) => {
    if (!selectedSpecialistReferral || !specialistCurrentUser) return;
    setSpecialistReferralSaving(true);
    try {
      const now = Date.now();
      const referralBatch = writeBatch(db);
      const returnedSection6 = sendBack
        ? { ...specialistReferralSection6, ophthalmologyDate: new Date(now).toLocaleDateString('en-GB') }
        : { ...specialistReferralSection6 };
      delete (returnedSection6 as Record<string, string>).ophthalmologySignature;
      delete (returnedSection6 as Record<string, string>).ophthalmologyStamp;
      referralBatch.update(doc(db, 'specialistReferrals', selectedSpecialistReferral.id), {
        specialistSection6: returnedSection6,
        specialistReviewedBy: specialistCurrentUser.displayName || specialistCurrentUser.id,
        specialistReviewedById: specialistCurrentUser.id,
        specialistReviewedAt: now,
        status: sendBack ? 'Returned to Clinic' : 'In Progress',
        referralStatus: sendBack ? 'Returned to Clinic' : 'In Progress',
        ...(sendBack ? { returnedAt: now, returnedBy: specialistCurrentUser.displayName || specialistCurrentUser.id } : {}),
        updatedAt: now,
      });
      // Attach the returned report to the original clinic appointment in the same atomic write.
      // Only new specialist-return fields are added; existing clinic clinical data is untouched.
      if (sendBack && selectedSpecialistReferral.appointmentId) {
        referralBatch.update(doc(db, 'appointments', String(selectedSpecialistReferral.appointmentId)), {
          specialistReport: returnedSection6,
          specialistReportStatus: 'Returned',
          specialistReportReturnedAt: now,
          specialistReportReturnedBy: specialistCurrentUser.displayName || specialistCurrentUser.id,
          specialistReportClinicId: specialistCurrentUser.clinicId,
        });
      }
      await referralBatch.commit();
      if (sendBack) {
        setSelectedSpecialistReferral(null);
        setSpecialistReferralPage(1);
        alert('Laporan pakar berjaya dihantar semula ke klinik asal.');
      } else {
        alert('Dapatan pakar berjaya disimpan.');
      }
    } catch (error) {
      console.error('Failed to save specialist referral', error);
      alert('Tidak berjaya menyimpan laporan pakar. Sila cuba lagi.');
    } finally {
      setSpecialistReferralSaving(false);
    }
  };

  if (specialistCurrentUser && !currentUser) {
    const specialistClinic = specialistClinics.find(c => c.id === specialistCurrentUser.clinicId);
    const isSpecialistAdmin = specialistCurrentUser.role === 'ADMIN';
    const clinicStaff = specialistUsers.filter(u => u.clinicId === specialistCurrentUser.clinicId);
    const clinicReferrals = specialistReferrals.filter(referral => {
      const assignedClinicId = referral.specialistClinicId || referral.toSpecialistClinicId || referral.targetClinicId || referral.clinicId;
      return assignedClinicId === specialistCurrentUser.clinicId;
    });
    const referralStatus = (referral: Record<string, any>) => String(referral.status || referral.referralStatus || 'New').toLowerCase();
    const newReferrals = clinicReferrals.filter(referral => ['new', 'pending', 'referred', 'submitted', 'new referral'].includes(referralStatus(referral)));
    const currentMonthKey = `${specialistAnalyticsMonth.getFullYear()}-${String(specialistAnalyticsMonth.getMonth() + 1).padStart(2, '0')}`;
    const monthlyReferrals = clinicReferrals.filter(referral => {
      const rawDate = referral.createdAt?.toDate ? referral.createdAt.toDate() : new Date(referral.createdAt || referral.referredAt || referral.date || 0);
      return !Number.isNaN(rawDate.getTime()) && `${rawDate.getFullYear()}-${String(rawDate.getMonth() + 1).padStart(2, '0')}` === currentMonthKey;
    });
    // All referrals remain in the specialist history, including reports already returned.
    // Only the compact active queue above is limited to referrals still awaiting action.
    const openReferrals = clinicReferrals.filter(referral => {
      const status = referralStatus(referral).replace(/[_-]+/g, ' ').trim();
      return ![
        'returned',
        'returned to clinic',
        'sent back',
        'sent back to clinic',
        'returned to referring clinic',
        'completed and returned',
      ].includes(status);
    });
    const filteredClinicReferrals = clinicReferrals.filter(referral => {
      const query = specialistReferralSearch.trim().toLowerCase();
      if (!query) return true;
      const searchable = [
        referral.patientName,
        referral.patient?.name,
        referral.name,
        referral.icNumber,
        referral.patientIC,
        referral.patient?.icNumber,
        referral.referringClinicName,
        referral.fromClinicName,
        referral.sourceClinicName,
        referral.referringClinicId,
        referral.referralReason,
        referral.reason,
        referral.notes,
      ].filter(Boolean).join(' ').toLowerCase();
      return searchable.includes(query);
    });
    const SPECIALIST_REFERRALS_PER_PAGE = 10;
    const specialistReferralTotalPages = Math.max(1, Math.ceil(filteredClinicReferrals.length / SPECIALIST_REFERRALS_PER_PAGE));
    const safeSpecialistReferralPage = Math.min(specialistReferralPageNumber, specialistReferralTotalPages);
    const paginatedSpecialistReferrals = filteredClinicReferrals.slice(
      (safeSpecialistReferralPage - 1) * SPECIALIST_REFERRALS_PER_PAGE,
      safeSpecialistReferralPage * SPECIALIST_REFERRALS_PER_PAGE
    );
    const shiftSpecialistMonth = (delta: number) => setSpecialistAnalyticsMonth(current => {
      const next = new Date(current.getFullYear(), current.getMonth() + delta, 1);
      if (next > new Date(new Date().getFullYear(), new Date().getMonth(), 1)) return current;
      return next;
    });
    const formatReferralDate = (referral: Record<string, any>) => {
      const raw = referral.createdAt?.toDate ? referral.createdAt.toDate() : new Date(referral.createdAt || referral.referredAt || referral.date || 0);
      return Number.isNaN(raw.getTime()) || raw.getTime() === 0 ? '-' : raw.toLocaleDateString('en-GB');
    };
    const formatReferralReturnedDate = (referral: Record<string, any>) => {
      const value = referral.returnedAt || referral.specialistReportReturnedAt || referral.specialistReviewedAt;
      if (!value) return '';
      const date = value?.toDate ? value.toDate() : new Date(value);
      return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-GB');
    };
    return (
      <div className="min-h-screen bg-gradient-to-br from-emerald-50 via-teal-50 to-sky-50 font-sans text-slate-900 flex flex-col">
        <header className="sticky top-0 z-40 border-b border-slate-200 bg-white shadow-sm">
          <div className="mx-auto flex w-full max-w-7xl flex-col justify-center gap-3 px-3 py-2 md:min-h-16 md:flex-row md:items-center md:justify-between md:gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <div className="h-12 w-12 shrink-0 overflow-hidden rounded-full border-2 border-slate-100 bg-white shadow-sm">
                <img src={roundLogo} alt={`${specialistClinic?.name || 'Specialist Clinic'} Logo`} className="h-full w-full object-cover" />
              </div>
              <div className="flex min-w-0 flex-col">
                <img src={textLogo} alt="SINAR" className="h-6 w-32 object-cover object-left" />
                <div className="my-1 mt-2 h-px w-auto bg-slate-300" />
                <span className="mt-0 truncate text-xs font-bold text-slate-700">{specialistClinic?.name || 'Ophthalmology Specialist Clinic'}</span>
              </div>
            </div>
            <div className="flex w-full flex-wrap items-center justify-between gap-2 md:w-auto md:justify-end md:gap-3">
              {isSpecialistAdmin && (
                <>
                  <button onClick={() => setSpecialistComingSoonFeature('Manage Referral Clinic')} title="Coming soon — feature in progress" className="flex items-center gap-2 rounded-lg border border-teal-200 bg-teal-50 px-2 py-1 text-xs font-bold text-teal-800 transition-all hover:bg-teal-100">
                    <Calendar size={15} className="text-teal-700" /><span className="hidden md:inline">Manage Referral Clinic</span><span className="md:hidden">Referrals</span>
                  </button>
                  <button onClick={() => {
                    const willOpen = !showSpecialistStaffManagement;
                    setShowSpecialistStaffManagement(willOpen);
                    setShowSpecialistStaffForm(false);
                    setEditingSpecialistStaffId(null);
                    setSpecialistStaffIdInput('');
                    setSpecialistStaffNameInput('');
                    setSpecialistStaffPasswordInput('');
                    setShowSpecialistStaffPassword(false);
                    setShowSpecialistActivityLogs(false);
                  }} className="flex items-center gap-2 rounded-lg border border-teal-200 bg-teal-50 px-2 py-1 text-xs font-bold text-teal-800 transition-all hover:bg-teal-100">
                    <ShieldCheck size={15} className="text-teal-700" /><span className="hidden md:inline">Staff Management</span><span className="md:hidden">Staff</span>
                  </button>
                  <button onClick={() => setSpecialistComingSoonFeature('Monthly Summary')} className="flex items-center gap-2 rounded-lg border border-teal-200 bg-teal-50 px-2 py-1 text-xs font-bold text-teal-800 transition-all hover:bg-teal-100">
                    <BarChart3 size={15} className="text-teal-700" /><span className="hidden md:inline">Monthly Summary</span><span className="md:hidden">Summary</span>
                  </button>
                  <button onClick={() => { setShowSpecialistStaffManagement(false); setShowSpecialistActivityLogs(v => !v); }} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-100 px-2 py-1 text-xs font-bold text-slate-700 transition-all hover:bg-slate-200">
                    <Activity size={15} className="text-teal-700" /><span className="hidden md:inline">Activity Logs</span><span className="md:hidden">Logs</span>
                  </button>
                </>
              )}
              <div className="ml-auto text-right">
                <p className="text-xs font-black uppercase text-slate-800">{specialistCurrentUser.displayName}</p>
                <p className="text-[10px] font-bold uppercase tracking-widest text-teal-700">{specialistCurrentUser.id}</p>
                <p className="text-[9px] font-bold uppercase tracking-widest text-slate-400">{isSpecialistAdmin ? 'Admin' : 'Staff'}</p>
              </div>
              <button onClick={specialistLogout} title="Log out" className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-rose-600"><LogOut size={19}/></button>
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-7xl flex-1 space-y-5 px-4 py-6 sm:py-8">
          {showSpecialistActivityLogs && isSpecialistAdmin ? (
            <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div><p className="text-[10px] font-black uppercase tracking-[.18em] text-teal-700">Specialist clinic administration</p><h1 className="mt-1 text-2xl font-black">Activity Logs</h1><p className="mt-1 text-sm text-slate-500">Recent activity for this specialist clinic.</p></div>
                <button onClick={() => setShowSpecialistActivityLogs(false)} className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50">Back to Dashboard</button>
              </div>
              <div className="mt-5 divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200">
                {activityLogs.filter(log => String(log.clinicId || '') === `SPECIALIST:${specialistCurrentUser.clinicId}`).length ? activityLogs.filter(log => String(log.clinicId || '') === `SPECIALIST:${specialistCurrentUser.clinicId}`).map((log, index) => <div key={`${log.timestamp || index}-${index}`} className="flex flex-wrap items-start justify-between gap-2 px-4 py-3"><div><p className="text-sm font-bold text-slate-800">{log.action || 'Activity'}</p><p className="mt-0.5 text-xs text-slate-500">{log.by || log.patient || specialistCurrentUser.displayName}</p></div><p className="text-xs text-slate-400">{log.timestamp ? new Date(log.timestamp).toLocaleString('en-GB') : '-'}</p></div>) : <p className="px-4 py-10 text-center text-sm text-slate-500">No specialist activity logs to display yet.</p>}
              </div>
            </section>
          ) : (
            <>
              {/* Practice Summary — mirrors the standard clinic dashboard layout. */}
              <section className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm md:p-8">
                <div className="grid grid-cols-2 items-stretch gap-3 lg:grid-cols-12">
                  <div className="col-span-2 flex flex-col justify-center lg:col-span-2">
                    <h1 className="text-xl font-black tracking-tight text-slate-800 md:text-2xl">Practice Summary</h1>
                    <p className="mt-1 text-2xl font-black leading-none text-slate-300 md:text-3xl">{new Date().getFullYear()}</p>
                  </div>

                  <div className="min-h-[120px] rounded-2xl border border-emerald-100 bg-gradient-to-br from-emerald-50 to-teal-50 px-3 py-3 lg:col-span-2">
                    <p className="mb-3 text-center text-xs font-black uppercase tracking-widest text-emerald-700">Total Referrals</p>
                    <div className="grid grid-cols-[40px_1px_minmax(0,1fr)] items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-600 text-white shadow-lg shadow-emerald-100"><Activity size={20}/></div>
                      <div className="h-16 w-px bg-slate-300"/>
                      <p className="text-center text-4xl font-black leading-none text-slate-900 md:text-5xl">{clinicReferrals.length}</p>
                    </div>
                  </div>

                  <div className="min-h-[120px] rounded-2xl border border-violet-100 bg-gradient-to-br from-violet-50 to-indigo-50 px-3 py-3 lg:col-span-2">
                    <p className="mb-3 text-center text-xs font-black uppercase tracking-widest text-violet-700">Pending Review</p>
                    <div className="grid grid-cols-[40px_1px_minmax(0,1fr)] items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-600 text-white shadow-lg shadow-violet-100"><Search size={20}/></div>
                      <div className="h-16 w-px bg-slate-300"/>
                      <p className="text-center text-4xl font-black leading-none text-slate-900 md:text-5xl">{openReferrals.length}</p>
                    </div>
                  </div>

                  <div id="specialist-monthly-summary" className="col-span-2 rounded-2xl border border-slate-200 bg-gradient-to-br from-white to-slate-50 p-4 shadow-sm lg:col-span-6">
                    <div className="grid grid-cols-1 items-center gap-4 md:grid-cols-[minmax(150px,1fr)_2fr]">
                      <div>
                        <h2 className="mb-1 text-sm font-bold uppercase tracking-widest text-teal-700">Monthly Summary</h2>
                        <div className="mt-2 flex items-center gap-3">
                          <button onClick={() => shiftSpecialistMonth(-1)} className="rounded-full p-1 hover:bg-slate-200" aria-label="Previous month"><ChevronLeft size={18}/></button>
                          <p className="min-w-[120px] text-center text-sm font-bold text-slate-600">{specialistAnalyticsMonth.toLocaleString('en-US', {month:'long',year:'numeric'})}</p>
                          <button onClick={() => shiftSpecialistMonth(1)} disabled={currentMonthKey === `${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,'0')}`} className="rounded-full p-1 transition-all hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-30" aria-label="Next month"><ChevronRight size={18}/></button>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                        <div className="text-center"><p className="text-[10px] font-bold uppercase text-slate-400">Total</p><p className="text-3xl font-black">{monthlyReferrals.length}</p></div>
                        <div className="text-center"><p className="text-[10px] font-bold uppercase text-teal-700">New</p><p className="text-3xl font-black text-teal-700">{monthlyReferrals.filter(r => ['new','pending','referred','submitted','new referral'].includes(referralStatus(r))).length}</p></div>
                        <div className="text-center"><p className="text-[10px] font-bold uppercase text-indigo-500">In Progress</p><p className="text-3xl font-black text-indigo-600">{monthlyReferrals.filter(r => ['in progress','in_progress','processing','accepted'].includes(referralStatus(r))).length}</p></div>
                        <div className="text-center"><p className="text-[10px] font-bold uppercase text-emerald-600">Returned</p><p className="text-3xl font-black text-emerald-600">{monthlyReferrals.filter(r => ['returned','returned to clinic','completed and returned','sent back','sent back to clinic','returned to referring clinic'].includes(referralStatus(r).replace(/[_-]+/g, ' ').trim())).length}</p></div>
                      </div>
                    </div>
                  </div>
                </div>
              </section>

              {/* Active referrals remain visible until the completed report is sent back to the referring clinic. */}
              <section id="specialist-referrals" className="space-y-4 scroll-mt-24">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Clock size={20} className="text-teal-700"/>
                    <h2 className="text-lg font-bold tracking-tight text-slate-800">Referrals from Clinics</h2>
                    <span className="text-sm font-semibold text-slate-500">{new Date().toLocaleDateString('en-GB', {day:'2-digit', month:'short', year:'numeric'})}</span>
                    <span className="rounded bg-teal-700 px-2 py-0.5 text-[10px] font-black uppercase tracking-tighter text-white">{openReferrals.length} Active Referrals</span>
                    <span className="rounded bg-slate-100 px-2 py-0.5 text-[10px] font-black uppercase tracking-tighter text-slate-600">{newReferrals.length} New</span>
                  </div>
                </div>

                {/* Specialist referral queue cards — mirrors Today's Queue cards on the clinic dashboard. */}
                <div className="space-y-3">
                  {openReferrals.length > 0 ? (
                    <div className="flex flex-wrap items-start gap-4">
                      {openReferrals.map(referral => {
                        const patientName = referral.patientName || referral.patient?.name || referral.name || 'Patient details pending';
                        const patientIC = referral.icNumber || referral.patientIC || referral.patient?.icNumber || '-';
                        const referringClinic = referral.referringClinicName || referral.fromClinicName || referral.sourceClinicName || referral.referringClinicId || 'Referring clinic';
                        const referringClinicId = referral.referringClinicId || referral.fromClinicId || referral.sourceClinicId || referral.referringClinic?.id || '';
                        const sourceClinic = clinics.find(clinic => clinic.id === referringClinicId) || clinics.find(clinic => clinic.name === referringClinic || clinic.shortName === referringClinic) || null;
                        const clinicColor = getClinicColor(sourceClinic);
                        const statusText = String(referral.status || referral.referralStatus || 'New').replace(/[_-]+/g, ' ');
                        return (
                          <article key={`queue-${referral.id}`} onClick={() => openSpecialistReferral(referral)} role="button" tabIndex={0} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') openSpecialistReferral(referral); }} className={`w-full max-w-sm cursor-pointer rounded-xl border border-slate-200 border-l-4 ${clinicColor.border} bg-white p-4 shadow-sm transition-shadow hover:shadow-md focus:outline-none focus:ring-2 focus:ring-teal-500`}>
                            <div className="flex items-start justify-between gap-3">
                              <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border ${clinicColor.badge}`}><Users size={19}/></div>
                              <div className="min-w-0 flex-1 text-right">
                                <span className={`inline-block max-w-full truncate rounded-full border px-2 py-1 text-[10px] font-black uppercase tracking-wide ${clinicColor.badge}`}>{referringClinic}</span>
                                <p className="mt-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">{statusText}</p>
                              </div>
                            </div>
                            <h3 className="mt-3 break-words text-sm font-black uppercase text-slate-800">{patientName}</h3>
                            <p className="mt-1 text-xs text-slate-500">IC: {patientIC}</p>
                            <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2">
                              <p className="text-[10px] font-black uppercase tracking-wide text-slate-400">Referral reason / notes</p>
                              <p className="mt-1 line-clamp-2 break-words text-xs text-slate-600">{referral.referralReason || referral.reason || referral.notes || 'No reason or notes provided.'}</p>
                            </div>
                            <div className="mt-3 flex items-center justify-between gap-2">
                              <span className="text-[10px] font-semibold text-slate-400">Received: {formatReferralDate(referral)}</span>
                              <span className="rounded-lg bg-teal-700 px-3 py-2 text-[10px] font-black uppercase text-white">Referral received</span>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="flex min-h-[108px] flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white/90 px-4 py-5 text-center">
                      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-teal-50 text-teal-700"><ClipboardCheck size={21}/></div>
                      <p className="mt-2 text-sm font-bold text-slate-700">No referrals received</p>
                      <p className="mt-1 text-xs text-slate-500">New referrals from clinics will appear here until the specialist report is completed and returned.</p>
                    </div>
                  )}
                </div>

                <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                  <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white p-3 md:p-4">
                    <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-slate-300 px-3 py-2">
                      <Search size={16} className="shrink-0 text-slate-400"/>
                      <input
                        value={specialistReferralSearch}
                        onChange={event => { setSpecialistReferralSearch(event.target.value); setSpecialistReferralPageNumber(1); }}
                        placeholder="Search patient name or IC..."
                        className="w-full min-w-0 bg-transparent text-sm text-slate-700 outline-none placeholder:text-slate-400"
                        aria-label="Search referrals by patient name or IC"
                      />
                    </div>
                    <span className="rounded-lg border border-teal-200 bg-teal-50 px-3 py-2 text-xs font-bold text-teal-800">All referrals ({filteredClinicReferrals.length})</span>
                  </div>

                  {filteredClinicReferrals.length > 0 ? (
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[850px] text-left">
                        <thead className="bg-slate-200/80 text-[10px] font-black uppercase tracking-widest text-slate-600">
                          <tr>
                            <th className="px-4 py-4">Patient Details</th>
                            <th className="px-4 py-4">Referring Clinic</th>
                            <th className="px-4 py-4">Referral Date</th>
                            <th className="px-4 py-4">Reason / Notes</th>
                            <th className="px-4 py-4">Status</th>
                            <th className="px-4 py-4">Action</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {paginatedSpecialistReferrals.map(referral => {
                            const referringClinic = referral.referringClinicName || referral.fromClinicName || referral.sourceClinicName || referral.referringClinicId || '-';
                            const referringClinicId = referral.referringClinicId || referral.fromClinicId || referral.sourceClinicId || referral.referringClinic?.id || '';
                            const sourceClinic = clinics.find(clinic => clinic.id === referringClinicId) || clinics.find(clinic => clinic.name === referringClinic || clinic.shortName === referringClinic) || null;
                            const clinicColor = getClinicColor(sourceClinic);
                            return (
                              <tr key={referral.id} className={`border-l-4 ${clinicColor.border} bg-white transition-colors hover:bg-slate-50`}>
                                <td className="px-4 py-4">
                                  <p className="text-sm font-black text-slate-800">{referral.patientName || referral.patient?.name || referral.name || 'Patient details pending'}</p>
                                  <p className="mt-1 text-xs text-slate-500">IC: {referral.icNumber || referral.patientIC || referral.patient?.icNumber || '-'}</p>
                                </td>
                                <td className="px-4 py-4"><span className={`inline-flex max-w-[220px] rounded-full border px-2.5 py-1 text-xs font-bold ${clinicColor.badge}`}>{referringClinic}</span></td>
                                <td className="px-4 py-4 text-sm text-slate-600">{formatReferralDate(referral)}</td>
                                <td className="max-w-xs px-4 py-4 text-sm text-slate-600">{referral.referralReason || referral.reason || referral.notes || '-'}</td>
                                <td className="px-4 py-4">{(() => { const status = String(referral.status || referral.referralStatus || 'New').replace(/[_-]+/g, ' '); const returned = ['returned', 'returned to clinic', 'sent back', 'sent back to clinic', 'returned to referring clinic', 'completed and returned'].includes(status.toLowerCase()); const inProgress = status.toLowerCase() === 'in progress'; const returnedDate = returned ? formatReferralReturnedDate(referral) : ''; return <div className="flex flex-col items-center gap-1.5 text-center"><span className={`rounded-full border px-2.5 py-1 text-[10px] font-black uppercase ${returned ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : inProgress ? 'border-indigo-200 bg-indigo-50 text-indigo-800' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>{returned ? 'Returned to Clinic' : status}</span>{returnedDate && <span className="text-[10px] font-medium text-slate-500">Returned: {returnedDate}</span>}</div>; })()}</td>
                                <td className="px-4 py-4"><button type="button" onClick={() => openSpecialistReferral(referral)} className="rounded-lg bg-teal-700 px-3 py-2 text-xs font-bold text-white transition hover:bg-teal-800">{openReferrals.some(item => item.id === referral.id) ? 'Open Referral' : 'View Report'}</button></td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="flex min-h-[150px] flex-col items-center justify-center px-4 py-8 text-center">
                      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-teal-50 text-teal-700"><ClipboardCheck size={23}/></div>
                      <p className="mt-3 font-bold text-slate-700">{specialistReferralSearch.trim() ? 'No matching referrals found' : 'No referrals to display yet'}</p>
                      <p className="mx-auto mt-1 max-w-lg text-sm text-slate-500">{specialistReferralSearch.trim() ? 'Try another patient name or IC number.' : 'New referrals sent by clinic users will appear here and remain until the specialist report is sent back to the referring clinic.'}</p>
                    </div>
                  )}
                  {filteredClinicReferrals.length > 0 && (
                    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-4 py-3">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Page {safeSpecialistReferralPage} of {specialistReferralTotalPages} · {SPECIALIST_REFERRALS_PER_PAGE} per page</span>
                      <div className="flex flex-wrap items-center gap-2">
                        <button type="button" onClick={() => setSpecialistReferralPageNumber(p => Math.max(1, p - 1))} disabled={safeSpecialistReferralPage === 1} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-bold disabled:opacity-40">Previous</button>
                        {Array.from({ length: specialistReferralTotalPages }, (_, i) => i + 1).filter(page => page === 1 || page === specialistReferralTotalPages || Math.abs(page - safeSpecialistReferralPage) <= 1).map((page, index, pages) => (
                          <React.Fragment key={page}>
                            {index > 0 && page - pages[index - 1] > 1 && <span className="px-1 text-slate-400">…</span>}
                            <button type="button" onClick={() => setSpecialistReferralPageNumber(page)} className={`h-8 min-w-8 rounded-lg border px-2 text-xs font-black ${page === safeSpecialistReferralPage ? 'border-teal-700 bg-teal-700 text-white' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}>{page}</button>
                          </React.Fragment>
                        ))}
                        <button type="button" onClick={() => setSpecialistReferralPageNumber(p => Math.min(specialistReferralTotalPages, p + 1))} disabled={safeSpecialistReferralPage === specialistReferralTotalPages} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-bold disabled:opacity-40">Next</button>
                      </div>
                    </div>
                  )}
                </section>
              </section>
            </>
          )}
        </main>
        
        {showSpecialistStaffManagement && isSpecialistAdmin && (
          <div className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto overscroll-contain bg-slate-900/40 p-2 backdrop-blur-sm sm:p-5">
            <button
              type="button"
              aria-label="Close Staff Management"
              onClick={() => {
                if (specialistStaffSaving) return;
                setShowSpecialistStaffManagement(false);
                setShowSpecialistStaffForm(false);
                setEditingSpecialistStaffId(null);
                setSpecialistStaffIdInput('');
                setSpecialistStaffNameInput('');
                setSpecialistStaffPasswordInput('');
                setShowSpecialistStaffPassword(false);
              }}
              className="absolute inset-0 h-full w-full cursor-default"
            />
            <section className="relative my-auto flex max-h-[calc(100dvh-1rem)] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl sm:max-h-[calc(100dvh-2.5rem)]">
              <div className="flex items-start justify-between border-b border-slate-100 bg-white p-5 sm:p-7">
                <div className="flex items-center gap-3">
                  <div className="rounded-xl bg-teal-700 p-2.5 shadow-sm"><Users size={20} className="text-white" /></div>
                  <div>
                    <p className="mb-1 text-[10px] font-black uppercase tracking-[.18em] text-teal-700">Specialist clinic administration</p>
                    <h2 className="text-2xl font-black leading-tight text-slate-900">Staff Management</h2>
                    <p className="mt-1 text-sm text-slate-500">Manage staff accounts for {specialistClinic?.name || 'this specialist clinic'}.</p>
                  </div>
                </div>
                <button
                  type="button"
                  aria-label="Close Staff Management"
                  onClick={() => {
                    if (specialistStaffSaving) return;
                    setShowSpecialistStaffManagement(false);
                    setShowSpecialistStaffForm(false);
                    setEditingSpecialistStaffId(null);
                    setSpecialistStaffIdInput('');
                    setSpecialistStaffNameInput('');
                    setSpecialistStaffPasswordInput('');
                    setShowSpecialistStaffPassword(false);
                  }}
                  className="rounded-xl p-2 text-slate-400 transition-colors hover:bg-slate-100"
                ><XCircle size={24} /></button>
              </div>

              <div className="space-y-5 overflow-y-auto bg-white p-5 sm:p-7">
                <section>
                  <button
                    type="button"
                    onClick={() => {
                      if (showSpecialistStaffForm) {
                        setShowSpecialistStaffForm(false);
                        setEditingSpecialistStaffId(null);
                        setSpecialistStaffIdInput('');
                        setSpecialistStaffNameInput('');
                        setSpecialistStaffPasswordInput('');
                        setShowSpecialistStaffPassword(false);
                      } else {
                        setEditingSpecialistStaffId(null);
                        setSpecialistStaffIdInput('');
                        setSpecialistStaffNameInput('');
                        setSpecialistStaffPasswordInput('');
                        setShowSpecialistStaffPassword(false);
                        setShowSpecialistStaffForm(true);
                      }
                    }}
                    className="mb-4 flex w-full items-center justify-between"
                  >
                    <h3 className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-slate-400">
                      {editingSpecialistStaffId ? <Edit2 size={14} className="text-teal-700" /> : <UserPlus size={14} className="text-teal-700" />}
                      {editingSpecialistStaffId ? `Editing Account: ${editingSpecialistStaffId}` : 'Register New Specialist Staff'}
                    </h3>
                    {!editingSpecialistStaffId && <span className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-xs font-black text-white shadow-sm transition hover:bg-blue-700 disabled:opacity-40">{showSpecialistStaffForm ? <XCircle size={16}/> : <UserPlus size={16}/>} {showSpecialistStaffForm ? 'Close form' : 'Add new user'}</span>}
                  </button>

                  {(showSpecialistStaffForm || editingSpecialistStaffId) && (
                    <form onSubmit={saveSpecialistStaff} className="rounded-2xl border border-teal-100 bg-teal-50/50 p-3 md:p-4">
                      <div className="mb-5 flex items-center justify-between gap-3">
                        <div><p className="text-[10px] font-black uppercase tracking-[.18em] text-teal-700">New account</p><h4 className="mt-1 text-base font-black text-slate-900">{editingSpecialistStaffId ? 'Edit Specialist User Details' : 'Register New Specialist User'}</h4></div>
                        <span className="rounded-full bg-white px-3 py-1.5 text-[10px] font-bold text-slate-500">Specialist Admin</span>
                      </div>
                      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                        <div className="space-y-1">
                          <label className="ml-1 text-[9px] font-bold uppercase text-teal-700">Staff User ID</label>
                          <input type="text" required disabled={!!editingSpecialistStaffId} value={specialistStaffIdInput} onChange={e => setSpecialistStaffIdInput(e.target.value)} placeholder="e.g. OPHSTAFF01" className="w-full rounded-xl border border-teal-200 bg-white px-4 py-2.5 text-sm font-bold outline-none focus:ring-2 focus:ring-teal-600 disabled:bg-slate-100" />
                        </div>
                        <div className="space-y-1">
                          <label className="ml-1 text-[9px] font-bold uppercase text-teal-700">Password</label>
                          <div className="relative">
                            <input type={showSpecialistStaffPassword ? 'text' : 'password'} required={!editingSpecialistStaffId} value={specialistStaffPasswordInput} onChange={e => setSpecialistStaffPasswordInput(e.target.value)} placeholder={editingSpecialistStaffId ? 'Leave blank to keep current password' : 'Enter password'} className="w-full rounded-xl border border-teal-200 bg-white px-4 py-2.5 pr-11 text-sm font-medium outline-none focus:ring-2 focus:ring-teal-600" />
                            <button type="button" onClick={() => setShowSpecialistStaffPassword(v => !v)} aria-label={showSpecialistStaffPassword ? 'Hide password' : 'Show password'} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">{showSpecialistStaffPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button>
                          </div>
                        </div>
                        <div className="space-y-1">
                          <label className="ml-1 text-[9px] font-bold uppercase text-teal-700">Display Name</label>
                          <input type="text" required value={specialistStaffNameInput} onChange={e => setSpecialistStaffNameInput(e.target.value)} placeholder="e.g. Dr. Johny" className="w-full rounded-xl border border-teal-200 bg-white px-4 py-2.5 text-sm font-medium outline-none focus:ring-2 focus:ring-teal-600" />
                        </div>
                      </div>
                      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                        <div className="space-y-1">
                          <label className="ml-1 text-[9px] font-bold uppercase text-teal-700">Clinic</label>
                          <div className="w-full rounded-xl border border-teal-200 bg-white px-4 py-2.5 text-sm font-bold text-slate-700">{specialistClinic?.name || specialistCurrentUser.clinicId}</div>
                          <p className="ml-1 mt-1 text-[9px] text-slate-400">Account is automatically assigned to this specialist clinic.</p>
                        </div>
                        <div className="space-y-1">
                          <label className="ml-1 text-[9px] font-bold uppercase text-teal-700">Role</label>
                          <div className="w-full rounded-xl border border-teal-200 bg-slate-50 px-4 py-2.5 text-sm font-bold text-slate-700">{editingSpecialistStaffId ? (specialistUsers.find(u => u.id === editingSpecialistStaffId)?.role || "STAFF") : "STAFF"}</div>
                          <p className="ml-1 mt-1 text-[9px] text-slate-400">Specialist Admin manages staff accounts for this clinic.</p>
                        </div>
                      </div>
                      <div className="mt-5 flex justify-end gap-2">
                        {editingSpecialistStaffId && <button type="button" onClick={() => { setShowSpecialistStaffForm(false); setEditingSpecialistStaffId(null); setSpecialistStaffIdInput(''); setSpecialistStaffNameInput(''); setSpecialistStaffPasswordInput(''); setShowSpecialistStaffPassword(false); }} className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs font-bold text-slate-600 hover:bg-slate-50">Cancel Edit</button>}
                        <button type="submit" disabled={specialistStaffSaving} className="rounded-xl bg-teal-700 px-5 py-2.5 text-[10px] font-black uppercase tracking-widest text-white shadow-lg transition-all hover:bg-teal-800 disabled:opacity-60">{specialistStaffSaving ? 'Saving…' : editingSpecialistStaffId ? 'Save Changes' : 'Create Account'}</button>
                      </div>
                    </form>
                  )}
                </section>

                <section className="flex max-h-[420px] flex-col">
                  <h3 className="mb-4 text-[10px] font-black uppercase tracking-widest text-slate-400">Current Specialist Users ({clinicStaff.length})</h3>
                  <div className="overflow-y-auto pr-1">
                    {clinicStaff.length ? clinicStaff.map(staff => (
                      <div key={staff.id} className="mb-2 flex items-center justify-between gap-3 rounded-2xl border border-slate-100 px-4 py-3">
                        <div className="min-w-0 flex items-center gap-3">
                          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-600"><Users size={18}/></div>
                          <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-bold text-slate-800">{staff.displayName}</p><span className={`rounded px-2 py-0.5 text-[9px] font-bold ${staff.role === 'ADMIN' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600'}`}>{staff.role || 'STAFF'}</span><span className="rounded border border-teal-200 bg-teal-50 px-2 py-0.5 text-[9px] font-bold text-teal-800">{specialistClinic?.name || specialistCurrentUser.clinicId}</span></div><p className="mt-1 text-xs text-slate-400">{staff.id} · {staff.active ? 'Active' : 'Inactive'}</p></div>
                        </div>
                        <button type="button" onClick={() => { setEditingSpecialistStaffId(staff.id); setSpecialistStaffIdInput(staff.id); setSpecialistStaffNameInput(staff.displayName); setSpecialistStaffPasswordInput(''); setShowSpecialistStaffPassword(false); setShowSpecialistStaffForm(true); }} className="shrink-0 rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold text-teal-800 hover:bg-teal-50"><Edit2 size={13} className="mr-1 inline"/> Edit</button>
                      </div>
                    )) : <div className="rounded-2xl border border-slate-200 px-4 py-10 text-center text-sm text-slate-500">No staff accounts have been added for this clinic yet.</div>}
                  </div>
                </section>
              </div>
              <div className="border-t border-slate-100 bg-slate-50 px-4 py-4 text-center text-[9px] font-bold uppercase tracking-wide text-slate-400">Only specialist administrators can manage these credentials. Keep passwords secure.</div>
            </section>
          </div>
        )}
{isAuthenticating && (
          <div className="fixed inset-0 z-[99999] flex items-center justify-center bg-black/30 backdrop-blur-sm">
            <div className="flex w-[calc(100vw-1rem)] max-w-[300px] flex-col items-center rounded-2xl border border-white/40 bg-white/95 px-6 py-7 shadow-2xl backdrop-blur-xl">
              <div className="mb-5 h-10 w-10 animate-spin rounded-full border-4 border-slate-200 border-t-teal-700"></div>
              <p className="text-center text-sm font-black uppercase tracking-[0.2em] text-slate-800">
                {authMessage.includes('Protecting') ? 'Protecting Patient Data...' : 'Ending Clinical Session...'}
              </p>
              <p className="mt-2 text-center text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                {authMessage.includes('Protecting') ? 'Securely closing specialist access' : 'Please wait'}
              </p>
            </div>
          </div>
        )}
        {specialistComingSoonFeature && (
          <div
            className="fixed inset-0 z-[500] flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm"
            onClick={() => setSpecialistComingSoonFeature(null)}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="specialist-coming-soon-title"
              className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-2xl"
              onClick={e => e.stopPropagation()}
            >
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-50 text-amber-600">
                <Clock size={28} />
              </div>
              <span className="inline-flex rounded-full bg-amber-100 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-amber-700">Coming Soon · In Progress</span>
              <h3 id="specialist-coming-soon-title" className="mt-3 text-lg font-black text-slate-800">{specialistComingSoonFeature}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-500">Ciri ini sedang dalam pembangunan dan akan tersedia dalam kemas kini SINAR yang akan datang.</p>
              <button
                onClick={() => setSpecialistComingSoonFeature(null)}
                className="mt-5 w-full rounded-xl bg-teal-700 px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-teal-800"
              >Close</button>
            </div>
          </div>
        )}
        {selectedSpecialistReferral && (
          <div
            className="fixed inset-0 z-[300] flex flex-col bg-slate-950/70 backdrop-blur-sm"
            onClick={() => setSelectedSpecialistReferral(null)}
          >
            <div
              className="flex min-h-0 flex-1 flex-col"
              onClick={e => e.stopPropagation()}
            >
              {/* Fixed popup header; only the document area scrolls. */}
              <div className="z-10 flex shrink-0 items-center justify-between gap-3 bg-gradient-to-r from-teal-950 to-teal-800 px-4 py-3 text-white shadow-lg sm:px-6">
                <div className="min-w-0">
                  <p className="text-[10px] font-black uppercase tracking-widest text-teal-200">SINAR · Specialist Referral Review</p>
                  <h2 className="truncate text-base font-black sm:text-lg">{selectedSpecialistReferral.patientName || selectedSpecialistReferral.patient?.name || 'Patient Referral'}</h2>
                  <p className="text-xs text-teal-100">IC: {selectedSpecialistReferral.icNumber || selectedSpecialistReferral.patientIC || selectedSpecialistReferral.patient?.icNumber || '-'}</p>
                </div>
                <button type="button" onClick={() => setSelectedSpecialistReferral(null)} className="shrink-0 rounded-lg px-3 py-2 text-lg font-bold hover:bg-white/10" aria-label="Close referral">×</button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4 sm:px-6 sm:py-6">
                {(() => {
                  const referral = selectedSpecialistReferral;
                  const normalizedReferralStatus = String(referral.status || referral.referralStatus || '').toLowerCase().replace(/[_-]+/g, ' ').trim();
                  const isReturnedReport = ['returned', 'returned to clinic', 'sent back', 'sent back to clinic', 'returned to referring clinic', 'completed and returned'].includes(normalizedReferralStatus);
                  const snapshot = referral.appointmentSnapshot || {};
                  const fields = referral.formFields || {};
                  const referringClinic = clinics.find(c => c.id === referral.referringClinicId);
                  const clinicName = referral.referringClinicName || referral.fromClinicName || snapshot.clinicName || referringClinic?.name || '';
                  const inputClass = "min-w-0 w-full border-0 border-b border-dotted border-slate-500 bg-transparent px-1 py-0.5 text-[11px] sm:text-xs text-slate-900 outline-none focus:border-blue-700 focus:ring-0 rounded-none placeholder:text-slate-400";
                  const labelClass = "shrink-0 text-[10px] sm:text-[11px] font-semibold text-slate-700";
                  const valueField = (label: string, value: unknown, extraClass = '') => (
                    <div className="flex min-w-0 items-baseline gap-1.5">
                      <span className={labelClass}>{label}:</span>
                      <span className={`min-w-0 flex-1 border-b border-dotted border-slate-500 px-1 py-0.5 text-[11px] text-slate-900 ${extraClass}`}>{String(value ?? '').trim() || '—'}</span>
                    </div>
                  );
                  const specialistRuledField = (key: string, label: string, rows = 3) => (
                    <div key={key} className="min-w-0">
                      <div className={labelClass + " mb-1 block"}>{label}:</div>
                      {isReturnedReport ? (
                        <div aria-readonly="true" className="min-h-[84px] w-full whitespace-pre-wrap break-words rounded-none px-1 py-0 text-[11px] leading-[28px] text-slate-900" style={{ backgroundImage: 'repeating-linear-gradient(to bottom, transparent 0px, transparent 26px, #94a3b8 27px, transparent 28px)', backgroundSize: '100% 28px' }}>{specialistReferralSection6[key] || '—'}</div>
                      ) : (
                        <textarea rows={rows} value={specialistReferralSection6[key] || ''} onChange={e => setSpecialistReferralSection6(v => ({...v, [key]: e.target.value}))}
                          className="block w-full resize-y rounded-none border-0 bg-transparent px-1 py-0 text-[11px] leading-[28px] text-slate-900 outline-none focus:ring-0 placeholder:text-slate-400"
                          style={{ backgroundImage: 'repeating-linear-gradient(to bottom, transparent 0px, transparent 26px, #94a3b8 27px, transparent 28px)', backgroundSize: '100% 28px' }} />
                      )}
                    </div>
                  );
                  const section = (n: number, title: string) => (
                    <div className="mb-2 flex items-center gap-2 rounded-sm border-l-[3px] border-blue-900 bg-blue-50 px-2 py-1.5">
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-blue-950 text-[10px] font-bold text-white">{n}</span>
                      <span className="text-[11px] font-black uppercase tracking-wide text-blue-950">{title}</span>
                    </div>
                  );
                  const eyeInfo = (eye: 'right' | 'left') => {
                    const details = eye === 'right' ? snapshot.rightEyeReviewDetails : snapshot.leftEyeReviewDetails;
                    const review = eye === 'right' ? snapshot.rightEyeReview : snapshot.leftEyeReview;
                    const imageStatus = eye === 'right' ? snapshot.rightEyeImageStatus : snapshot.leftEyeImageStatus;
                    const imageReason = eye === 'right' ? snapshot.rightEyeImageReason : snapshot.leftEyeImageReason;
                    return {
                      text: imageStatus === 'Not Obtainable' ? `Not Obtainable${imageReason ? ` — ${imageReason}` : ''}` : (details?.status || review || 'Belum direkodkan'),
                      types: (details?.abnormalTypes || []).join(', '),
                      severity: details?.npdrSeverity || '',
                      notes: [details?.othersText, details?.comment].filter(Boolean).join(' — ')
                    };
                  };
                  const miniValue = (key: string) => String(snapshot[key] || fields[key] || '').trim() || '—';
                  return (
                    <div className="mx-auto flex w-full max-w-[900px] flex-col items-center gap-6 text-slate-900">
                      {/* PAGE 1 — same structure and styling as SINAR clinic print preview */}
                      <div className="w-full max-w-[794px] bg-white px-5 py-5 shadow-2xl ring-1 ring-black/10 sm:px-8 sm:py-7 min-h-[1000px] text-[11px]">
                        <div className="mb-3 grid grid-cols-[76px_minmax(0,1fr)] items-center gap-3 border-b-[3px] border-blue-950 pb-3">
                          <div className="flex flex-col items-center gap-1">
                            <img src={roundLogo} alt="SINAR logo" className="h-12 w-12 object-contain"/>
                            <img src={textLogo} alt="SINAR" className="h-4 max-w-[76px] object-contain"/>
                          </div>
                          <div className="text-center">
                            <h3 className="text-sm font-black text-blue-950 sm:text-base">REKOD PEMERIKSAAN FUNDUS &amp; RUJUKAN</h3>
                            <p className="mt-1 text-[10px] font-bold text-slate-600">{clinicName}</p>
                            {referringClinic?.address && <p className="mt-0.5 whitespace-pre-line text-[9px] leading-tight text-slate-500">{referringClinic.address}</p>}
                            {referringClinic?.phone && <p className="mt-0.5 text-[9px] font-semibold text-slate-600">Tel: {referringClinic.phone}</p>}
                          </div>
                        </div>

                        {section(1, 'Maklumat Pesakit')}
                        <div className="mb-3 space-y-2 px-1">
                          <div className="grid grid-cols-1 gap-x-5 gap-y-2 sm:grid-cols-2">
                            {valueField('Nama Pesakit', referral.patientName || referral.patient?.name)}
                            {valueField('No. K/P', referral.icNumber || referral.patientIC || referral.patient?.icNumber)}
                            {valueField('Klinik Kesihatan (Asal)', clinicName)}
                            {valueField('No. Telefon', referral.phoneNumber || referral.patient?.phoneNumber)}
                          </div>
                          <div className="grid grid-cols-1 gap-x-5 gap-y-2 sm:grid-cols-2">
                            {valueField('Diabetes Mellitus sejak', fields.dmDuration)}
                            {valueField('HbA1c', fields.hba1c)}
                            {valueField('Penyakit Lain', fields.otherDiseases || (snapshot.diseaseTypes || []).concat(snapshot.otherDisease ? [snapshot.otherDisease] : []).join(', '))}
                            {valueField('Tarikh Pemeriksaan', referral.date ? new Date(referral.date).toLocaleDateString('en-GB') : '')}
                          </div>
                          {valueField('Sejarah ringkas', fields.history)}
                        </div>

                        {section(2, 'Visual Acuity (V/A)')}
                        <div className="mb-4 overflow-hidden border border-slate-300">
                          <div className="grid grid-cols-3 bg-blue-50 text-[10px] font-black text-blue-950">
                            <div className="p-2">PEMERIKSAAN</div>
                            <div className="border-l border-slate-300 p-2 text-center">RE (MATA KANAN)</div>
                            <div className="border-l border-slate-300 p-2 text-center">LE (MATA KIRI)</div>
                          </div>
                          {[{label:'Unaided',right:'rightEyeVAUnaided',left:'leftEyeVAUnaided'},{label:'With Glasses',right:'rightEyeVAWithGlasses',left:'leftEyeVAWithGlasses'},{label:'Pinhole',right:'rightEyeVAPinhole',left:'leftEyeVAPinhole'}].map(row => (
                            <div key={row.label} className="grid min-h-8 grid-cols-3 items-center border-t border-slate-300">
                              <div className="px-2 py-1 text-[11px]">{row.label}</div>
                              <div className="border-l border-slate-300 px-2 py-1 text-center text-[11px]">{miniValue(row.right)}</div>
                              <div className="border-l border-slate-300 px-2 py-1 text-center text-[11px]">{miniValue(row.left)}</div>
                            </div>
                          ))}
                        </div>

                        {section(3, 'Gambar Fundus')}
                        <div className="mb-4 grid grid-cols-2 gap-3">
                          {[{title:'MATA KANAN (RE)',image:snapshot.rightEyePhoto,uploadedBy:snapshot.rightEyeUploadedBy || referral.rightEyeUploadedBy,uploadedAt:snapshot.rightEyePhotoUploadedAt || referral.rightEyePhotoUploadedAt},{title:'MATA KIRI (LE)',image:snapshot.leftEyePhoto,uploadedBy:snapshot.leftEyeUploadedBy || referral.leftEyeUploadedBy,uploadedAt:snapshot.leftEyePhotoUploadedAt || referral.leftEyePhotoUploadedAt}].map(photo => {
                            const uploadedDate = photo.uploadedAt
                              ? (typeof (photo.uploadedAt as any)?.toDate === 'function' ? (photo.uploadedAt as any).toDate() : new Date(photo.uploadedAt as any))
                              : null;
                            const uploadedByName = photo.uploadedBy ? (getUserDisplayName(photo.uploadedBy) || String(photo.uploadedBy)) : '';
                            return (
                              <div key={photo.title} className="rounded-sm border border-slate-300 p-2">
                                <h4 className="mb-2 text-center text-[10px] font-black text-blue-950">{photo.title}</h4>
                                <button type="button" onClick={() => { if (photo.image) { setSpecialistZoomImage(photo.image); setSpecialistZoomEye(photo.title); setSpecialistImageZoom(1); } }} className="flex h-36 w-full items-center justify-center border border-slate-200 bg-slate-50">
                                  {photo.image ? <img src={photo.image} alt={photo.title} className="max-h-full max-w-full object-contain"/> : <span className="text-[10px] text-slate-400">Tiada gambar fundus</span>}
                                </button>
                                <p className="mt-2 text-center text-[9px] text-slate-600">Tarikh / masa imej: {uploadedDate && !Number.isNaN(uploadedDate.getTime()) ? uploadedDate.toLocaleString('en-GB') : '—'}</p>
                                <p className="text-center text-[9px] text-slate-600">Dimuat naik oleh: {uploadedByName || '—'}</p>
                              </div>
                            );
                          })}
                        </div>

                        {section(4, 'Dapatan Pemeriksaan')}
                        <div className="mb-3 grid grid-cols-2 gap-3">
                          {[{title:'MATA KANAN (RE)',data:eyeInfo('right')},{title:'MATA KIRI (LE)',data:eyeInfo('left')}].map(eye => (
                            <div key={eye.title} className="overflow-hidden rounded-sm border border-slate-300">
                              <h4 className="bg-blue-50 px-2 py-1.5 text-[10px] font-black text-blue-950">{eye.title}</h4>
                              <div className="space-y-1 p-2 text-[10px]">
                                <p><b>Status:</b> {eye.data.text}</p>
                                <p><b>Jenis abnormaliti:</b> {eye.data.types || '—'}</p>
                                <p><b>NPDR severity:</b> {eye.data.severity || '—'}</p>
                                <p><b>Catatan:</b> {eye.data.notes || '—'}</p>
                              </div>
                            </div>
                          ))}
                        </div>
                        <div className="mb-3 grid grid-cols-[100px_minmax(0,1fr)] gap-3 px-1">
                          <div className="flex items-baseline gap-1.5"><span className={labelClass}>Kes Dirujuk:</span><span className="text-[11px] font-bold">{snapshot.referred === true ? 'Ya' : 'Tidak'}</span></div>
                          {valueField('Jika Ya, nyatakan sebab', fields.referralReason || referral.referralReason || referral.reason)}
                        </div>

                        {section(5, 'Pengesahan Petugas')}
                        <div className="mb-3 space-y-2 px-1">
                          <div className="grid grid-cols-1 gap-x-5 gap-y-2 sm:grid-cols-2">
                            {valueField('Nama Petugas', fields.staffName)}
                            {valueField('Jawatan', fields.staffDesignation)}
                          </div>
                          <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-3">
                            {valueField('Tandatangan', '')}
                            {valueField('Cop Rasmi', fields.staffStamp)}
                            {valueField('Tarikh', fields.staffDate || (referral.date ? new Date(referral.date).toLocaleDateString('en-GB') : ''))}
                          </div>
                        </div>
                        <p className="mt-4 text-right text-[8px] text-slate-400">Halaman 1 · Rekod pemeriksaan fundus SINAR</p>
                      </div>

                      {/* PAGE 2 — exact continuation layout from the clinic PDF; Section 6 remains editable. */}
                      <div className="w-full max-w-[794px] bg-white px-5 py-5 shadow-2xl ring-1 ring-black/10 sm:px-8 sm:py-7 min-h-[1000px] text-[11px]">
                        <h3 className="text-sm font-black text-blue-950 sm:text-base">SAMBUNGAN REKOD PEMERIKSAAN FUNDUS &amp; RUJUKAN</h3>
                        <div className="mt-2 border-b border-slate-300 pb-3 text-[10px] text-slate-700">
                          <span className="font-semibold">Nama:</span> {referral.patientName || referral.patient?.name || '—'}
                          <span className="ml-6 font-semibold">No. K/P:</span> {referral.icNumber || referral.patientIC || '—'}
                        </div>
                        <div className="mt-5">
                          {section(6, 'Untuk Kegunaan Pakar Oftalmologi')}
                          <div className="space-y-5 px-1 pt-3">
                            {specialistRuledField('ophthalmologyReport', 'Laporan', 3)}
                            {specialistRuledField('ophthalmologyRecommendation', 'Syor', 3)}
                            <div className="pt-1">
                              <div className={labelClass + " mb-1 block"}>Temujanji di Klinik Oftalmologi:</div>
                              {isReturnedReport ? (
                                <div aria-readonly="true" className="w-56 max-w-full border-b border-dotted border-slate-500 px-1 py-1 text-[11px] text-slate-900">{specialistReferralSection6.ophthalmologyAppointment ? new Date(`${specialistReferralSection6.ophthalmologyAppointment}T00:00:00`).toLocaleDateString('en-GB') : '—'}</div>
                              ) : (
                                <input type="date" value={specialistReferralSection6.ophthalmologyAppointment || ''} onChange={e => setSpecialistReferralSection6(v => ({...v,ophthalmologyAppointment:e.target.value}))}
                                  className="w-56 max-w-full rounded-none border-0 border-b border-dotted border-slate-500 bg-transparent px-1 py-1 text-[11px] text-slate-900 outline-none focus:border-blue-700 focus:ring-0" />
                              )}
                            </div>
                            <div className="grid grid-cols-1 gap-4 pt-2 sm:grid-cols-2">
                              <label className={labelClass + " block"}>Nama Doktor
                                {isReturnedReport ? (
                                  <div aria-readonly="true" className="mt-1 min-h-7 w-full border-b border-dotted border-slate-500 px-1 py-1 text-[11px] font-normal text-slate-900">{specialistReferralSection6.ophthalmologyDoctorName || '—'}</div>
                                ) : (
                                  <input value={specialistReferralSection6.ophthalmologyDoctorName || ''} onChange={e => setSpecialistReferralSection6(v => ({...v,ophthalmologyDoctorName:e.target.value}))}
                                    className="mt-1 w-full rounded-none border-0 border-b border-dotted border-slate-500 bg-transparent px-1 py-1 text-[11px] font-normal text-slate-900 outline-none focus:border-blue-700 focus:ring-0" placeholder="" />
                                )}
                              </label>
                              <label className={labelClass + " block"}>Jawatan
                                {isReturnedReport ? (
                                  <div aria-readonly="true" className="mt-1 min-h-7 w-full border-b border-dotted border-slate-500 px-1 py-1 text-[11px] font-normal text-slate-900">{specialistReferralSection6.ophthalmologyDesignation || '—'}</div>
                                ) : (
                                  <input value={specialistReferralSection6.ophthalmologyDesignation || ''} onChange={e => setSpecialistReferralSection6(v => ({...v,ophthalmologyDesignation:e.target.value}))}
                                    className="mt-1 w-full rounded-none border-0 border-b border-dotted border-slate-500 bg-transparent px-1 py-1 text-[11px] font-normal text-slate-900 outline-none focus:border-blue-700 focus:ring-0" placeholder="" />
                                )}
                              </label>
                            </div>
                            <p className="pt-2 text-right text-[9px] text-slate-400">
                              {isReturnedReport
                                ? `Tarikh laporan: ${formatReferralReturnedDate(referral) || '—'}`
                                : 'Tarikh laporan akan dijana secara automatik apabila dihantar semula ke klinik'}
                            </p>
                          </div>
                        </div>
                        <p className="mt-12 text-right text-[8px] text-slate-400">Halaman 2 · Untuk kegunaan pakar oftalmologi</p>
                      </div>
                    </div>
                  );
                })()}
              </div>

              <div className="z-10 flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-white px-4 py-3 shadow-[0_-4px_12px_rgba(0,0,0,0.08)] sm:px-6">
                {(() => {
                  const status = String(selectedSpecialistReferral.status || selectedSpecialistReferral.referralStatus || '').toLowerCase().replace(/[_-]+/g, ' ').trim();
                  const readOnlyReturned = ['returned', 'returned to clinic', 'sent back', 'sent back to clinic', 'returned to referring clinic', 'completed and returned'].includes(status);
                  return readOnlyReturned ? (
                    <>
                      <span className="text-xs font-semibold text-emerald-700">Laporan pakar telah dihantar ke klinik — mod paparan sahaja</span>
                      <button type="button" onClick={() => setSelectedSpecialistReferral(null)} className="rounded-lg bg-teal-800 px-6 py-2 text-xs font-black text-white transition hover:bg-teal-900">Close</button>
                    </>
                  ) : (
                    <>
                      <span className="text-xs text-slate-500">Lengkapkan Section 6 dan simpan laporan pakar</span>
                      <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={() => void saveSpecialistReferral(false)} disabled={specialistReferralSaving} className="rounded-lg border border-teal-700 px-4 py-2 text-xs font-black text-teal-800 disabled:opacity-50">{specialistReferralSaving ? 'Saving...' : 'Save Draft'}</button>
                        <button type="button" onClick={() => { if (window.confirm('Hantar laporan lengkap ini semula ke klinik yang merujuk? Referral akan dikeluarkan daripada inbox pakar.')) void saveSpecialistReferral(true); }} disabled={specialistReferralSaving} className="rounded-lg bg-teal-800 px-4 py-2 text-xs font-black text-white disabled:opacity-50">{specialistReferralSaving ? 'Processing...' : 'Send Back to Clinic'}</button>
                      </div>
                    </>
                  );
                })()}
              </div>
            </div>
          </div>
        )}
        {specialistZoomImage && (
          <div className="fixed inset-0 z-[400] flex items-center justify-center bg-slate-950/75 p-4 backdrop-blur-sm" onClick={() => setSpecialistZoomImage(null)}>
            <div className="relative flex h-[68vh] max-h-[680px] min-h-[320px] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white p-3 shadow-2xl sm:h-[72vh]" onClick={e => e.stopPropagation()}>
              <div className="mb-2 flex shrink-0 items-center justify-between gap-3">
                <span className="text-xs font-bold text-slate-600">{specialistZoomEye || 'FUNDUS IMAGE'}</span>
                <button type="button" onClick={() => setSpecialistZoomImage(null)} className="rounded-lg bg-slate-100 px-3 py-1.5 text-lg font-bold text-slate-700" aria-label="Close image">×</button>
              </div>
              <div
                className={`relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg bg-slate-950 p-2 touch-none select-none ${specialistImageZoom > 1 ? 'cursor-grab active:cursor-grabbing' : 'cursor-zoom-in'}`}
                onWheel={e => {
                  e.preventDefault(); e.stopPropagation();
                  const nextZoom = Math.max(1, Math.min(4, specialistImageZoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
                  setSpecialistImageZoom(nextZoom);
                  if (nextZoom === 1) setSpecialistImagePan({ x: 0, y: 0 });
                }}
                onPointerDown={e => {
                  if (e.pointerType !== 'mouse' || specialistImageZoom <= 1) return;
                  e.preventDefault();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  specialistPanStartRef.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, originX: specialistImagePan.x, originY: specialistImagePan.y };
                }}
                onPointerMove={e => {
                  const start = specialistPanStartRef.current;
                  if (e.pointerType !== 'mouse' || !start || start.pointerId !== e.pointerId || specialistImageZoom <= 1) return;
                  e.preventDefault();
                  setSpecialistImagePan({ x: start.originX + e.clientX - start.x, y: start.originY + e.clientY - start.y });
                }}
                onPointerUp={e => { if (specialistPanStartRef.current?.pointerId === e.pointerId) specialistPanStartRef.current = null; }}
                onPointerCancel={() => { specialistPanStartRef.current = null; }}
                onTouchStart={e => { if (e.touches.length === 2) { const dx = e.touches[0].clientX - e.touches[1].clientX; const dy = e.touches[0].clientY - e.touches[1].clientY; specialistPinchStartDistanceRef.current = Math.hypot(dx, dy); specialistPinchStartZoomRef.current = specialistImageZoom; } }}
                onTouchMove={e => { if (e.touches.length === 2 && specialistPinchStartDistanceRef.current) { e.preventDefault(); const dx = e.touches[0].clientX - e.touches[1].clientX; const dy = e.touches[0].clientY - e.touches[1].clientY; const distance = Math.hypot(dx, dy); const nextZoom = Math.max(1, Math.min(4, specialistPinchStartZoomRef.current * (distance / specialistPinchStartDistanceRef.current))); setSpecialistImageZoom(nextZoom); if (nextZoom === 1) setSpecialistImagePan({x:0,y:0}); } }}
                onTouchEnd={() => { specialistPinchStartDistanceRef.current = null; }}
              >
                <img src={specialistZoomImage} alt={specialistZoomEye || 'Fundus image'} draggable={false} style={{ transform: `translate(${specialistImagePan.x}px, ${specialistImagePan.y}px) scale(${specialistImageZoom})`, transformOrigin: 'center center', maxWidth: '100%', maxHeight: '100%' }} className="h-full w-full object-contain pointer-events-none" />
              </div>
            </div>
          </div>
        )}
        <footer className="mt-auto px-4 pb-5 pt-2 text-center text-[10px] font-bold uppercase tracking-widest text-slate-500">SINAR SPECIALIST PORTAL · {APP_VERSION}</footer>
      </div>
    );
  }

  // --- Views ---

  if (!currentUser && !specialistCurrentUser) {
    return (
  <>
  {isAuthenticating && (

  <div className="fixed inset-0 z-[99999] bg-black/30 backdrop-blur-sm flex items-center justify-center">

    <div className="bg-white/95 backdrop-blur-xl rounded-2xl px-6 sm:px-8 py-6 sm:py-7 shadow-2xl flex flex-col items-center w-[calc(100vw-1rem)] max-w-[300px] border border-white/40">

      <div className="w-10 h-10 border-4 border-slate-200 border-t-blue-600 rounded-full animate-spin mb-5"></div>

      <div className="flex flex-col items-center">

        <p className="text-sm font-black uppercase tracking-[0.25em] text-slate-800 text-center">

          Verifying Credentials...

        </p>

        <p className="mt-3 text-xs font-semibold uppercase tracking-widest text-slate-400 text-center">

          Secure Clinical Access

        </p>

      </div>

    </div>

  </div>

)}
      <div
  className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden"
  style={{
    backgroundImage: `url(${fundusBg})`,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat'
  }}
>
  <div className="absolute inset-0 bg-slate-900/25 backdrop-blur-[0px]" />
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="relative z-10 bg-white/92 backdrop-blur-md rounded-3xl shadow-2xl p-8 w-full max-w-md border border-white/40"
        >
          <div className="flex flex-col items-center mb-10">
            <div className="overflow-hidden mb-6 h-40">
              <img 
                src={clinicLogo} 
                alt={`${currentClinic?.name || 'Klinik Kesihatan Lintang'} Logo`}
                className="w-full h-full object-cover"
              />
            </div>
            {/*---SINAR platform identity: clinic is display context, not the product identity---*/}
            <p className="text-slate-600 font-bold text-[11px] tracking-wide mt-1">Sistem Interpretasi &amp; Nota Awal Retinopati</p>
            <p className="text-blue-600 font-black text-[10px] uppercase tracking-[0.2em] mt-1">Fundus Screening Platform</p>
          </div>
          
          <form onSubmit={handleLogin} className="space-y-5">
            {loginError && (
              <motion.div 
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                className="bg-rose-50 border border-rose-100 text-rose-600 px-4 py-3 rounded-xl text-xs font-bold flex items-center gap-2"
              >
                <AlertCircle size={14} />
                {loginError}
              </motion.div>
            )}

{/* User ID Field Login Pages */}
<div className="space-y-1.5">
  <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Staff User ID</label>
    <div className="relative">
      <UserIcon size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-300" />
      <input 
        autoFocus
        type="text" 
        autoComplete="off"
        required
        className="w-full pl-12 pr-4 py-4 rounded-xl border border-slate-400 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all outline-none text-sm font-medium"
        placeholder="ID or Username"
        value={tempUserId}
        onChange={e => setTempUserId(e.target.value)}
        />
    </div>
</div>

{/* Password Field Login Pages */}
<div className="space-y-1.5">
  <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Password</label>
    <div className="relative">

  <Lock
    size={18}
    className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-300"
  />

  <input
    type={showLoginPassword ? "text" : "password"}
    autoComplete="current-password"
    required
    className="w-full pl-12 pr-12 py-4 rounded-xl border border-slate-400 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all outline-none text-sm font-medium text-slate-800"
    placeholder="••••••"
    value={tempPassword}
    onChange={e => setTempPassword(e.target.value)}
  />

  <button
    type="button"
    onClick={() =>
      setShowLoginPassword(prev => !prev)
    }
    className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 cursor-pointer transition-all"
    aria-label={
      showLoginPassword
        ? "Hide password"
        : "Show password"
    }
  >
    {showLoginPassword ? (
      <EyeOff size={18} />
    ) : (
      <Eye size={18} />
    )}
  </button>

</div>
            </div>

            <button 
              type="submit"
              className="w-full bg-slate-900 hover:bg-black text-white font-black py-4 rounded-2xl transition-all shadow-xl active:scale-[0.98] mt-4 uppercase tracking-widest text-xs"
            >
              Sign In to System
            </button>
            <div className="flex flex-col items-center leading-none mt-1 gap-1">
  <p className="text-[10px] text-slate-400 font-bold uppercase tracking-tighter">
    Authorized Personnel Only
  </p>

  <p className="text-[9px] text-slate-500 font-semibold uppercase tracking-wide">
    {APP_VERSION}
  </p>
</div>
          </form>
        </motion.div>
      </div>
    </>
    );
  }

  return (
  <>
{showPboaWarning && (

  <div className="fixed inset-0 z-[99999] bg-black/40 flex items-center justify-center">

    <div className="bg-white rounded-2xl shadow-2xl p-4 sm:p-6 w-[calc(100vw-1rem)] max-w-[350px] max-h-[calc(100dvh-1rem)] overflow-y-auto overscroll-contain">

      <div className="flex items-center gap-3 mb-4">

        <AlertCircle
          className="text-amber-500"
          size={24}
        />

        <h3 className="font-black text-slate-800">
          Invalid Date
        </h3>

      </div>

      <p className="text-sm text-slate-600 mb-6">
        ⚠️ PBOA appointments are only available on Fridays.
      </p>

      <button
        onClick={() =>
          setShowPboaWarning(false)
        }
        className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 rounded-xl"
      >
        OK
      </button>

    </div>

  </div>

)}
    {isAuthenticating && (

  <div className="fixed inset-0 z-[99999] bg-black/30 backdrop-blur-sm flex items-center justify-center">

    <div className="bg-white/95 backdrop-blur-xl rounded-2xl px-6 sm:px-8 py-6 sm:py-7 shadow-2xl flex flex-col items-center w-[calc(100vw-1rem)] max-w-[300px] border border-white/40">

      {/* Spinner */}
      <div className="w-10 h-10 border-4 border-slate-200 border-t-blue-600 rounded-full animate-spin mb-5"></div>

      {/* Main Text */}
      <p className="text-sm font-black uppercase tracking-[0.25em] text-slate-800 text-center">

        {authMessage.includes('Ending')
          ? 'Ending Clinical Session...'
          : 'Verifying Credentials...'}

      </p>

      {/* Sub Text */}
      <p className="mt-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400 text-center">

        {authMessage.includes('Ending')
          ? 'Protecting Patient Data'
          : 'Secure Clinical Access'}

      </p>

    </div>

  </div>

)}

{showTCASchedule && (

  <div className="fixed inset-0 z-[99999] bg-black/40 flex items-center justify-center">

    <div className="bg-white rounded-3xl shadow-2xl w-[calc(100vw-1rem)] sm:w-[92vw] max-w-[560px] max-h-[calc(100dvh-1rem)] sm:max-h-[calc(100dvh-2rem)] flex flex-col overflow-hidden">

      <div className="p-5 border-b border-slate-300 flex items-center justify-between bg-gradient-to-r from-slate-100 to-slate-200">

        <div>

          <h2 className="text-lg font-black text-slate-800">
            📅 Fundus TCA Schedule
          </h2>

          <p className="text-xs text-slate-600 font-semibold">
            Upcoming TCA Appointments
          </p>

        </div>

        <button
          onClick={() =>
            setShowTCASchedule(false)
          }
          className="text-slate-400 hover:text-slate-700"
        >
          ✕
        </button>

      </div>

      <div className="p-5 space-y-3 overflow-y-auto flex-1 scrollbar-thin scrollbar-thumb-slate-300 scrollbar-track-transparent">

        {tcaSchedule.length === 0 ? (

          <div className="text-center py-6 md:py-10 text-slate-400 font-medium">
  No upcoming appointments
</div>

        ) : (

          tcaSchedule.map(([date, stats]) => {

            return (

              <div
                key={date}
                className="border border-slate-200 rounded-2xl p-4 md:p-5 bg-white shadow-sm hover:shadow-md hover:border-blue-200 transition-all"
              >

                <div className="flex items-center justify-between">

                  <div>

                    <div className="flex items-start justify-between gap-3">

  <p className="font-black text-slate-800">
    {new Date(date).toLocaleDateString(
      'en-GB',
      {
        day: '2-digit',
        month: 'long',
        year: 'numeric'
      }
    )},
    {' '}
    {new Date(date).toLocaleDateString(
      'en-GB',
      {
        weekday: 'long'
      }
    )}
  </p>

  <div className="flex items-center gap-2">

    {(() => {

      const tomorrow = new Date();

      tomorrow.setDate(
        tomorrow.getDate() + 1
      );

      return date === tomorrow.toLocaleDateString('en-CA');

    })() && (

      <span className="bg-amber-100 text-amber-700 border border-amber-300 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-wide whitespace-nowrap flex items-center gap-1">
        🔔 TOMORROW
      </span>

    )}

    {(() => {
  // ============================================
  // THIS WEEK = CURRENT CALENDAR WEEK
  // MONDAY → SUNDAY
  // ============================================

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // JavaScript:
  // Sunday = 0
  // Monday = 1
  // Tuesday = 2
  // ...
  // Saturday = 6
  const dayOfWeek = today.getDay();

  // Calculate how many days back to Monday
  const daysFromMonday =
    dayOfWeek === 0
      ? 6
      : dayOfWeek - 1;

  // Monday of current week
  const weekStart = new Date(today);

  weekStart.setDate(
    today.getDate() - daysFromMonday
  );

  weekStart.setHours(0, 0, 0, 0);

  // Sunday of current week
  const weekEnd = new Date(weekStart);

  weekEnd.setDate(
    weekStart.getDate() + 6
  );

  weekEnd.setHours(
    23,
    59,
    59,
    999
  );

  // Appointment date
  const currentDate = new Date(date);

  currentDate.setHours(
    0,
    0,
    0,
    0
  );

  // Tomorrow
  const tomorrow = new Date(today);

  tomorrow.setDate(
    today.getDate() + 1
  );

  tomorrow.setHours(
    0,
    0,
    0,
    0
  );

  // Show THIS WEEK only when:
  // Monday <= appointment <= Sunday
  // AND appointment is NOT tomorrow
  return (
    currentDate >= weekStart &&
    currentDate <= weekEnd &&
    currentDate.getTime() !== tomorrow.getTime()
  );
})() && (

  <span className="bg-sky-100 text-sky-700 border border-sky-300 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-wide whitespace-nowrap">
    📅 THIS WEEK
  </span>

)}

  </div>

</div>

<div className="mt-2 space-y-1">

  {/*--- TCA counts by referring/source clinic ---*/}
  {clinics.map((clinic) => {

    const count = stats[clinic.id] ?? 0;

    //--- Hide clinics with no TCA appointments ---//
    if (count === 0) return null;

    const textClass =
      clinic.id === 'LINTANG'
        ? 'text-sky-600'
        : clinic.id === 'PBOA'
          ? 'text-emerald-600'
          : clinic.id === 'HSS'
            ? 'text-violet-600'
            : 'text-slate-600';

    return (
      <p
        key={clinic.id}
        className={`text-xs font-semibold ${textClass}`}
      >
        {getSourceDisplayName(clinic)} : {count} Patients
      </p>
    );
  })}

  <div className="border-t border-slate-200 pt-1 mt-1">

    <p className="text-xs font-black text-slate-700">
      Total : {stats.total} Patients
    </p>

  </div>

</div>

                  </div>

                </div>

              </div>

            );

          })

        )}

      </div>

    </div>

  </div>

)}

{showAccountSuccess && (

  <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[99999]">

    <div className="bg-emerald-500 text-white px-6 py-4 rounded-2xl shadow-2xl flex items-center gap-3 animate-[fadeIn_.3s_ease]">

      <CheckCircle2 size={22} />

      <div>

        <p className="text-xs font-black uppercase tracking-widest">
          Account Updated
        </p>

        <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-100 mt-1">
          Credentials Updated Successfully
        </p>

      </div>

    </div>

  </div>

)}

    <div className="min-h-screen bg-gradient-to-br from-slate-300 via-blue-100 to-blue-300 flex flex-col font-sans text-slate-900">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-3 py-2 md:h-16 flex flex-col md:flex-row md:items-center justify-center md:justify-between gap-3 md:gap-4">
          <div className="flex items-center gap-3">
            <div className="w-13 h-13 rounded-full overflow-hidden border-2 border-slate-100 shadow-sm bg-white shrink-0">
              <img 
                src={roundLogo} 
                alt={`${currentClinic?.name || 'Klinik Kesihatan Lintang'} Logo`}
                className="w-full h-full object-cover"
              />
            </div>
            <div className="flex flex-col min-w-0">
              {/*---One SINAR identity across every clinic; clinic name is the active tenant context---*/}
              <img 
                src={textLogo} 
                alt={`${currentClinic?.name || 'Klinik Kesihatan Lintang'} Logo`}
                className="w-29 h-6 object-cover"
              />
              <div className="w-auto h-[1px] bg-slate-300 my-1 mt-2" />
              <span className="text-[12px] md:text-xs font-bold text-slate-700 mt-0 truncate">
                {currentUser.role === UserRole.SUPER_ADMIN ? 'Multi-Clinic Administration' : (currentClinic?.name || 'Klinik Kesihatan Lintang')}
              </span>
            </div>
          </div>
          
         <div className="w-full md:w-auto flex items-center justify-between md:justify-end gap-2 md:gap-3 flex-wrap">

  {currentUser.role === UserRole.ADMIN && (

    <>

      <button
  onClick={() => {
    //--- Load only referral clinics already authorised by Super Admin ---//
    const providerClinicId = currentUser?.clinicId;
    const nextDraft: Record<string, number[]> = {};
    if (providerClinicId) {
      clinics
        .filter(c => c.active && c.id !== providerClinicId && (c.fundusProviderClinicIds || []).includes(providerClinicId))
        .forEach(c => {
          nextDraft[c.id] = [...(clinics.find(x => x.id === providerClinicId)?.referralTcaDays?.[c.id] || [])];
        });
    }
    setReferralTcaDraft(nextDraft);
    setShowReferralClinicManager(true);
  }}
  className="flex items-center gap-2 px-2 py-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded-lg text-xs font-bold transition-all border border-indigo-200"
>
  <Calendar size={15} className="text-indigo-600" />
  <span className="hidden md:inline">Manage Referral Clinic</span>
  <span className="md:hidden">Referral</span>
</button>

<button 
  onClick={() => {
    setShowAdminConsole(true);
    setShowStaffForm(false);
    setEditingUser(null);
    setNewStaffId('');
    setNewStaffName('');
    setNewStaffPass('');
    setShowStaffPassword(false);
    setNewStaffRole(UserRole.STAFF);
    setNewStaffClinicId(currentUser?.clinicId ?? 'LINTANG');
  }}
  className="flex items-center gap-2 px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-bold transition-all border border-slate-200"
>
  <ShieldCheck size={15} className="text-blue-600" />

  <span className="hidden md:inline">
    Staff Management
  </span>

  <span className="md:hidden">
    Staff
  </span>

</button>

<button
  onClick={() => setShowMonthlySummary(true)}
  className="flex items-center gap-2 px-2 py-1 bg-cyan-50 hover:bg-cyan-100 text-cyan-700 rounded-lg text-xs font-bold transition-all border border-cyan-200"
>
  <BarChart3 size={15} className="text-cyan-600" />

  <span className="hidden md:inline">
    Monthly Summary
  </span>

  <span className="md:hidden">
    Summary
  </span>
</button>

<button 
  onClick={() => setShowActivityLogs(true)}
  className="flex items-center gap-2 px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-bold transition-all border border-slate-200"
>
  <Activity size={15} className="text-blue-600" />

  <span className="hidden md:inline">
    Activity Logs
  </span>

  <span className="md:hidden">
    Logs
  </span>

</button>

    </>

  )}

  {currentUser.role === UserRole.STAFF && (

    <button 
      onClick={() => setShowAccountSettings(true)}
      className="flex items-center gap-2 px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-bold transition-all border border-slate-200"
    >

      <UserCog size={16} className="text-blue-600" />

      Manage Account

    </button>

  )}
            {/*--- Mobile: keep user identity close to the logout button; desktop layout remains unchanged ---*/}
            <div className="flex items-center gap-1 ml-auto md:ml-0">
              <div className="flex flex-col items-end mr-0 md:mr-2">
                <span className="text-sm font-semibold text-slate-700 uppercase">{currentUser.displayName}</span>
                <span className="text-[11px] font-black text-emerald-600 uppercase tracking-widest">
                  {currentUser.role === UserRole.SUPER_ADMIN ? 'MULTI-CLINIC ADMIN' : (currentClinic?.shortName || 'Clinic')}
                </span>
                <span className="text-[9px] text-slate-400 uppercase tracking-widest font-bold max-w-[240px] truncate">
                  {currentUser.role === UserRole.SUPER_ADMIN
                    ? `SUPER ADMIN`
                    : `${currentUser.role}`}
                </span>
              </div>
              <button 
                onClick={handleLogout}
                className="p-2 text-slate-400 hover:text-rose-500 hover:bg-rose-50 rounded-lg transition-all"
                title="Logout"
              >
                <LogOut size={20} />
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* =====================================================
          SUPER ADMIN HOME DASHBOARD
          Super Admin does not enter a clinic dashboard.
          The landing page is the PKD multi-clinic console.
         ===================================================== */}
      {currentUser.role === UserRole.SUPER_ADMIN && (
        <main className="flex-1 w-full max-w-[1280px] mx-auto flex flex-col gap-5 px-3 md:px-5 py-4 md:py-6">
          <div className="min-w-0 flex-1 space-y-6">
          {activeSuperAdminView !== 'dashboard' && (
            <section className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
              <div><p className="text-[10px] font-black uppercase tracking-[.18em] text-violet-600">SINAR Super Admin</p><p className="mt-1 text-sm text-slate-500">Manage multi-clinic settings and access.</p></div>
              <button type="button" onClick={() => { setActiveSuperAdminView('dashboard'); setShowStaffForm(false); setEditingUser(null); setShowDataMigration(false); }} className="inline-flex items-center justify-center gap-2 self-start rounded-xl border border-teal-500 bg-teal-200 px-4 py-2.5 text-xs font-black text-slate-700 transition hover:bg-teal-500 hover:text-white sm:self-auto"><ChevronLeft size={16}/> Back to Dashboard</button>
            </section>
          )}
          {activeSuperAdminView === 'clinics' ? (
            <div className="space-y-6">
              <section className="bg-white border border-slate-200 rounded-3xl p-5 md:p-7 shadow-sm">
                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-6">
                  <div><h1 className="text-2xl font-black text-slate-900">Clinic Management</h1><p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-1">Dynamic clinic master · {clinics.length} registered clinics</p></div>
                  <button type="button" onClick={() => { setNewClinicId(''); setNewClinicName(''); setNewClinicShortName(''); setNewClinicAddress(''); setNewClinicPhone(''); setNewClinicIsFundusProvider(false); setNewClinicColorKey('pink'); setShowNewClinicForm(v => !v); }} className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-4 py-2.5 text-xs font-black text-white hover:bg-violet-700"><Plus size={16}/> {showNewClinicForm ? 'Cancel' : 'Add clinic'}</button>
                </div>
                {showNewClinicForm && <form onSubmit={async (e) => {
                  e.preventDefault();
                  const id = newClinicId.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
                  if (!id || !newClinicName.trim()) return;
                  if (clinics.some(c => c.id === id)) { alert('Clinic ID already exists.'); return; }
                  setIsAddingClinic(true);
                  const clinic: Clinic = { id, name: newClinicName.trim(), shortName: newClinicShortName.trim() || newClinicName.trim(), address: newClinicAddress.trim(), phone: newClinicPhone.trim(), active: true, isFundusProvider: newClinicIsFundusProvider, colorKey: newClinicColorKey };
                  try {
                    await setDoc(doc(db, 'clinics', clinic.id), clinic);
                    addActivityLog('Created Clinic', `${clinic.name} (${clinic.id})`, currentUser.displayName);
                    setNewClinicId(''); setNewClinicName(''); setNewClinicShortName(''); setNewClinicAddress(''); setNewClinicPhone(''); setNewClinicIsFundusProvider(false); setNewClinicColorKey('pink'); setShowNewClinicForm(false);
                  } catch (error) { console.error('Failed to create clinic', error); alert('Failed to create clinic. Please try again.'); }
                  finally { setIsAddingClinic(false); }
                }} className="mb-6 rounded-2xl border border-violet-100 bg-violet-50/40 p-4 md:p-5">
                  <p className="mb-4 text-xs font-black uppercase tracking-widest text-slate-700">Add new clinic</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                    <input required value={newClinicId} onChange={e => setNewClinicId(e.target.value)} placeholder="CLINIC_ID" className="min-w-0 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-bold uppercase outline-none focus:ring-2 focus:ring-violet-500" />
                    <input required value={newClinicName} onChange={e => setNewClinicName(e.target.value)} placeholder="Clinic name" className="min-w-0 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-violet-500" />
                    <input value={newClinicShortName} onChange={e => setNewClinicShortName(e.target.value)} placeholder="Short name" className="min-w-0 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-violet-500" />
                    <textarea value={newClinicAddress} onChange={e => setNewClinicAddress(e.target.value)} rows={2} placeholder="Full clinic address" className="min-w-0 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-violet-500 xl:col-span-2" />
                    <input value={newClinicPhone} onChange={e => setNewClinicPhone(e.target.value)} placeholder="Clinic telephone number" className="min-w-0 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-violet-500" />
                    <select value={newClinicColorKey} onChange={e => setNewClinicColorKey(e.target.value as ClinicColorKey)} className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-bold outline-none focus:ring-2 focus:ring-violet-500">{CLINIC_COLORS.map(color => <option key={color.key} value={color.key}>{color.label}</option>)}</select>
                    <label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs font-bold text-slate-600"><input type="checkbox" checked={newClinicIsFundusProvider} onChange={e => setNewClinicIsFundusProvider(e.target.checked)} /> Fundus provider</label>
                    <button type="submit" disabled={isAddingClinic} className="rounded-xl bg-violet-600 px-4 py-2.5 text-xs font-black uppercase tracking-widest text-white hover:bg-violet-700 disabled:opacity-50">{isAddingClinic ? 'Saving...' : 'Save clinic'}</button>
                  </div>
                </form>}
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
                  {clinics.map(clinic => <div key={clinic.id} className="flex min-w-0 flex-col gap-4 rounded-2xl border border-slate-200 bg-gradient-to-br from-white to-slate-50 p-4 md:p-5 shadow-sm transition duration-200 hover:-translate-y-0.5 hover:border-violet-200 hover:shadow-lg">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2"><h2 className="font-black text-slate-900">{clinic.name}</h2><span className="rounded-md bg-slate-100 px-2 py-1 text-[9px] font-black uppercase text-slate-500">{clinic.id}</span></div>
                      <p className="mt-1 text-xs text-slate-400">{clinic.shortName}</p>
                      {editingClinicAddressId === clinic.id ? <div className="mt-3 flex max-w-2xl flex-col gap-2"><textarea value={clinicAddressDraft} onChange={e => setClinicAddressDraft(e.target.value)} rows={2} placeholder="Full clinic address" className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"/><input value={clinicPhoneDraft} onChange={e => setClinicPhoneDraft(e.target.value)} placeholder="Clinic phone" className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm sm:max-w-sm"/><div className="flex gap-2"><button type="button" disabled={clinicAddressSaving === clinic.id} onClick={async () => { setClinicAddressSaving(clinic.id); try { await updateDoc(doc(db, 'clinics', clinic.id), { address: clinicAddressDraft.trim(), phone: clinicPhoneDraft.trim() }); addActivityLog('Updated Clinic Address and Telephone', clinic.name, currentUser.displayName); setEditingClinicAddressId(null); } catch (error) { console.error('Failed to update clinic address', error); alert('Failed to update clinic address. Please try again.'); } finally { setClinicAddressSaving(null); } }} className="rounded-lg bg-violet-600 px-3 py-2 text-xs font-black text-white disabled:opacity-50">{clinicAddressSaving === clinic.id ? 'Saving...' : 'Save'}</button><button type="button" disabled={clinicAddressSaving === clinic.id} onClick={() => setEditingClinicAddressId(null)} className="rounded-lg border px-3 py-2 text-xs font-bold">Cancel</button></div></div> : <div className="mt-2 flex flex-wrap items-start gap-3"><div className="min-w-0"><p className="whitespace-pre-line text-xs text-slate-500">{clinic.address || 'Full address not set'}</p><p className="mt-1 text-xs text-slate-500">{clinic.phone ? `Tel: ${clinic.phone}` : 'Telephone not set'}</p></div><button type="button" onClick={() => { setEditingClinicAddressId(clinic.id); setClinicAddressDraft(clinic.address || ''); setClinicPhoneDraft(clinic.phone || ''); }} className="rounded-lg border border-violet-200 px-2 py-1 text-[10px] font-black text-violet-700 hover:bg-violet-50">{clinic.address ? 'Edit address' : 'Add address'}</button></div>}
                    </div>
                    <div className="mt-auto border-t border-slate-100 pt-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[8px] font-black uppercase text-slate-500">Color</span>
                        <select value={getClinicColor(clinic).key} disabled={clinicColorSaving === clinic.id} onChange={e => handleClinicColorChange(clinic, e.target.value as ClinicColorKey)} className="h-9 min-w-[100px] rounded-lg border border-slate-200 bg-white px-2 text-xs font-bold" aria-label={`Choose color for ${clinic.name}`}>{CLINIC_COLORS.map(color => <option key={color.key} value={color.key}>{color.label}</option>)}</select>
                        <button type="button" disabled={clinicStatusSaving === clinic.id} onClick={async () => { const nextActive = !clinic.active; setClinicStatusSaving(clinic.id); try { await updateDoc(doc(db, 'clinics', clinic.id), { active: nextActive }); addActivityLog(nextActive ? 'Activated Clinic' : 'Deactivated Clinic', clinic.name, currentUser.displayName); } catch (error) { console.error('Failed to update clinic status', error); alert('Failed to update clinic status. Please try again.'); } finally { setClinicStatusSaving(null); } }} className={`rounded-lg px-2 py-1 text-[9px] font-black uppercase transition disabled:opacity-50 ${clinic.active ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100' : 'bg-rose-50 text-rose-700 hover:bg-rose-100'}`} title="Click to toggle clinic status">{clinicStatusSaving === clinic.id ? 'Saving...' : clinic.active ? 'Active' : 'Inactive'}</button>
                        <button type="button" disabled={clinicProviderSaving === clinic.id} onClick={async () => { const nextProvider = !clinic.isFundusProvider; setClinicProviderSaving(clinic.id); try { await updateDoc(doc(db, 'clinics', clinic.id), { isFundusProvider: nextProvider }); addActivityLog(nextProvider ? 'Enabled Fundus Provider' : 'Changed to Referral Clinic', clinic.name, currentUser.displayName); } catch (error) { console.error('Failed to update clinic provider status', error); alert('Failed to update clinic provider status. Please try again.'); } finally { setClinicProviderSaving(null); } }} className={`rounded-lg px-2 py-1 text-[9px] font-black uppercase transition disabled:cursor-not-allowed disabled:opacity-50 ${clinic.isFundusProvider ? 'bg-blue-50 text-blue-700 hover:bg-blue-100' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`} title={!clinic.active && clinic.isFundusProvider ? 'Inactive provider is unavailable for referral routing' : 'Click to toggle provider/referral status'}>{clinicProviderSaving === clinic.id ? 'Saving...' : clinic.isFundusProvider ? 'Fundus Provider' : 'Referral Clinic'}</button>
                        <button type="button" onClick={() => handleDeleteClinic(clinic)} className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[9px] font-black uppercase text-rose-600 hover:bg-rose-100" title={`Delete ${clinic.name}`}><Trash2 size={13}/>Delete</button>
                      </div>
                    </div>
                  </div>)}
                </div>
              </section>
            </div>
          ) : activeSuperAdminView === 'users' ? (
            <section className="space-y-5">
              <div className="rounded-3xl border border-slate-200 bg-white p-5 md:p-7 shadow-sm">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div><p className="text-[10px] font-black uppercase tracking-[.18em] text-violet-600">Administration</p><h1 className="mt-1 text-2xl font-black text-slate-900">User Management</h1><p className="mt-1 text-sm text-slate-500">Find accounts by name, staff ID, clinic or role.</p></div>
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="rounded-2xl bg-violet-50 px-4 py-3"><p className="text-xs font-bold text-violet-700">Registered users</p><p className="text-2xl font-black text-violet-800">{users.length}</p></div>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingUser(null);
                        setNewStaffId('');
                        setNewStaffName('');
                        setNewStaffPass('');
                        setShowStaffPassword(false);
                        setNewStaffRole(UserRole.STAFF);
                        setNewStaffClinicId(superAdminUserClinicFilter !== 'ALL' ? superAdminUserClinicFilter : (clinics[0]?.id || 'LINTANG'));
                        setShowStaffForm(prev => !prev);
                      }}
                      className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-4 py-3 text-xs font-black text-white shadow-sm transition hover:bg-violet-700"
                      aria-expanded={showStaffForm}
                    >
                      {showStaffForm ? <XCircle size={16} /> : <UserPlus size={16} />} {showStaffForm ? 'Close form' : 'Add new user'}
                    </button>
                  </div>
                </div>
                {showStaffForm && (
                  <form onSubmit={addStaffMember} className="mt-6 rounded-2xl border border-violet-100 bg-violet-50/50 p-4 md:p-5">
                    <div className="mb-4 flex items-center justify-between gap-3">
                      <div>
                        <p className="text-[10px] font-black uppercase tracking-[.16em] text-violet-600">New account</p>
                        <h2 className="mt-1 text-base font-black text-slate-800">Register New Clinic User</h2>
                      </div>
                      <span className="rounded-full bg-white px-3 py-1 text-[10px] font-bold text-slate-500">Super Admin</span>
                    </div>
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                      <label className="space-y-1"><span className="ml-1 text-[9px] font-bold uppercase text-violet-600">Staff User ID</span><input required value={newStaffId} onChange={e => setNewStaffId(e.target.value)} placeholder="e.g. STAFF001" className="w-full rounded-xl border border-violet-100 bg-white px-4 py-3 text-sm font-semibold outline-none focus:ring-2 focus:ring-violet-300" /></label>
                      <label className="space-y-1"><span className="ml-1 text-[9px] font-bold uppercase text-violet-600">Password</span><div className="relative"><input required type={showStaffPassword ? 'text' : 'password'} value={newStaffPass} onChange={e => setNewStaffPass(e.target.value)} placeholder="Enter password" className="w-full rounded-xl border border-violet-100 bg-white px-4 py-3 pr-11 text-sm outline-none focus:ring-2 focus:ring-violet-300" /><button type="button" onClick={() => setShowStaffPassword(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" aria-label={showStaffPassword ? 'Hide password' : 'Show password'}>{showStaffPassword ? <EyeOff size={17}/> : <Eye size={17}/>}</button></div></label>
                      <label className="space-y-1"><span className="ml-1 text-[9px] font-bold uppercase text-violet-600">Display Name</span><input required value={newStaffName} onChange={e => setNewStaffName(e.target.value)} placeholder="e.g. Dr. Johny" className="w-full rounded-xl border border-violet-100 bg-white px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-violet-300" /></label>
                    </div>
                    <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                      <label className="space-y-1"><span className="ml-1 text-[9px] font-bold uppercase text-violet-600">Clinic</span><select required value={newStaffClinicId} onChange={e => setNewStaffClinicId(e.target.value)} className="w-full rounded-xl border border-violet-100 bg-white px-4 py-3 text-sm font-semibold outline-none focus:ring-2 focus:ring-violet-300"><option value="">Select clinic</option>{clinics.filter(c => c.active).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select><span className="ml-1 text-[10px] text-slate-400">Assign this account to a clinic.</span></label>
                      <label className="space-y-1"><span className="ml-1 text-[9px] font-bold uppercase text-violet-600">Role</span><select value={newStaffRole} onChange={e => setNewStaffRole(e.target.value as UserRole)} className="w-full rounded-xl border border-violet-100 bg-white px-4 py-3 text-sm font-semibold outline-none focus:ring-2 focus:ring-violet-300"><option value={UserRole.STAFF}>STAFF</option><option value={UserRole.ADMIN}>ADMIN</option></select><span className="ml-1 text-[10px] text-slate-400">Choose the account's access level.</span></label>
                    </div>
                    <div className="mt-5 flex flex-wrap justify-end gap-2">
                      <button type="button" onClick={() => { setShowStaffForm(false); setNewStaffId(''); setNewStaffName(''); setNewStaffPass(''); setShowStaffPassword(false); setNewStaffRole(UserRole.STAFF); }} className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs font-bold text-slate-600 hover:bg-slate-50">Cancel</button>
                      <button type="submit" disabled={isSavingStaff} className="rounded-xl bg-violet-600 px-5 py-2.5 text-xs font-black uppercase tracking-wider text-white shadow-sm hover:bg-violet-700 disabled:opacity-50">{isSavingStaff ? 'Creating account...' : 'Create account'}</button>
                    </div>
                  </form>
                )}
                {editingUser && (
                  <div
                    className="fixed inset-0 z-[130] flex items-center justify-center overflow-y-auto bg-slate-900/65 p-4 backdrop-blur-sm"
                    onMouseDown={e => { if (e.target === e.currentTarget) { setEditingUser(null); setNewStaffPass(''); } }}
                  >
                    <form
                      onSubmit={updateStaffMember}
                      className="my-auto w-full max-w-2xl overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl"
                      role="dialog"
                      aria-modal="true"
                      aria-labelledby="edit-clinic-user-title"
                    >
                      <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/80 px-6 py-5">
                        <div className="flex min-w-0 items-center gap-3">
                          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white"><UserCog size={19}/></div>
                          <div className="min-w-0">
                            <h2 id="edit-clinic-user-title" className="text-lg font-black text-slate-800">Edit User Details</h2>
                            <p className="mt-0.5 text-[10px] font-black uppercase tracking-wider text-slate-400">Account: {editingUser.id}</p>
                          </div>
                        </div>
                        <button type="button" aria-label="Close edit user details" onClick={() => { setEditingUser(null); setNewStaffPass(''); }} className="rounded-full p-1 text-slate-400 transition hover:bg-slate-200 hover:text-slate-700"><XCircle size={23}/></button>
                      </div>
                      <div className="space-y-5 px-6 py-6">
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                          <label className="space-y-1.5"><span className="ml-1 text-[9px] font-black uppercase tracking-wide text-blue-600">User ID</span><input value={editingUser.id} disabled className="w-full rounded-xl border border-blue-100 bg-slate-100 px-4 py-3 text-sm font-bold text-slate-500"/></label>
                          <label className="space-y-1.5"><span className="ml-1 text-[9px] font-black uppercase tracking-wide text-blue-600">Password</span><input type="password" autoComplete="new-password" value={newStaffPass} onChange={e => setNewStaffPass(e.target.value)} placeholder="Leave blank to keep current" className="w-full rounded-xl border border-blue-200 bg-white px-4 py-3 text-sm outline-none transition focus:ring-2 focus:ring-blue-100"/></label>
                          <label className="space-y-1.5 sm:col-span-2"><span className="ml-1 text-[9px] font-black uppercase tracking-wide text-blue-600">Display Name</span><input required value={editingUser.displayName} onChange={e => setEditingUser(prev => prev ? {...prev, displayName: e.target.value} : prev)} className="w-full rounded-xl border border-blue-200 bg-white px-4 py-3 text-sm outline-none transition focus:ring-2 focus:ring-blue-100"/></label>
                          <label className="space-y-1.5"><span className="ml-1 text-[9px] font-black uppercase tracking-wide text-blue-600">Clinic</span><select required disabled={editingUser.role === UserRole.SUPER_ADMIN} value={editingUser.clinicId || ''} onChange={e => setEditingUser(prev => prev ? {...prev, clinicId: e.target.value || null} : prev)} className="w-full rounded-xl border border-blue-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 outline-none focus:ring-2 focus:ring-blue-100"><option value="">Select clinic</option>{clinics.filter(c => c.active).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
                          <label className="space-y-1.5"><span className="ml-1 text-[9px] font-black uppercase tracking-wide text-blue-600">Role</span><select disabled={editingUser.role === UserRole.SUPER_ADMIN} value={editingUser.role} onChange={e => setEditingUser(prev => prev ? {...prev, role: e.target.value as UserRole, clinicId: e.target.value === UserRole.SUPER_ADMIN ? null : (prev.clinicId || clinics[0]?.id || 'LINTANG')} : prev)} className="w-full rounded-xl border border-blue-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 outline-none focus:ring-2 focus:ring-blue-100"><option value={UserRole.STAFF}>STAFF</option><option value={UserRole.ADMIN}>ADMIN</option><option value={UserRole.SUPER_ADMIN}>SUPER ADMIN</option></select></label>
                        </div>
                        <div className="flex flex-col-reverse gap-2 border-t border-slate-100 pt-4 sm:flex-row sm:justify-end">
                          <button type="button" onClick={() => { setEditingUser(null); setNewStaffPass(''); }} className="rounded-xl border border-slate-200 bg-white px-5 py-3 text-[10px] font-black uppercase tracking-wider text-slate-500 transition hover:bg-slate-50">Cancel</button>
                          <button type="submit" disabled={isSavingStaff} className="rounded-xl bg-emerald-600 px-5 py-3 text-[10px] font-black uppercase tracking-wider text-white shadow-lg transition hover:bg-emerald-700 disabled:opacity-50">{isSavingStaff ? 'Saving...' : 'Save Changes'}</button>
                        </div>
                      </div>
                      <div className="border-t border-slate-100 bg-slate-50 px-5 py-3 text-center text-[9px] font-black uppercase tracking-wide text-slate-400">Authorized administrators only. Keep passwords secure.</div>
                    </form>
                  </div>
                )}
                <div className="mt-6 grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_220px_180px]">
                  <label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm text-slate-400"><Search size={17}/><input value={superAdminUserSearch} onChange={e => setSuperAdminUserSearch(e.target.value)} className="min-w-0 flex-1 outline-none text-slate-700 placeholder:text-slate-400" placeholder="Search name or staff ID..." aria-label="Search users by name or staff ID" /></label>
                  <select value={superAdminUserClinicFilter} onChange={e => { setSuperAdminUserClinicFilter(e.target.value); setSelectedSuperAdminUsersClinic(e.target.value === 'ALL' ? null : e.target.value); }} className="rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm font-semibold text-slate-600" aria-label="Filter users by clinic"><option value="ALL">All clinics</option>{clinics.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
                  <select value={superAdminUserRoleFilter} onChange={e => setSuperAdminUserRoleFilter(e.target.value)} className="rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm font-semibold text-slate-600" aria-label="Filter users by role"><option value="ALL">All roles</option><option value={UserRole.ADMIN}>Admin</option><option value={UserRole.STAFF}>Staff</option><option value={UserRole.SUPER_ADMIN}>Super Admin</option></select>
                </div>
                <div className="mt-5 flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-bold text-slate-500">{users.filter(u => { const q = superAdminUserSearch.trim().toLowerCase(); const clinic = clinics.find(c => c.id === u.clinicId); const matchesSearch = !q || u.displayName.toLowerCase().includes(q) || u.id.toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q) || (clinic?.name || '').toLowerCase().includes(q); const matchesClinic = superAdminUserClinicFilter === 'ALL' || u.clinicId === superAdminUserClinicFilter; const matchesRole = superAdminUserRoleFilter === 'ALL' || u.role === superAdminUserRoleFilter; return matchesSearch && matchesClinic && matchesRole; }).length} matching accounts</p><button type="button" onClick={() => { setSuperAdminUserSearch(''); setSuperAdminUserClinicFilter('ALL'); setSuperAdminUserRoleFilter('ALL'); setSelectedSuperAdminUsersClinic(null); }} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50">Reset filters</button></div>
                <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {clinics.filter(c => superAdminUserClinicFilter === 'ALL' || c.id === superAdminUserClinicFilter).map(c => {
                    return <button type="button" key={c.id} onClick={() => { setSelectedSuperAdminUsersClinic(selectedSuperAdminUsersClinic === c.id ? null : c.id); setSuperAdminUserClinicFilter(selectedSuperAdminUsersClinic === c.id ? 'ALL' : c.id); }} className={`rounded-2xl border p-4 text-left transition ${selectedSuperAdminUsersClinic === c.id || superAdminUserClinicFilter === c.id ? 'border-violet-300 bg-violet-50 ring-1 ring-violet-100' : 'border-slate-200 bg-white hover:border-violet-300 hover:bg-violet-50/40'}`}><div className="flex items-center justify-between gap-2"><Building2 size={20} className="text-violet-600"/><span className="rounded-full bg-slate-100 px-2 py-1 text-[9px] font-black uppercase text-slate-500">{c.id}</span></div><p className="mt-3 font-black text-slate-800">{c.name}</p><p className="mt-1 text-xs text-slate-500">{users.filter(u => u.clinicId === c.id).length} registered {users.filter(u => u.clinicId === c.id).length === 1 ? 'user' : 'users'}</p><p className="mt-3 text-xs font-bold text-violet-700">{superAdminUserClinicFilter === c.id ? 'Viewing this clinic' : 'Click to view users'} →</p></button>;
                  })}
                </div>
                {(superAdminUserClinicFilter !== 'ALL' || superAdminUserSearch.trim().length > 0) ? (
                <div className="mt-6 overflow-hidden rounded-2xl border border-slate-200">
                  <div className="flex flex-col gap-1 border-b border-slate-200 bg-slate-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"><h2 className="font-black text-slate-800">{superAdminUserClinicFilter !== 'ALL' ? `Users · ${clinics.find(c => c.id === superAdminUserClinicFilter)?.name || superAdminUserClinicFilter}` : 'Search results'}</h2><p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Account directory</p></div>
                  <div className="divide-y divide-slate-100">
                    {users.filter(u => { const q = superAdminUserSearch.trim().toLowerCase(); const clinic = clinics.find(c => c.id === u.clinicId); const matchesSearch = !q || u.displayName.toLowerCase().includes(q) || u.id.toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q) || (clinic?.name || '').toLowerCase().includes(q); const matchesClinic = superAdminUserClinicFilter === 'ALL' || u.clinicId === superAdminUserClinicFilter; const matchesRole = superAdminUserRoleFilter === 'ALL' || u.role === superAdminUserRoleFilter; return matchesSearch && matchesClinic && matchesRole; }).map(u => { const clinic = clinics.find(c => c.id === u.clinicId); return <div key={u.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"><div className="flex min-w-0 items-center gap-3"><div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${u.role === UserRole.SUPER_ADMIN ? 'bg-slate-900 text-white' : 'bg-violet-50 text-violet-600'}`}>{u.role === UserRole.SUPER_ADMIN ? <Shield size={17}/> : <Users size={17}/>}</div><div className="min-w-0"><p className="truncate font-bold text-slate-800">{u.displayName}</p><p className="truncate text-xs text-slate-500">{u.id}</p></div></div><div className="flex flex-wrap items-center gap-2 sm:justify-end">
  <span className="rounded-lg bg-slate-100 px-2 py-1 text-[9px] font-black uppercase text-slate-600">{u.role}</span>
  <span className="rounded-lg bg-violet-50 px-2 py-1 text-[9px] font-black uppercase text-violet-700">{clinic?.shortName || clinic?.name || u.department || 'Unassigned'}</span>
  {u.id.toLowerCase() !== 'admin' && u.role !== UserRole.SUPER_ADMIN && (
    <div className="flex items-center gap-1 border-l border-slate-200 pl-2 ml-1">
      <button
        type="button"
        onClick={() => {
          setShowStaffForm(false);
          setNewStaffPass('');
          setEditingUser(u);
          setShowStaffPassword(false);
        }}
        className="inline-flex items-center gap-1 rounded-lg border border-blue-100 bg-blue-50 px-2.5 py-1.5 text-[10px] font-bold text-blue-700 transition hover:bg-blue-100"
        title={`Edit ${u.displayName}`}
      >
        <Edit2 size={13} /> Edit
      </button>
      <button
        type="button"
        onClick={() => setUserToDelete(u)}
        className="inline-flex items-center gap-1 rounded-lg border border-rose-100 bg-rose-50 px-2.5 py-1.5 text-[10px] font-bold text-rose-700 transition hover:bg-rose-100"
        title={`Delete ${u.displayName}`}
      >
        <Trash2 size={13} /> Delete
      </button>
    </div>
  )}
</div></div>; })}
                    {users.filter(u => { const q = superAdminUserSearch.trim().toLowerCase(); const clinic = clinics.find(c => c.id === u.clinicId); return (!q || u.displayName.toLowerCase().includes(q) || u.id.toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q) || (clinic?.name || '').toLowerCase().includes(q)) && (superAdminUserClinicFilter === 'ALL' || u.clinicId === superAdminUserClinicFilter) && (superAdminUserRoleFilter === 'ALL' || u.role === superAdminUserRoleFilter); }).length === 0 && <div className="px-4 py-10 text-center"><Search size={25} className="mx-auto text-slate-300"/><p className="mt-2 font-bold text-slate-600">No users found</p><p className="mt-1 text-sm text-slate-400">Try a different search or filter.</p></div>}
                  </div>
                </div>
                ) : (
                  <div className="mt-6 rounded-2xl border border-dashed border-violet-200 bg-violet-50/50 px-5 py-10 text-center">
                    <Building2 size={30} className="mx-auto text-violet-400"/>
                    <p className="mt-3 font-black text-slate-700">Choose a clinic or search for a user</p>
                    <p className="mt-1 text-sm text-slate-500">User accounts will appear here after you select a clinic card or enter a name or staff ID in the search box.</p>
                  </div>
                )}
              </div>
            </section>
          ) : activeSuperAdminView === 'fundus' ? (
            <section className="space-y-5">
              <div className="overflow-hidden rounded-3xl border border-emerald-100 bg-gradient-to-br from-emerald-50 via-white to-teal-50 shadow-sm">
                <div className="flex flex-col gap-4 p-5 md:flex-row md:items-center md:justify-between md:p-7">
                  <div className="flex items-start gap-4">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-emerald-600 text-white shadow-lg shadow-emerald-200"><Network size={24}/></div>
                    <div><p className="text-[10px] font-black uppercase tracking-[.2em] text-emerald-700">Network administration</p><h1 className="mt-1 text-2xl font-black text-slate-900 md:text-3xl">Fundus Network</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">Urus klinik penyedia fundus dan tetapkan klinik rujukan yang boleh menghantar pesakit. Perubahan disimpan terus ke sistem.</p></div>
                  </div>
                  <div className="rounded-2xl border border-emerald-100 bg-white/90 px-4 py-3"><p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Active providers</p><p className="mt-1 text-3xl font-black text-emerald-700">{getFundusProviderClinics(clinics).length}</p></div>
                </div>
                <div className="grid grid-cols-1 gap-2 border-t border-emerald-100 bg-white/70 p-4 sm:grid-cols-2 xl:grid-cols-4 md:p-5">
                  <div className="flex items-center gap-3 rounded-2xl border border-emerald-100 bg-emerald-50/80 p-3"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700"><Network size={19}/></div><div><p className="text-[10px] font-bold uppercase tracking-wide text-emerald-700">Fundus providers</p><p className="text-xl font-black text-emerald-900">{getFundusProviderClinics(clinics).length}</p></div></div>
                  <div className="flex items-center gap-3 rounded-2xl border border-blue-100 bg-blue-50/80 p-3"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-100 text-blue-700"><Building2 size={19}/></div><div><p className="text-[10px] font-bold uppercase tracking-wide text-blue-700">Active clinics</p><p className="text-xl font-black text-blue-900">{clinics.filter(c => c.active).length}</p></div></div>
                  <div className="flex items-center gap-3 rounded-2xl border border-violet-100 bg-violet-50/80 p-3"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-100 text-violet-700"><Building2 size={19}/></div><div><p className="text-[10px] font-bold uppercase tracking-wide text-violet-700">Registered clinics</p><p className="text-xl font-black text-violet-900">{clinics.length}</p></div></div>
                  <div className="flex items-center gap-3 rounded-2xl border border-fuchsia-100 bg-fuchsia-50/80 p-3"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-fuchsia-100 text-fuchsia-700"><Building2 size={19}/></div><div><p className="text-[10px] font-bold uppercase tracking-wide text-fuchsia-700">Specialist clinics</p><p className="text-xl font-black text-fuchsia-900">{specialistClinics.filter(c => c.active).length}</p></div></div>
                </div>
              </div>

              <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
                <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-[10px] font-black uppercase tracking-[.18em] text-emerald-600">01 · Provider setup</p><h2 className="mt-1 text-lg font-black text-slate-900">Fundus Provider Clinics</h2><p className="mt-1 text-sm text-slate-500">Aktifkan atau nyahaktifkan perkhidmatan fundus bagi setiap klinik aktif.</p></div><span className="w-fit rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-[10px] font-black uppercase tracking-wide text-emerald-700">{getFundusProviderClinics(clinics).length} active providers</span></div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
                  {clinics.filter(c => c.active).map(clinic => <article key={clinic.id} className="group rounded-2xl border border-slate-200 bg-gradient-to-br from-white to-slate-50 p-4 transition hover:-translate-y-0.5 hover:border-emerald-200 hover:shadow-md">
                    <div className="flex items-start gap-3"><div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${clinic.isFundusProvider ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}><Building2 size={21}/></div><div className="min-w-0 flex-1"><h3 className="font-black leading-snug text-slate-900">{clinic.name}</h3><p className="mt-1 truncate text-[10px] font-bold uppercase tracking-widest text-slate-400">{clinic.shortName} · {clinic.id}</p></div></div>
                    <div className="mt-4 flex items-center justify-between gap-2 border-t border-slate-100 pt-3"><span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[9px] font-black uppercase tracking-wide ${clinic.isFundusProvider ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}><span className={`h-1.5 w-1.5 rounded-full ${clinic.isFundusProvider ? 'bg-emerald-500' : 'bg-slate-400'}`}/>{clinic.isFundusProvider ? 'Provider enabled' : 'Referral clinic'}</span>
                    <button type="button" disabled={fundusNetworkSaving === `provider:${clinic.id}`} onClick={async () => { const nextValue = !clinic.isFundusProvider; if (!nextValue && getFundusProviderClinics(clinics).length <= 1) { alert('At least one active fundus provider clinic is required.'); return; } const savingKey = `provider:${clinic.id}`; setFundusNetworkSaving(savingKey); const previousClinics = clinics; pendingFundusProviderRef.current[clinic.id] = nextValue; setClinics(prev => prev.map(c => c.id === clinic.id ? { ...c, isFundusProvider: nextValue } : !nextValue ? { ...c, fundusProviderClinicIds: (c.fundusProviderClinicIds || []).filter(id => id !== clinic.id) } : c)); try { await setDoc(doc(db, 'clinics', clinic.id), { isFundusProvider: nextValue }, { merge: true }); if (!nextValue) { const referralClinics = previousClinics.filter(c => c.active && !c.isFundusProvider && c.id !== clinic.id); await Promise.all(referralClinics.filter(c => (c.fundusProviderClinicIds || []).includes(clinic.id)).map(c => setDoc(doc(db, 'clinics', c.id), { fundusProviderClinicIds: (c.fundusProviderClinicIds || []).filter(id => id !== clinic.id) }, { merge: true }))); } addActivityLog(nextValue ? 'Enabled Fundus Provider' : 'Disabled Fundus Provider', `${clinic.name} (${clinic.id})`, currentUser.displayName); } catch (error) { console.error('Failed to update fundus provider status', error); delete pendingFundusProviderRef.current[clinic.id]; setClinics(previousClinics); const code = (error as any)?.code || 'unknown'; alert(`Failed to update ${clinic.shortName}. Firestore error: ${code}`); } finally { setFundusNetworkSaving(null); } }} className={`rounded-xl px-3 py-2 text-[10px] font-black transition disabled:cursor-wait disabled:opacity-50 ${clinic.isFundusProvider ? 'bg-slate-900 text-white hover:bg-slate-700' : 'bg-emerald-600 text-white hover:bg-emerald-700'}`}>{fundusNetworkSaving === `provider:${clinic.id}` ? 'Saving…' : clinic.isFundusProvider ? 'Turn off' : 'Enable provider'}</button></div>
                  </article>)}
                  {clinics.filter(c => c.active).length === 0 && <div className="col-span-full rounded-2xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">No active clinics available.</div>}
                </div>
              </section>

              <section className="rounded-3xl border border-blue-100 bg-gradient-to-br from-blue-50/70 to-white p-5 shadow-sm md:p-6">
                <div className="mb-5"><p className="text-[10px] font-black uppercase tracking-[.18em] text-blue-600">02 · Referral setup</p><h2 className="mt-1 text-lg font-black text-slate-900">Referral Routing</h2><p className="mt-1 max-w-3xl text-sm leading-6 text-slate-500">Pilih satu atau lebih klinik penyedia fundus bagi setiap klinik rujukan. Hanya provider yang aktif tersedia untuk dipilih.</p></div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
                  {clinics.filter(c => c.active && !c.isFundusProvider).map(clinic => { const providers = getFundusProviderClinics(clinics); const selectedProviders = clinic.fundusProviderClinicIds || []; return <article key={clinic.id} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><div className="flex items-start justify-between gap-3 border-b border-slate-100 bg-slate-50/80 p-4"><div className="flex items-start gap-3"><div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-100 text-blue-700"><Network size={19}/></div><div><h3 className="font-black text-slate-900">{clinic.name}</h3><p className="mt-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">{clinic.shortName} · referral clinic</p></div></div><span className="shrink-0 rounded-full bg-blue-100 px-2.5 py-1 text-[9px] font-black uppercase text-blue-700">{selectedProviders.length} selected</span></div><div className="space-y-2 p-4">{providers.length === 0 ? <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs font-bold text-amber-800">No active fundus provider is available. Enable a provider above first.</div> : providers.map(provider => { const checked = selectedProviders.includes(provider.id); return <label key={provider.id} className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition ${checked ? 'border-blue-200 bg-blue-50' : 'border-slate-200 bg-white hover:border-blue-200 hover:bg-slate-50'} ${fundusNetworkSaving === `routing:${clinic.id}:${provider.id}` ? 'opacity-60' : ''}`}><input type="checkbox" checked={checked} disabled={!provider.active || fundusNetworkSaving === `routing:${clinic.id}:${provider.id}`} onChange={async e => { const savingKey = `routing:${clinic.id}:${provider.id}`; const checkedNow = e.currentTarget.checked; setFundusNetworkSaving(savingKey); const previousQueue = fundusRoutingWriteQueueRef.current[clinic.id] || Promise.resolve(); const queuedWrite = previousQueue.then(async () => { const latestClinic = clinicsRef.current.find(c => c.id === clinic.id); const currentProviders = latestClinic?.fundusProviderClinicIds || []; const nextProviders = checkedNow ? Array.from(new Set([...currentProviders, provider.id])) : currentProviders.filter(id => id !== provider.id); pendingFundusRoutingRef.current[clinic.id] = nextProviders; setClinics(prev => prev.map(c => c.id === clinic.id ? { ...c, fundusProviderClinicIds: nextProviders } : c)); try { await setDoc(doc(db, 'clinics', clinic.id), { fundusProviderClinicIds: nextProviders }, { merge: true }); addActivityLog('Updated Fundus Routing', `${clinic.shortName} → ${nextProviders.length ? nextProviders.map(id => getClinicById(clinicsRef.current, id)?.shortName || id).join(', ') : 'No provider selected'}`, currentUser.displayName); } catch (error) { console.error('Failed to update fundus routing', error); delete pendingFundusRoutingRef.current[clinic.id]; const code = (error as any)?.code || 'unknown'; alert(`Failed to update ${clinic.shortName} routing. Firestore error: ${code}`); } }); const queuedSafe = queuedWrite.catch(() => undefined); fundusRoutingWriteQueueRef.current[clinic.id] = queuedSafe; try { await queuedWrite; } finally { if (fundusRoutingWriteQueueRef.current[clinic.id] === queuedSafe) { delete fundusRoutingWriteQueueRef.current[clinic.id]; setFundusNetworkSaving(null); } } }} className="h-4 w-4 accent-blue-600"/><div className="min-w-0 flex-1"><p className={`text-sm font-bold ${checked ? 'text-blue-800' : 'text-slate-700'}`}>{provider.name}</p><p className="mt-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">{provider.shortName} · {provider.id}</p></div>{checked && <CheckCircle2 size={18} className="shrink-0 text-blue-600"/>}</label>; })}</div></article>; })}
                  {clinics.filter(c => c.active && !c.isFundusProvider).length === 0 && <div className="col-span-full rounded-2xl border border-dashed border-blue-200 bg-white p-8 text-center"><CheckCircle2 size={28} className="mx-auto text-emerald-500"/><p className="mt-2 font-bold text-slate-700">All active clinics are fundus providers</p><p className="mt-1 text-sm text-slate-500">No referral routing is required until a clinic is set as a referral clinic.</p></div>}
                </div>
              </section>

              <section className="rounded-3xl border border-fuchsia-100 bg-gradient-to-br from-fuchsia-50/70 to-white p-5 shadow-sm md:p-6">
                <div className="mb-5">
                  <p className="text-[10px] font-black uppercase tracking-[.18em] text-fuchsia-600">03 · Specialist referral setup</p>
                  <h2 className="mt-1 text-lg font-black text-slate-900">Specialist Referral Routing</h2>
                  <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-500">Tandakan klinik yang dibenarkan menghantar rujukan kepada setiap klinik pakar. Hanya klinik yang dipilih akan nampak klinik pakar tersebut dalam pilihan rujukan SINAR.</p>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
                  {specialistClinics.filter(c => c.active).map(specialistClinic => {
                    const authorizedClinics = clinics.filter(c => (c.specialistClinicIds || []).includes(specialistClinic.id));
                    return (
                      <article key={specialistClinic.id} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                        <div className="flex items-start justify-between gap-2 border-b border-slate-100 bg-fuchsia-50/70 p-3">
                          <div className="flex min-w-0 items-start gap-2">
                            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-fuchsia-100 text-fuchsia-700"><Building2 size={18}/></div>
                            <div className="min-w-0"><h3 className="text-sm font-black leading-snug text-slate-900">{specialistClinic.name}</h3><p className="mt-1 truncate text-[9px] font-bold uppercase tracking-wider text-slate-400">{specialistClinic.shortName || specialistClinic.id}</p></div>
                          </div>
                          <span className="shrink-0 rounded-full bg-fuchsia-100 px-2 py-1 text-[9px] font-black text-fuchsia-700">{authorizedClinics.length} selected</span>
                        </div>
                        <div className="space-y-1.5 p-3">
                          {clinics.filter(c => c.active).length === 0 ? <p className="text-xs text-slate-500">Tiada klinik aktif.</p> : clinics.filter(c => c.active).map(clinic => {
                            const checked = (clinic.specialistClinicIds || []).includes(specialistClinic.id);
                            const savingKey = `specialist-routing:${clinic.id}:${specialistClinic.id}`;
                            return (
                              <label key={clinic.id} className={`flex cursor-pointer items-center gap-2 rounded-xl border p-2 transition ${checked ? 'border-fuchsia-200 bg-fuchsia-50' : 'border-slate-200 hover:border-fuchsia-200 hover:bg-slate-50'} ${fundusNetworkSaving === savingKey ? 'opacity-60' : ''}`}>
                                <input type="checkbox" checked={checked} disabled={fundusNetworkSaving === savingKey} onChange={async e => {
                                  const checkedNow = e.currentTarget.checked;
                                  setFundusNetworkSaving(savingKey);
                                  const latestClinic = clinicsRef.current.find(c => c.id === clinic.id) || clinic;
                                  const currentIds = latestClinic.specialistClinicIds || [];
                                  const nextIds = checkedNow ? Array.from(new Set([...currentIds, specialistClinic.id])) : currentIds.filter(id => id !== specialistClinic.id);
                                  setClinics(prev => prev.map(c => c.id === clinic.id ? { ...c, specialistClinicIds: nextIds } : c));
                                  try {
                                    await setDoc(doc(db, 'clinics', clinic.id), { specialistClinicIds: nextIds }, { merge: true });
                                    addActivityLog('Updated Specialist Referral Routing', `${clinic.shortName} → ${specialistClinic.shortName || specialistClinic.name}`, currentUser.displayName);
                                  } catch (error) {
                                    console.error('Failed to update specialist referral routing', error);
                                    setClinics(prev => prev.map(c => c.id === clinic.id ? { ...c, specialistClinicIds: currentIds } : c));
                                    alert(`Gagal menyimpan routing untuk ${clinic.shortName}. Sila cuba lagi.`);
                                  } finally {
                                    setFundusNetworkSaving(null);
                                  }
                                }} className="h-4 w-4 accent-fuchsia-600"/>
                                <span className="min-w-0 flex-1"><span className="block truncate text-xs font-bold text-slate-700">{clinic.name}</span><span className="block truncate text-[9px] font-semibold uppercase tracking-wide text-slate-400">{clinic.shortName} · {clinic.id}</span></span>
                                {checked && <CheckCircle2 size={16} className="shrink-0 text-fuchsia-600"/>}
                              </label>
                            );
                          })}
                        </div>
                      </article>
                    );
                  })}
                  {specialistClinics.filter(c => c.active).length === 0 && <div className="col-span-full rounded-2xl border border-dashed border-fuchsia-200 bg-white p-8 text-center"><Building2 size={28} className="mx-auto text-fuchsia-400"/><p className="mt-2 font-bold text-slate-700">No active specialist clinics</p><p className="mt-1 text-sm text-slate-500">Daftarkan klinik pakar dahulu sebelum menetapkan routing.</p></div>}
                </div>
              </section>
            </section>
          ) : activeSuperAdminView === 'analytics' ? (
            <section className="space-y-5">
              <div className="overflow-hidden rounded-3xl border border-blue-100 bg-gradient-to-br from-blue-50 via-white to-violet-50 shadow-sm">
                <div className="flex flex-col gap-4 p-5 md:flex-row md:items-center md:justify-between md:p-7">
                  <div className="flex items-start gap-4">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-blue-600 text-white shadow-lg shadow-blue-200"><BarChart3 size={24}/></div>
                    <div><p className="text-[10px] font-black uppercase tracking-[.2em] text-blue-700">Performance overview</p><h1 className="mt-1 text-2xl font-black text-slate-900 md:text-3xl">Analytics &amp; Reports</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">Ringkasan prestasi saringan untuk bulan dipilih. Pengiraan menggunakan statistik bulanan SINAR sedia ada.</p></div>
                  </div>
                  <div className="flex items-center justify-between gap-3 rounded-2xl border border-blue-100 bg-white/90 p-2 sm:justify-center">
                    <button type="button" onClick={() => changeAnalyticsMonth(-1)} className="rounded-xl border border-slate-200 p-2 text-slate-600 hover:bg-slate-50" aria-label="Previous month"><ChevronLeft size={18}/></button>
                    <div className="min-w-[135px] text-center"><p className="text-[9px] font-black uppercase tracking-widest text-slate-400">Reporting period</p><p className="mt-1 font-black text-slate-800">{selectedAnalyticsMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</p></div>
                    <button type="button" onClick={() => changeAnalyticsMonth(1)} disabled={isCurrentMonth} className={`rounded-xl border border-slate-200 p-2 ${isCurrentMonth ? 'cursor-not-allowed border-slate-100 text-slate-300 bg-slate-50' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`} aria-label="Next month" title={isCurrentMonth ? 'Future reporting months are not available yet' : 'Next month'}><ChevronRight size={18}/></button>
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-3 border-t border-blue-100 bg-white/70 p-4 sm:grid-cols-2 xl:grid-cols-4 md:p-5">
                  <div className="rounded-2xl border border-slate-200 bg-white p-4"><p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Total screenings</p><p className="mt-2 text-3xl font-black text-slate-900">{monthlyRetenStats.total}</p><p className="mt-1 text-xs text-slate-500">Eligible appointments this month</p></div>
                  <div className="rounded-2xl border border-blue-100 bg-blue-50/70 p-4"><p className="text-[10px] font-black uppercase tracking-widest text-blue-600">Need fundus</p><p className="mt-2 text-3xl font-black text-blue-700">{monthlyStats.fundusPending}</p><p className="mt-1 text-xs text-slate-500">Cases awaiting image capture</p></div>
                  <div className="rounded-2xl border border-violet-100 bg-violet-50/70 p-4"><p className="text-[10px] font-black uppercase tracking-widest text-violet-600">Need review</p><p className="mt-2 text-3xl font-black text-violet-700">{monthlyStats.reviewPending}</p><p className="mt-1 text-xs text-slate-500">Fundus complete, review pending</p></div>
                  <div className="rounded-2xl border border-emerald-100 bg-emerald-50/70 p-4"><p className="text-[10px] font-black uppercase tracking-widest text-emerald-700">Completed</p><p className="mt-2 text-3xl font-black text-emerald-700">{Math.max(0, monthlyStats.total - monthlyStats.totalPending)}</p><p className="mt-1 text-xs text-slate-500">Fundus and review completed</p></div>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
                <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
                  <div className="flex items-center justify-between gap-3"><div><p className="text-[10px] font-black uppercase tracking-widest text-blue-600">01 · Screening outcome</p><h2 className="mt-1 text-lg font-black text-slate-900">Clinical outcomes</h2></div><span className="rounded-full bg-slate-100 px-3 py-1 text-[10px] font-bold text-slate-500">{monthlyRetenStats.total} cases</span></div>
                  <div className="mt-5 space-y-4">
                    {[{label:'Normal',value:monthlyRetenStats.normal,color:'bg-emerald-500',text:'text-emerald-700'},{label:'Abnormal',value:monthlyRetenStats.abnormal,color:'bg-rose-500',text:'text-rose-700'},{label:'Ungradable',value:monthlyRetenStats.ungradable,color:'bg-amber-500',text:'text-amber-700'},{label:'Not Obtainable',value:monthlyRetenStats.notObtainable,color:'bg-slate-400',text:'text-slate-700'},{label:'Not Review Yet',value:monthlyRetenStats.notReviewYet,color:'bg-violet-500',text:'text-violet-700'}].map(item => { const pct = monthlyRetenStats.total > 0 ? Math.round((item.value / monthlyRetenStats.total) * 100) : 0; return <div key={item.label}><div className="mb-1.5 flex items-center justify-between gap-3"><span className="text-sm font-semibold text-slate-700">{item.label}</span><span className={`text-sm font-black ${item.text}`}>{item.value} <span className="text-xs font-semibold text-slate-400">({pct}%)</span></span></div><div className="h-2.5 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full ${item.color} transition-all`} style={{width:`${pct}%`}}/></div></div>; })}
                  </div>
                </section>
                <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
                  <div><p className="text-[10px] font-black uppercase tracking-widest text-violet-600">02 · Clinical findings</p><h2 className="mt-1 text-lg font-black text-slate-900">Abnormal findings overview</h2><p className="mt-1 text-sm text-slate-500">Counts use the current monthly clinical review summary.</p></div>
                  <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {[{label:'Mild NPDR',value:monthlyRetenStats.mildNPDR},{label:'Moderate NPDR',value:monthlyRetenStats.moderateNPDR},{label:'Severe NPDR',value:monthlyRetenStats.severeNPDR},{label:'PDR',value:monthlyRetenStats.pdr},{label:'Maculopathy',value:monthlyRetenStats.maculopathy},{label:'ADED',value:monthlyRetenStats.aded},{label:'Cataract',value:monthlyRetenStats.cataract},{label:'Others',value:monthlyRetenStats.others}].map(item => <div key={item.label} className="flex items-center justify-between gap-2 rounded-xl border border-slate-100 bg-slate-50/80 px-4 py-3"><span className="text-sm font-semibold text-slate-600">{item.label}</span><span className="text-lg font-black text-slate-900">{item.value}</span></div>)}
                  </div>
                  <div className="mt-4 rounded-xl border border-amber-100 bg-amber-50 px-4 py-3"><p className="text-xs leading-5 text-amber-800">These are summary counts, not a substitute for reviewing individual patient records.</p></div>
                </section>
              </div>
              <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-[10px] font-black uppercase tracking-widest text-emerald-700">03 · Referral summary</p><h2 className="mt-1 text-lg font-black text-slate-900">Referral &amp; workload status</h2><p className="mt-1 text-sm text-slate-500">High-level indicators for the selected month.</p></div><div className="rounded-xl bg-emerald-50 px-4 py-2"><p className="text-[9px] font-black uppercase tracking-widest text-emerald-700">Referred cases</p><p className="text-2xl font-black text-emerald-800">{monthlyRetenStats.referred}</p></div></div>
                <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3"><div className="rounded-2xl border border-slate-200 p-4"><p className="text-xs font-semibold text-slate-500">Photographs taken</p><p className="mt-1 text-2xl font-black text-slate-900">{monthlyRetenStats.photographs}</p></div><div className="rounded-2xl border border-blue-100 bg-blue-50/50 p-4"><p className="text-xs font-semibold text-blue-700">Pending fundus</p><p className="mt-1 text-2xl font-black text-blue-800">{monthlyStats.fundusPending}</p></div><div className="rounded-2xl border border-violet-100 bg-violet-50/50 p-4"><p className="text-xs font-semibold text-violet-700">Pending review</p><p className="mt-1 text-2xl font-black text-violet-800">{monthlyStats.reviewPending}</p></div></div>
              </section>
            </section>
          ) : activeSuperAdminView === 'logs' ? (
            <section className="space-y-5">
              <div className="overflow-hidden rounded-3xl border border-amber-100 bg-gradient-to-br from-amber-50 via-white to-orange-50 shadow-sm">
                <div className="flex flex-col gap-4 p-5 md:flex-row md:items-center md:justify-between md:p-7">
                  <div className="flex items-start gap-4"><div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-amber-500 text-white shadow-lg shadow-amber-200"><Activity size={24}/></div><div><p className="text-[10px] font-black uppercase tracking-[.2em] text-amber-700">System audit trail</p><h1 className="mt-1 text-2xl font-black text-slate-900 md:text-3xl">Activity Logs</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">Semak aktiviti yang direkodkan merentas klinik. Gunakan carian dan penapis untuk mencari rekod dengan lebih cepat.</p></div></div>
                  <div className="rounded-2xl border border-amber-100 bg-white/90 px-5 py-3"><p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Matching records</p><p className="mt-1 text-2xl font-black text-amber-700">{activityLogs.filter(log => { const q = activityLogSearch.trim().toLowerCase(); const matchesSearch = !q || [log.action, log.patient, log.by, log.clinicId || ''].some(v => String(v).toLowerCase().includes(q)); const matchesAction = activityLogActionFilter === 'ALL' || log.action === activityLogActionFilter; const matchesClinic = activityLogClinicFilter === 'ALL' || (log.clinicId || 'LEGACY') === activityLogClinicFilter; return matchesSearch && matchesAction && matchesClinic; }).length}</p><p className="text-xs text-slate-500">of {visibleActivityLogs.length} visible records</p></div>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <label className="md:col-span-1"><span className="mb-1.5 block text-[10px] font-black uppercase tracking-widest text-slate-500">Search activity</span><div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5"><Search size={16} className="text-slate-400"/><input value={activityLogSearch} onChange={e => setActivityLogSearch(e.target.value)} placeholder="Action, user, patient, clinic..." className="w-full bg-transparent text-sm outline-none"/></div></label>
                <label><span className="mb-1.5 block text-[10px] font-black uppercase tracking-widest text-slate-500">Action type</span><select value={activityLogActionFilter} onChange={e => setActivityLogActionFilter(e.target.value)} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm"><option value="ALL">All actions</option>{Array.from(new Set(visibleActivityLogs.map(log => log.action).filter(Boolean))).sort().map(action => <option key={action} value={action}>{action}</option>)}</select></label>
                <label><span className="mb-1.5 block text-[10px] font-black uppercase tracking-widest text-slate-500">Clinic</span><select value={activityLogClinicFilter} onChange={e => setActivityLogClinicFilter(e.target.value)} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm"><option value="ALL">All clinics</option>{Array.from(new Set(visibleActivityLogs.map(log => log.clinicId || 'LEGACY'))).sort().map(id => <option key={id} value={id}>{id === 'LEGACY' ? 'Legacy / no clinic ID' : (clinics.find(c => c.id === id)?.name || id)}</option>)}</select></label>
              </div>
              <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
                <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-4"><div><h2 className="font-black text-slate-900">Audit history</h2><p className="mt-1 text-xs text-slate-500">Newest activity first</p></div><button type="button" onClick={() => { setActivityLogSearch(''); setActivityLogActionFilter('ALL'); setActivityLogClinicFilter('ALL'); }} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50">Reset filters</button></div>
                <div className="divide-y divide-slate-100">
                  {visibleActivityLogs.filter(log => { const q = activityLogSearch.trim().toLowerCase(); const matchesSearch = !q || [log.action, log.patient, log.by, log.clinicId || ''].some(v => String(v).toLowerCase().includes(q)); const matchesAction = activityLogActionFilter === 'ALL' || log.action === activityLogActionFilter; const matchesClinic = activityLogClinicFilter === 'ALL' || (log.clinicId || 'LEGACY') === activityLogClinicFilter; return matchesSearch && matchesAction && matchesClinic; }).slice().sort((a,b) => Number(b.timestamp || 0) - Number(a.timestamp || 0)).map((log,index) => <article key={`${log.timestamp}-${log.action}-${log.by}-${index}`} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between hover:bg-slate-50/80"><div className="flex min-w-0 items-start gap-3"><div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-700"><Activity size={17}/></div><div className="min-w-0"><p className="break-words text-sm font-black text-slate-800">{log.action || 'Activity recorded'}</p><p className="mt-1 break-words text-sm text-slate-600">{log.patient || 'System activity'}</p><div className="mt-2 flex flex-wrap items-center gap-2"><span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-600">By {log.by || 'Unknown user'}</span><span className="rounded-full bg-blue-50 px-2 py-1 text-[10px] font-bold text-blue-700">{clinics.find(c => c.id === log.clinicId)?.name || log.clinicId || 'Legacy / no clinic ID'}</span></div></div></div><time className="shrink-0 text-xs font-semibold text-slate-400 sm:text-right">{log.timestamp ? new Date(log.timestamp).toLocaleString('en-GB') : 'Time unavailable'}</time></article>)}
                  {visibleActivityLogs.filter(log => { const q = activityLogSearch.trim().toLowerCase(); const matchesSearch = !q || [log.action, log.patient, log.by, log.clinicId || ''].some(v => String(v).toLowerCase().includes(q)); const matchesAction = activityLogActionFilter === 'ALL' || log.action === activityLogActionFilter; const matchesClinic = activityLogClinicFilter === 'ALL' || (log.clinicId || 'LEGACY') === activityLogClinicFilter; return matchesSearch && matchesAction && matchesClinic; }).length === 0 && <div className="px-5 py-14 text-center"><div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-400"><Search size={22}/></div><p className="mt-3 font-bold text-slate-700">No matching activity</p><p className="mt-1 text-sm text-slate-500">Cuba ubah kata carian atau reset penapis.</p></div>}
                </div>
              </div>
            </section>
          ) : activeSuperAdminView === 'specialistClinics' ? (
            <section className="space-y-4 sm:space-y-5">
              <div className="rounded-2xl sm:rounded-3xl border border-violet-100 bg-white p-3 sm:p-5 md:p-7 shadow-sm min-w-0">
                <div className="flex flex-col gap-3 sm:gap-4 md:flex-row md:items-center md:justify-between">
                  <div><p className="text-[10px] font-black uppercase tracking-[.18em] text-violet-600">Specialist network</p><h1 className="mt-1 text-2xl font-black text-slate-900">Specialist Clinics</h1><p className="mt-2 text-sm text-slate-500">Manage specialist referral destinations separately from screening clinics.</p></div>
                  <button type="button" onClick={() => { if (showSpecialistClinicForm) { setShowSpecialistClinicForm(false); setEditingSpecialistClinicId(null); } else { setEditingSpecialistClinicId(null); setSpecialistClinicIdInput(''); setSpecialistClinicNameInput(''); setSpecialistClinicShortNameInput(''); setSpecialistClinicAddressInput(''); setSpecialistClinicPhoneInput(''); setShowSpecialistClinicForm(true); } }} className="inline-flex w-full sm:w-auto justify-center items-center gap-2 rounded-xl bg-violet-600 px-4 py-2.5 text-xs font-black text-white hover:bg-violet-700"><Plus size={16}/>{showSpecialistClinicForm ? 'Cancel' : 'Add Specialist Clinic'}</button>
                </div>
                {showSpecialistClinicForm && !editingSpecialistClinicId && <form className="mb-5 mt-4 sm:mt-5 rounded-2xl border border-violet-100 bg-violet-50/40 p-3 sm:p-4 md:p-5 min-w-0" onSubmit={async e => { e.preventDefault(); if (currentUser?.role !== UserRole.SUPER_ADMIN) { alert('Only Super Admin can manage specialist clinics.'); return; } const id = specialistClinicIdInput.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_'); const name = specialistClinicNameInput.trim(); if (!id || !name) return; if (!editingSpecialistClinicId && specialistClinics.some(c => c.id === id)) { alert('Specialist Clinic ID already exists.'); return; } setSpecialistSaving(true); try { const payload: Omit<SpecialistClinic, 'id'> = { name, shortName: specialistClinicShortNameInput.trim() || name, address: specialistClinicAddressInput.trim(), phone: specialistClinicPhoneInput.trim(), active: editingSpecialistClinicId ? (specialistClinics.find(c => c.id === editingSpecialistClinicId)?.active ?? true) : true, createdAt: editingSpecialistClinicId ? (specialistClinics.find(c => c.id === editingSpecialistClinicId)?.createdAt || Date.now()) : Date.now() }; await setDoc(doc(db, 'specialistClinics', editingSpecialistClinicId || id), payload, { merge: !!editingSpecialistClinicId }); addActivityLog(editingSpecialistClinicId ? 'Updated Specialist Clinic' : 'Created Specialist Clinic', `${name} (${editingSpecialistClinicId || id})`, currentUser.displayName); setShowSpecialistClinicForm(false); setEditingSpecialistClinicId(null); setSpecialistClinicIdInput(''); setSpecialistClinicNameInput(''); setSpecialistClinicShortNameInput(''); setSpecialistClinicAddressInput(''); setSpecialistClinicPhoneInput(''); } catch (error) { console.error('Failed to save specialist clinic', error); alert('Could not save specialist clinic. Check Firestore permissions and try again.'); } finally { setSpecialistSaving(false); } }}>
                  <p className="mb-4 text-xs font-black uppercase tracking-widest text-slate-700">{editingSpecialistClinicId ? 'Edit Specialist Clinic' : 'Add New Specialist Clinic'}</p>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    <label className="block text-xs font-bold text-slate-600">Clinic ID<input required disabled={!!editingSpecialistClinicId} value={specialistClinicIdInput} onChange={e => setSpecialistClinicIdInput(e.target.value)} placeholder="SPECIALIST_CLINIC_ID" className="mt-1 w-full min-w-0 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-bold uppercase outline-none focus:ring-2 focus:ring-violet-500 disabled:bg-slate-100"/></label>
                    <label className="block text-xs font-bold text-slate-600">Clinic name<input required value={specialistClinicNameInput} onChange={e => setSpecialistClinicNameInput(e.target.value)} placeholder="Specialist clinic / hospital name" className="mt-1 w-full min-w-0 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-violet-500"/></label>
                    <label className="block text-xs font-bold text-slate-600">Short name<input value={specialistClinicShortNameInput} onChange={e => setSpecialistClinicShortNameInput(e.target.value)} placeholder="Short name" className="mt-1 w-full min-w-0 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-violet-500"/></label>
                    <label className="block text-xs font-bold text-slate-600 xl:col-span-2">Full clinic address<textarea value={specialistClinicAddressInput} onChange={e => setSpecialistClinicAddressInput(e.target.value)} rows={2} placeholder="Full clinic address" className="mt-1 w-full min-w-0 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-violet-500"/></label>
                    <label className="block text-xs font-bold text-slate-600">Clinic telephone number<input value={specialistClinicPhoneInput} onChange={e => setSpecialistClinicPhoneInput(e.target.value)} placeholder="Clinic telephone number" className="mt-1 w-full min-w-0 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-violet-500"/></label>
                    <div className="flex w-full flex-col-reverse gap-2 pt-1 sm:flex-row sm:items-center sm:justify-end xl:col-span-3"><button type="button" onClick={() => { setShowSpecialistClinicForm(false); setEditingSpecialistClinicId(null); setSpecialistClinicIdInput(''); setSpecialistClinicNameInput(''); setSpecialistClinicShortNameInput(''); setSpecialistClinicAddressInput(''); setSpecialistClinicPhoneInput(''); }} className="w-full sm:w-auto rounded-xl border border-slate-200 bg-white px-5 py-2.5 text-xs font-bold text-slate-600 hover:bg-slate-50">Cancel</button><button type="submit" disabled={specialistSaving} className="w-full sm:w-auto rounded-xl bg-violet-600 px-5 py-2.5 text-xs font-black uppercase tracking-widest text-white hover:bg-violet-700 disabled:opacity-50">{specialistSaving ? 'Saving...' : editingSpecialistClinicId ? 'Save changes' : 'Save clinic'}</button></div>
                  </div>
                </form>}
                <div className="mt-4 sm:mt-5 flex min-w-0 items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5"><Search size={16} className="shrink-0 text-slate-400"/><input value={specialistClinicSearch} onChange={e => setSpecialistClinicSearch(e.target.value)} placeholder="Search clinic ID, name, address..." className="w-full min-w-0 bg-transparent text-sm outline-none"/></div>
                <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-3">
                  {specialistClinics.filter(c => [c.id, c.name, c.shortName || '', c.address || '', c.phone || ''].some(v => v.toLowerCase().includes(specialistClinicSearch.trim().toLowerCase()))).map(clinic => (
                    <article key={clinic.id} className="flex min-w-0 flex-col gap-4 rounded-2xl border border-slate-200 bg-gradient-to-br from-white to-slate-50 p-4 shadow-sm transition duration-200 hover:-translate-y-0.5 hover:border-violet-200 hover:shadow-md sm:p-5">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-start gap-2">
                          <h3 className="break-words font-black leading-snug text-slate-900">{clinic.name}</h3>
                          <span className="rounded-md bg-slate-100 px-2 py-1 text-[9px] font-black uppercase text-slate-500">{clinic.shortName || clinic.id}</span>
                        </div>
                        <p className="mt-1 break-all text-xs text-slate-400">{clinic.id}</p>
                        <p className="mt-2 whitespace-pre-line break-words text-xs text-slate-500">{clinic.address || 'Full address not set'}</p>
                        <p className="mt-1 break-words text-xs text-slate-500">{clinic.phone ? `Tel: ${clinic.phone}` : 'Telephone not set'}</p>
                      </div>
                      {editingSpecialistClinicId === clinic.id && (
                        <form className="rounded-xl border border-violet-200 bg-violet-50/70 p-3 sm:p-4" onSubmit={async e => {
                          e.preventDefault();
                          if (currentUser?.role !== UserRole.SUPER_ADMIN) { alert('Only Super Admin can manage specialist clinics.'); return; }
                          const id = specialistClinicIdInput.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
                          const name = specialistClinicNameInput.trim();
                          if (!id || !name) return;
                          setSpecialistSaving(true);
                          try {
                            const payload: Omit<SpecialistClinic, 'id'> = {
                              name,
                              shortName: specialistClinicShortNameInput.trim() || name,
                              address: specialistClinicAddressInput.trim(),
                              phone: specialistClinicPhoneInput.trim(),
                              active: clinic.active,
                              createdAt: clinic.createdAt || Date.now()
                            };
                            await setDoc(doc(db, 'specialistClinics', clinic.id), payload, { merge: true });
                            addActivityLog('Updated Specialist Clinic', `${name} (${clinic.id})`, currentUser.displayName);
                            setEditingSpecialistClinicId(null);
                            setSpecialistClinicIdInput('');
                            setSpecialistClinicNameInput('');
                            setSpecialistClinicShortNameInput('');
                            setSpecialistClinicAddressInput('');
                            setSpecialistClinicPhoneInput('');
                          } catch (error) {
                            console.error('Failed to save specialist clinic', error);
                            alert('Could not save specialist clinic. Check Firestore permissions and try again.');
                          } finally {
                            setSpecialistSaving(false);
                          }
                        }}>
                          <p className="mb-3 text-[10px] font-black uppercase tracking-widest text-violet-700">Edit specialist clinic</p>
                          <div className="grid grid-cols-1 gap-3">
                            <label className="block text-xs font-bold text-slate-600">Clinic ID
                              <input value={clinic.id} disabled className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-100 px-3 py-2.5 text-sm font-bold text-slate-500"/>
                            </label>
                            <label className="block text-xs font-bold text-slate-600">Clinic name
                              <input required value={specialistClinicNameInput} onChange={e => setSpecialistClinicNameInput(e.target.value)} placeholder="Specialist clinic / hospital name" className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-violet-500"/>
                            </label>
                            <label className="block text-xs font-bold text-slate-600">Short name
                              <input value={specialistClinicShortNameInput} onChange={e => setSpecialistClinicShortNameInput(e.target.value)} placeholder="Short name" className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-violet-500"/>
                            </label>
                            <label className="block text-xs font-bold text-slate-600">Full clinic address
                              <textarea value={specialistClinicAddressInput} onChange={e => setSpecialistClinicAddressInput(e.target.value)} rows={2} placeholder="Full clinic address" className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-violet-500"/>
                            </label>
                            <label className="block text-xs font-bold text-slate-600">Clinic telephone number
                              <input value={specialistClinicPhoneInput} onChange={e => setSpecialistClinicPhoneInput(e.target.value)} placeholder="Clinic telephone number" className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-violet-500"/>
                            </label>
                            <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
                              <button type="button" onClick={() => { setEditingSpecialistClinicId(null); setSpecialistClinicIdInput(''); setSpecialistClinicNameInput(''); setSpecialistClinicShortNameInput(''); setSpecialistClinicAddressInput(''); setSpecialistClinicPhoneInput(''); }} className="rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-xs font-bold text-slate-600 hover:bg-slate-50">Cancel</button>
                              <button type="submit" disabled={specialistSaving} className="rounded-lg bg-violet-600 px-4 py-2.5 text-xs font-black uppercase tracking-widest text-white hover:bg-violet-700 disabled:opacity-50">{specialistSaving ? 'Saving...' : 'Save changes'}</button>
                            </div>
                          </div>
                        </form>
                      )}
                      <div className="mt-auto border-t border-slate-100 pt-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <button type="button" onClick={async () => { try { await updateDoc(doc(db, 'specialistClinics', clinic.id), { active: !clinic.active }); addActivityLog(clinic.active ? 'Deactivated Specialist Clinic' : 'Activated Specialist Clinic', `${clinic.name} (${clinic.id})`, currentUser?.displayName); } catch (error) { console.error('Failed to update specialist clinic status', error); alert('Could not update specialist clinic status.'); } }} className={`rounded-lg px-2 py-1.5 text-[9px] font-black uppercase transition ${clinic.active ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100' : 'bg-rose-50 text-rose-700 hover:bg-rose-100'}`} title="Click to toggle specialist clinic status">{clinic.active ? 'Active' : 'Inactive'}</button>
                          <button type="button" onClick={() => { setEditingSpecialistClinicId(clinic.id); setSpecialistClinicIdInput(clinic.id); setSpecialistClinicNameInput(clinic.name); setSpecialistClinicShortNameInput(clinic.shortName || ''); setSpecialistClinicAddressInput(clinic.address || ''); setSpecialistClinicPhoneInput(clinic.phone || ''); setShowSpecialistClinicForm(false); }} className="inline-flex items-center gap-1.5 rounded-lg border border-violet-200 bg-white px-3 py-2 text-[9px] font-black uppercase text-violet-700 hover:bg-violet-50"><Edit2 size={13}/> Edit</button>
                          <button type="button" onClick={async () => { if (specialistUsers.some(u => u.clinicId === clinic.id)) { alert('Cannot delete this clinic while specialist users are assigned to it. Set it inactive instead.'); return; } if (!window.confirm(`Delete specialist clinic ${clinic.name}?`)) return; try { await deleteDoc(doc(db, 'specialistClinics', clinic.id)); addActivityLog('Deleted Specialist Clinic', `${clinic.name} (${clinic.id})`, currentUser?.displayName); } catch (error) { console.error('Failed to delete specialist clinic', error); alert('Could not delete specialist clinic.'); } }} className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[9px] font-black uppercase text-rose-600 transition-colors hover:bg-rose-100"><Trash2 size={13}/> Delete</button>
                        </div>
                      </div>
                    </article>
                  ))}
                  {specialistClinics.filter(c => [c.id, c.name, c.shortName || '', c.address || '', c.phone || ''].some(v => v.toLowerCase().includes(specialistClinicSearch.trim().toLowerCase()))).length === 0 && <div className="rounded-2xl border border-dashed border-slate-300 px-5 py-12 text-center sm:col-span-2 2xl:col-span-3"><Building2 size={26} className="mx-auto text-slate-300"/><p className="mt-3 font-bold text-slate-700">No specialist clinics yet</p><p className="mt-1 text-sm text-slate-500">Add a specialist clinic to begin.</p></div>}
                </div>
              </div>
            </section>
          ) : activeSuperAdminView === 'specialistUsers' ? (
            <section className="min-w-0 rounded-2xl sm:rounded-3xl border border-violet-100 bg-white p-3 sm:p-5 md:p-7 shadow-sm">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div><p className="text-[10px] font-black uppercase tracking-[.18em] text-violet-600">Administration</p><h1 className="mt-1 text-2xl font-black text-slate-900">Specialist User Management</h1><p className="mt-1 text-sm text-slate-500">Manage specialist accounts and assign each profile to a specialist clinic.</p></div>
                <div className="flex flex-wrap items-center gap-3"><div className="rounded-2xl bg-violet-50 px-4 py-3"><p className="text-xs font-bold text-violet-700">Registered users</p><p className="text-2xl font-black text-violet-800">{specialistUsers.length}</p></div><button type="button" onClick={() => { if (showSpecialistUserForm) { setShowSpecialistUserForm(false); setEditingSpecialistUserId(null); setSpecialistUserIdInput(''); setSpecialistUserNameInput(''); setSpecialistUserPasswordInput(''); setSpecialistUserClinicInput(''); setSpecialistUserRoleInput('STAFF'); } else { setEditingSpecialistUserId(null); setSpecialistUserIdInput(''); setSpecialistUserNameInput(''); setSpecialistUserPasswordInput(''); setSpecialistUserClinicInput(specialistClinics.find(c => c.active)?.id || ''); setSpecialistUserRoleInput('STAFF'); setShowSpecialistUserForm(true); } }} disabled={!specialistClinics.some(c => c.active)} className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-4 py-3 text-xs font-black text-white shadow-sm transition hover:bg-violet-700 disabled:opacity-40">{showSpecialistUserForm ? <XCircle size={16}/> : <UserPlus size={16}/>} {showSpecialistUserForm ? 'Close form' : 'Add new user'}</button></div>
              </div>
              {showSpecialistUserForm && !editingSpecialistUserId && <form className="mt-5 rounded-2xl border border-violet-100 bg-violet-50/50 p-4 md:p-5" onSubmit={async e => { e.preventDefault(); if (currentUser?.role !== UserRole.SUPER_ADMIN) { alert('Only Super Admin can manage specialist users.'); return; } const id = specialistUserIdInput.trim().toUpperCase(); const name = specialistUserNameInput.trim(); if (!id || !name || !specialistUserClinicInput || (!editingSpecialistUserId && !specialistUserPasswordInput.trim())) return; if (!editingSpecialistUserId && specialistUsers.some(u => u.id.toLowerCase() === id.toLowerCase())) { alert('Specialist user ID already exists.'); return; } if (!specialistClinics.some(c => c.id === specialistUserClinicInput && c.active)) { alert('Please assign the user to an active specialist clinic.'); return; } setSpecialistSaving(true); try { const existing = specialistUsers.find(u => u.id === editingSpecialistUserId); const payload: Omit<SpecialistUser, 'id'> = { ...(specialistUserPasswordInput.trim() ? { password: specialistUserPasswordInput } : {}), displayName: name, clinicId: specialistUserClinicInput, role: specialistUserRoleInput, active: existing?.active ?? true, createdAt: existing?.createdAt || Date.now() }; await setDoc(doc(db, 'specialistUsers', editingSpecialistUserId || id), payload, { merge: !!editingSpecialistUserId }); addActivityLog(editingSpecialistUserId ? 'Updated Specialist User' : 'Created Specialist User', `${name} (${editingSpecialistUserId || id})`, currentUser.displayName); setShowSpecialistUserForm(false); setEditingSpecialistUserId(null); setSpecialistUserIdInput(''); setSpecialistUserNameInput(''); setSpecialistUserPasswordInput(''); setSpecialistUserClinicInput(''); setSpecialistUserRoleInput('STAFF'); } catch (error) { console.error('Failed to save specialist user', error); alert('Could not save specialist user. Check Firestore permissions and try again.'); } finally { setSpecialistSaving(false); } }}>
                <div className="mb-4 flex items-center justify-between gap-3"><div><p className="text-[10px] font-black uppercase tracking-[.16em] text-violet-600">{editingSpecialistUserId ? 'Edit account' : 'New account'}</p><h2 className="mt-1 text-base font-black text-slate-800">{editingSpecialistUserId ? 'Edit Specialist User' : 'Register New Specialist User'}</h2></div><span className="rounded-full bg-white px-3 py-1 text-[10px] font-bold text-slate-500">Super Admin</span></div>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4"><label className="space-y-1"><span className="ml-1 text-[9px] font-bold uppercase text-violet-600">User ID</span><input required disabled={!!editingSpecialistUserId} value={specialistUserIdInput} onChange={e => setSpecialistUserIdInput(e.target.value)} placeholder="e.g. OPH001" className="w-full rounded-xl border border-violet-100 bg-white px-4 py-3 text-sm font-semibold outline-none focus:ring-2 focus:ring-violet-300 disabled:bg-slate-100"/></label><label className="space-y-1"><span className="ml-1 text-[9px] font-bold uppercase text-violet-600">Display Name</span><input required value={specialistUserNameInput} onChange={e => setSpecialistUserNameInput(e.target.value)} placeholder="e.g. Dr. Johny" className="w-full rounded-xl border border-violet-100 bg-white px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-violet-300"/></label><label className="space-y-1"><span className="ml-1 text-[9px] font-bold uppercase text-violet-600">Password {editingSpecialistUserId ? "(leave blank to keep current)" : ""}</span><input type="password" autoComplete="new-password" required={!editingSpecialistUserId} value={specialistUserPasswordInput} onChange={e => setSpecialistUserPasswordInput(e.target.value)} placeholder={editingSpecialistUserId ? "Enter new password to reset" : "Set login password"} className="w-full rounded-xl border border-violet-100 bg-white px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-violet-300"/></label><label className="space-y-1"><span className="ml-1 text-[9px] font-bold uppercase text-violet-600">Role</span><select required value={specialistUserRoleInput} onChange={e => setSpecialistUserRoleInput(e.target.value as 'ADMIN' | 'STAFF')} className="w-full rounded-xl border border-violet-100 bg-white px-4 py-3 text-sm font-semibold outline-none focus:ring-2 focus:ring-violet-300"><option value="STAFF">STAFF</option><option value="ADMIN">ADMIN</option></select></label></div>
                <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2"><label className="space-y-1"><span className="ml-1 text-[9px] font-bold uppercase text-violet-600">Specialist Clinic</span><select required value={specialistUserClinicInput} onChange={e => setSpecialistUserClinicInput(e.target.value)} className="w-full rounded-xl border border-violet-100 bg-white px-4 py-3 text-sm font-semibold outline-none focus:ring-2 focus:ring-violet-300"><option value="">Select specialist clinic</option>{specialistClinics.filter(c => c.active).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select><span className="ml-1 text-[10px] text-slate-400">Assign this profile to an active specialist clinic.</span></label><div className="flex items-end"><p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-800">Specialist ID + password will be used to sign in. Keep passwords confidential.</p></div></div>
                <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" onClick={() => { setShowSpecialistUserForm(false); setEditingSpecialistUserId(null); setSpecialistUserIdInput(''); setSpecialistUserNameInput(''); setSpecialistUserPasswordInput(''); setSpecialistUserClinicInput(''); setSpecialistUserRoleInput('STAFF'); }} className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs font-bold text-slate-600 hover:bg-slate-50">Cancel</button><button type="submit" disabled={specialistSaving} className="rounded-xl bg-violet-600 px-5 py-2.5 text-xs font-black uppercase tracking-wider text-white shadow-sm hover:bg-violet-700 disabled:opacity-50">{specialistSaving ? 'Saving...' : editingSpecialistUserId ? 'Save changes' : 'Create account profile'}</button></div>
              </form>}
              <div className="mt-6 grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_220px_180px]"><label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm text-slate-400"><Search size={17}/><input value={specialistUserSearch} onChange={e => setSpecialistUserSearch(e.target.value)} className="min-w-0 flex-1 outline-none text-slate-700 placeholder:text-slate-400" placeholder="Search name or ID..." aria-label="Search specialist users"/></label><select value={specialistUserClinicFilter} onChange={e => { setSpecialistUserClinicFilter(e.target.value); setSelectedSpecialistUsersClinic(e.target.value === 'ALL' ? null : e.target.value); }} className="rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm font-semibold text-slate-600" aria-label="Filter by specialist clinic"><option value="ALL">All specialist clinics</option>{specialistClinics.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select><select value={specialistUserRoleFilter} onChange={e => setSpecialistUserRoleFilter(e.target.value)} className="rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm font-semibold text-slate-600" aria-label="Filter by role"><option value="ALL">All roles</option><option value="ADMIN">Admin</option><option value="STAFF">Staff</option></select></div>
              <div className="mt-5 flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-bold text-slate-500">{specialistUsers.filter(u => { const q = specialistUserSearch.trim().toLowerCase(); const clinic = specialistClinics.find(c => c.id === u.clinicId); return (!q || u.displayName.toLowerCase().includes(q) || u.id.toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q) || (clinic?.name || '').toLowerCase().includes(q)) && (specialistUserClinicFilter === 'ALL' || u.clinicId === specialistUserClinicFilter) && (specialistUserRoleFilter === 'ALL' || u.role === specialistUserRoleFilter); }).length} matching accounts</p><button type="button" onClick={() => { setSpecialistUserSearch(''); setSpecialistUserClinicFilter('ALL'); setSpecialistUserRoleFilter('ALL'); setSelectedSpecialistUsersClinic(null); }} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50">Reset filters</button></div>
              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">{specialistClinics.filter(c => specialistUserClinicFilter === 'ALL' || c.id === specialistUserClinicFilter).map(c => <button type="button" key={c.id} onClick={() => { const next = selectedSpecialistUsersClinic === c.id ? null : c.id; setSelectedSpecialistUsersClinic(next); setSpecialistUserClinicFilter(next || 'ALL'); }} className={`rounded-2xl border p-4 text-left transition ${selectedSpecialistUsersClinic === c.id || specialistUserClinicFilter === c.id ? 'border-violet-300 bg-violet-50 ring-1 ring-violet-100' : 'border-slate-200 bg-white hover:border-violet-300 hover:bg-violet-50/40'}`}><div className="flex items-center justify-between gap-2"><Building2 size={20} className="text-violet-600"/><span className="rounded-full bg-slate-100 px-2 py-1 text-[9px] font-black uppercase text-slate-500">{c.shortName || c.id}</span></div><p className="mt-3 break-words font-black text-slate-800">{c.name}</p><p className="mt-1 text-xs text-slate-500">{specialistUsers.filter(u => u.clinicId === c.id).length} registered {specialistUsers.filter(u => u.clinicId === c.id).length === 1 ? 'user' : 'users'}</p><p className="mt-2 text-xs font-bold text-violet-600">Click to view users →</p></button>)}</div>
              {(specialistUserClinicFilter !== 'ALL' || specialistUserSearch.trim().length > 0) ? (
                <div className="mt-6 overflow-hidden rounded-2xl border border-slate-200">
                  <div className="flex flex-col gap-1 border-b border-slate-200 bg-slate-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <h2 className="font-black text-slate-800">{specialistUserClinicFilter !== 'ALL' ? `Users · ${specialistClinics.find(c => c.id === specialistUserClinicFilter)?.name || specialistUserClinicFilter}` : 'Search results'}</h2>
                    <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Specialist account directory</p>
                  </div>
                  <div className="divide-y divide-slate-100">
                    {specialistUsers.filter(u => { const q = specialistUserSearch.trim().toLowerCase(); const clinic = specialistClinics.find(c => c.id === u.clinicId); return (!q || u.displayName.toLowerCase().includes(q) || u.id.toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q) || (clinic?.name || '').toLowerCase().includes(q)) && (specialistUserClinicFilter === 'ALL' || u.clinicId === specialistUserClinicFilter) && (specialistUserRoleFilter === 'ALL' || u.role === specialistUserRoleFilter); }).map(user => { const clinic = specialistClinics.find(c => c.id === user.clinicId); return <div key={user.id} className="px-4 py-3"><div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><div className="flex min-w-0 items-center gap-3"><div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-50 text-violet-600"><UserCog size={17}/></div><div className="min-w-0"><p className="truncate font-bold text-slate-800">{user.displayName}</p><p className="truncate text-xs text-slate-500">{user.id}</p><p className="truncate text-xs text-slate-400">{clinic?.name || user.clinicId}</p></div></div><div className="flex flex-wrap items-center gap-2 sm:justify-end"><span className="rounded-lg bg-slate-100 px-2 py-1 text-[9px] font-black uppercase text-slate-600">{user.role}</span><span className={`rounded-lg px-2 py-1 text-[9px] font-black uppercase ${user.active ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{user.active ? 'Active' : 'Inactive'}</span><div className="flex items-center gap-1 border-l border-slate-200 pl-2 ml-1"><button type="button" onClick={() => { setEditingSpecialistUserId(user.id); setSpecialistUserIdInput(user.id); setSpecialistUserNameInput(user.displayName); setSpecialistUserPasswordInput(''); setSpecialistUserClinicInput(user.clinicId); setSpecialistUserRoleInput(user.role === 'ADMIN' ? 'ADMIN' : 'STAFF'); setShowSpecialistUserForm(false); }} className="inline-flex items-center gap-1 rounded-lg border border-blue-100 bg-blue-50 px-2.5 py-1.5 text-[10px] font-bold text-blue-700 transition hover:bg-blue-100"><Edit2 size={13}/> Edit</button><button type="button" onClick={async () => { if (!window.confirm(`Delete specialist user ${user.displayName}?`)) return; try { await deleteDoc(doc(db, 'specialistUsers', user.id)); addActivityLog('Deleted Specialist User', `${user.displayName} (${user.id})`, currentUser?.displayName); } catch (error) { console.error(error); alert('Could not delete specialist user.'); } }} className="inline-flex items-center gap-1 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[10px] font-bold text-rose-600 transition hover:bg-rose-100"><Trash2 size={13}/> Delete</button></div><button type="button" onClick={async () => { try { await updateDoc(doc(db, 'specialistUsers', user.id), { active: !user.active }); addActivityLog(user.active ? 'Deactivated Specialist User' : 'Activated Specialist User', `${user.displayName} (${user.id})`, currentUser?.displayName); } catch (error) { console.error(error); alert('Could not update specialist user status.'); } }} className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-[10px] font-bold text-slate-600 hover:bg-slate-50">{user.active ? 'Deactivate' : 'Activate'}</button></div></div>
                    {editingSpecialistUserId === user.id && <div className="fixed inset-0 z-[120] flex items-center justify-center overflow-y-auto bg-slate-900/65 backdrop-blur-sm p-4" onMouseDown={e => { if (e.target === e.currentTarget) { setEditingSpecialistUserId(null); setSpecialistUserIdInput(''); setSpecialistUserNameInput(''); setSpecialistUserPasswordInput(''); setSpecialistUserClinicInput(''); setSpecialistUserRoleInput('STAFF'); } }}><form className="my-auto w-full max-w-2xl overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl" onSubmit={async e => { e.preventDefault(); if (currentUser?.role !== UserRole.SUPER_ADMIN) { alert('Only Super Admin can manage specialist users.'); return; } const name = specialistUserNameInput.trim(); if (!name || !specialistUserClinicInput) { alert('Please complete all fields.'); return; } if (!specialistClinics.some(c => c.id === specialistUserClinicInput && c.active)) { alert('Please assign the user to an active specialist clinic.'); return; } setSpecialistSaving(true); try { await setDoc(doc(db, 'specialistUsers', user.id), { ...(specialistUserPasswordInput.trim() ? { password: specialistUserPasswordInput } : {}), displayName: name, clinicId: specialistUserClinicInput, role: specialistUserRoleInput }, { merge: true }); addActivityLog('Updated Specialist User', `${name} (${user.id})`, currentUser.displayName); setEditingSpecialistUserId(null); setSpecialistUserIdInput(''); setSpecialistUserNameInput(''); setSpecialistUserPasswordInput(''); setSpecialistUserClinicInput(''); setSpecialistUserRoleInput('STAFF'); setShowSpecialistUserForm(false); } catch (error) { console.error('Failed to update specialist user', error); alert('Could not update specialist user. Check Firestore permissions and try again.'); } finally { setSpecialistSaving(false); } }}>
                      <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/80 px-6 py-5"><div className="flex min-w-0 items-center gap-3"><div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white"><UserCog size={19}/></div><div><h2 className="text-lg font-black text-slate-800">Edit User Details</h2><p className="mt-0.5 text-[10px] font-black uppercase tracking-wider text-slate-400">Account: {user.id}</p></div></div><button type="button" aria-label="Close edit user details" onClick={() => { setEditingSpecialistUserId(null); setSpecialistUserIdInput(''); setSpecialistUserNameInput(''); setSpecialistUserPasswordInput(''); setSpecialistUserClinicInput(''); setSpecialistUserRoleInput('STAFF'); }} className="rounded-full p-1 text-slate-400 transition hover:bg-slate-200 hover:text-slate-700"><XCircle size={23}/></button></div>
                      <div className="space-y-5 px-6 py-6"><div className="grid grid-cols-1 gap-4 sm:grid-cols-2"><label className="space-y-1.5"><span className="ml-1 text-[9px] font-black uppercase tracking-wide text-blue-600">User ID</span><input value={specialistUserIdInput} disabled className="w-full rounded-xl border border-blue-100 bg-slate-100 px-4 py-3 text-sm font-bold text-slate-500"/></label><label className="space-y-1.5"><span className="ml-1 text-[9px] font-black uppercase tracking-wide text-blue-600">Password</span><div className="relative"><input type="password" autoComplete="new-password" value={specialistUserPasswordInput} onChange={e => setSpecialistUserPasswordInput(e.target.value)} placeholder="Leave blank to keep current" className="w-full rounded-xl border border-blue-200 bg-white px-4 py-3 pr-4 text-sm outline-none transition focus:ring-2 focus:ring-blue-100"/></div></label><label className="space-y-1.5 sm:col-span-2"><span className="ml-1 text-[9px] font-black uppercase tracking-wide text-blue-600">Display Name</span><input required value={specialistUserNameInput} onChange={e => setSpecialistUserNameInput(e.target.value)} className="w-full rounded-xl border border-blue-200 bg-white px-4 py-3 text-sm outline-none transition focus:ring-2 focus:ring-blue-100"/></label><label className="space-y-1.5"><span className="ml-1 text-[9px] font-black uppercase tracking-wide text-blue-600">Specialist Clinic</span><select required value={specialistUserClinicInput} onChange={e => setSpecialistUserClinicInput(e.target.value)} className="w-full rounded-xl border border-blue-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 outline-none focus:ring-2 focus:ring-blue-100"><option value="">Select specialist clinic</option>{specialistClinics.filter(c => c.active).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label className="space-y-1.5"><span className="ml-1 text-[9px] font-black uppercase tracking-wide text-blue-600">Role</span><select required value={specialistUserRoleInput} onChange={e => setSpecialistUserRoleInput(e.target.value as 'ADMIN' | 'STAFF')} className="w-full rounded-xl border border-blue-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 outline-none focus:ring-2 focus:ring-blue-100"><option value="STAFF">STAFF</option><option value="ADMIN">ADMIN</option></select></label></div><div className="flex flex-col-reverse gap-2 border-t border-slate-100 pt-4 sm:flex-row sm:justify-end"><button type="button" onClick={() => { setEditingSpecialistUserId(null); setSpecialistUserIdInput(''); setSpecialistUserNameInput(''); setSpecialistUserPasswordInput(''); setSpecialistUserClinicInput(''); setSpecialistUserRoleInput('STAFF'); }} className="rounded-xl border border-slate-200 bg-white px-5 py-3 text-[10px] font-black uppercase tracking-wider text-slate-500 transition hover:bg-slate-50">Cancel</button><button type="submit" disabled={specialistSaving} className="rounded-xl bg-emerald-600 px-5 py-3 text-[10px] font-black uppercase tracking-wider text-white shadow-lg transition hover:bg-emerald-700 disabled:opacity-50">{specialistSaving ? 'Saving...' : 'Save Changes'}</button></div></div><div className="border-t border-slate-100 bg-slate-50 px-5 py-3 text-center text-[9px] font-black uppercase tracking-wide text-slate-400">Authorized administrators only. Keep passwords secure.</div>
                    </form></div>}
                  </div>; })}
                    {specialistUsers.filter(u => { const q = specialistUserSearch.trim().toLowerCase(); const clinic = specialistClinics.find(c => c.id === u.clinicId); return (!q || u.displayName.toLowerCase().includes(q) || u.id.toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q) || (clinic?.name || '').toLowerCase().includes(q)) && (specialistUserClinicFilter === 'ALL' || u.clinicId === specialistUserClinicFilter) && (specialistUserRoleFilter === 'ALL' || u.role === specialistUserRoleFilter); }).length === 0 && <div className="px-5 py-10 text-center"><Users size={25} className="mx-auto text-slate-300"/><p className="mt-3 font-bold text-slate-700">No specialist users found</p><p className="mt-1 text-sm text-slate-500">Try another clinic or search term.</p></div>}
                  </div>
                </div>
              ) : (
                <div className="mt-6 rounded-2xl border border-dashed border-violet-200 bg-violet-50/50 px-5 py-12 text-center">
                  <Building2 size={28} className="mx-auto text-violet-400"/>
                  <p className="mt-3 font-bold text-slate-700">Choose a specialist clinic or search for a user</p>
                  <p className="mt-1 text-sm text-slate-500">Specialist accounts will appear here after you select a clinic card or enter a name or specialist user ID in the search box.</p>
                </div>
              )}
              <p className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-800"><strong>Important:</strong> These are specialist directory profiles only. Password setup will be handled through secure account provisioning and is not stored in this profile. Specialist login, dashboard access and referral-level security must be completed before patient records are exposed.</p>
            </section>
          ) : activeSuperAdminView === 'settings' ? (
            <section className="rounded-3xl border border-slate-200 bg-white p-5 md:p-7 shadow-sm"><p className="text-[10px] font-black uppercase tracking-[.18em] text-slate-500">System administration</p><h1 className="mt-1 text-2xl font-black text-slate-900">System Configuration</h1><p className="mt-2 text-sm text-slate-500">Global settings and maintenance tools for Super Admin.</p><div className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-2"><button type="button" onClick={() => { setActiveSuperAdminView('migration'); void scanMigrationData(); }} className="rounded-2xl border border-cyan-100 bg-cyan-50 p-5 text-left transition hover:bg-cyan-100"><Database size={23} className="text-cyan-700"/><p className="mt-3 font-black text-slate-800">Data &amp; Migration</p><p className="mt-1 text-sm text-slate-600">Review legacy records and migrate clinic structure safely.</p></button><button type="button" onClick={() => setActiveSuperAdminView('logs')} className="rounded-2xl border border-amber-100 bg-amber-50 p-5 text-left transition hover:bg-amber-100"><Activity size={23} className="text-amber-600"/><p className="mt-3 font-black text-slate-800">Global Activity Logs</p><p className="mt-1 text-sm text-slate-600">Audit activity across all facilities.</p></button><div className="rounded-2xl border border-slate-200 bg-slate-50 p-5"><Settings2 size={23} className="text-slate-600"/><p className="mt-3 font-black text-slate-800">Global configuration</p><p className="mt-1 text-sm text-slate-600">General SINAR settings and maintenance.</p></div></div></section>
          ) : activeSuperAdminView === 'migration' ? (
            <section className="rounded-3xl border border-cyan-100 bg-white p-4 shadow-sm md:p-6">
              <div className="mb-5 flex items-center gap-3 border-b border-slate-100 pb-5"><div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-cyan-600 text-white"><Database size={22}/></div><div><p className="text-[10px] font-black uppercase tracking-widest text-cyan-700">System Configuration</p><h1 className="text-2xl font-black text-slate-900">Data &amp; Migration</h1><p className="text-sm text-slate-500">Legacy data → multiclinic structure</p></div></div>
                <div className="rounded-2xl border border-cyan-100 bg-cyan-50/50 p-4">
                  <div className="flex items-start gap-3">
                    <AlertCircle className="text-cyan-600 shrink-0 mt-0.5" size={19} />
                    <div>
                      <p className="font-black text-slate-900">Safe migration policy</p>
                      <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                        Migration only fills the new clinic structure. The legacy <b>department</b> field is preserved and existing provider assignments are never overwritten.
                      </p>
                    </div>
                  </div>
                </div>

                {migrationStats ? (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <div className="rounded-2xl border border-slate-200 bg-white p-4">
                      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Appointments</p>
                      <p className="text-2xl font-black text-slate-900 mt-1">{migrationStats.appointmentsTotal}</p>
                      <p className="text-[11px] text-slate-500 mt-1">total records</p>
                    </div>
                    <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
                      <p className="text-[10px] font-black uppercase tracking-widest text-amber-700">Clinic migration</p>
                      <p className="text-2xl font-black text-amber-900 mt-1">{migrationStats.appointmentsNeedsClinicMigration}</p>
                      <p className="text-[11px] text-amber-700 mt-1">appointments</p>
                    </div>
                    <div className="rounded-2xl border border-violet-200 bg-violet-50 p-4">
                      <p className="text-[10px] font-black uppercase tracking-widest text-violet-700">Referral migration</p>
                      <p className="text-2xl font-black text-violet-900 mt-1">{migrationStats.appointmentsNeedsReferralMigration}</p>
                      <p className="text-[11px] text-violet-700 mt-1">appointments</p>
                    </div>
                    <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4">
                      <p className="text-[10px] font-black uppercase tracking-widest text-rose-700">Missing provider</p>
                      <p className="text-2xl font-black text-rose-900 mt-1">{migrationStats.appointmentsMissingProvider}</p>
                      <p className="text-[11px] text-rose-700 mt-1">appointments</p>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5 text-center">
                    <p className="text-sm font-bold text-slate-600">Scan Firestore to view migration status.</p>
                  </div>
                )}

                {/* =====================================================
                    CLINIC MASTER SYNCHRONIZATION
                    Creates only missing DEFAULT_CLINICS in Firestore.
                    Existing clinic documents are never overwritten.
                   ===================================================== */}
                <section className="rounded-2xl border border-emerald-200 bg-emerald-50/40 p-5">
                  <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
                    <div className="flex items-start gap-3">
                      <div className="w-10 h-10 rounded-xl bg-emerald-600 text-white flex items-center justify-center shadow-sm shrink-0">
                        <Building2 size={19} />
                      </div>
                      <div>
                        <h3 className="font-black text-slate-900">Clinic Master Synchronization</h3>
                        <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                          Create missing default clinic documents in Firestore. Existing clinics and their
                          provider, referral routing and TCA settings will not be changed.
                        </p>
                        <div className="flex flex-wrap gap-2 mt-3">
                          {DEFAULT_CLINICS.map(clinic => (
                            <span
                              key={clinic.id}
                              className="px-2.5 py-1 rounded-lg bg-white border border-emerald-100 text-[10px] font-black text-slate-600"
                            >
                              {clinic.shortName}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>

                    <button
                      type="button"
                      disabled={clinicMasterSyncRunning || migrationRunning || migrationScanning}
                      onClick={syncMissingClinicMaster}
                      className="shrink-0 px-5 py-3 rounded-xl bg-emerald-600 text-white text-xs font-black hover:bg-emerald-700 disabled:opacity-50 shadow-sm"
                    >
                      {clinicMasterSyncRunning ? 'Syncing...' : 'Sync Missing Clinic Master'}
                    </button>
                  </div>

                  {clinicMasterSyncMessage && (
                    <div className="mt-4 rounded-xl border border-emerald-100 bg-white px-4 py-3 text-[11px] font-semibold text-emerald-700">
                      {clinicMasterSyncMessage}
                    </div>
                  )}
                </section>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <section className="rounded-2xl border border-slate-200 bg-white p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h3 className="font-black text-slate-900">1. Clinic Structure</h3>
                        <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                          Fill <b>clinicId</b> and <b>referringClinicId</b> for legacy appointments, and <b>clinicId</b> for legacy users.
                        </p>
                      </div>
                      <ShieldCheck className="text-emerald-500 shrink-0" size={21} />
                    </div>
                    <button
                      disabled={migrationRunning || migrationScanning}
                      onClick={migrateClinicStructure}
                      className="mt-5 w-full py-3 rounded-xl bg-cyan-600 text-white font-black text-sm hover:bg-cyan-700 disabled:opacity-50"
                    >
                      Migrate Clinic Structure
                    </button>
                  </section>

                  <section className="rounded-2xl border border-slate-200 bg-white p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h3 className="font-black text-slate-900">2. Missing Fundus Provider</h3>
                        <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                          For old appointments without a provider field, choose the clinic that actually handled those legacy fundus cases.
                        </p>
                      </div>
                      <Network className="text-emerald-500 shrink-0" size={21} />
                    </div>

                    <div className="mt-4 rounded-xl border border-rose-100 bg-rose-50/60 p-3">
                      <p className="text-[10px] font-black uppercase tracking-widest text-rose-700">Legacy source breakdown</p>
                      <p className="text-xs text-slate-500 mt-1">
                        Assign the historical fundus provider by legacy source. Existing provider assignments are never overwritten.
                      </p>

                      <div className="mt-3 space-y-2">
                        {Object.entries(migrationStats?.missingProviderByLegacyDepartment || {})
                          .sort(([, a], [, b]) => b - a)
                          .map(([department, count]) => {
                            const selectedProviderId = migrationProviderByLegacyDepartment[department] || '';
                            const selectedProvider = clinics.find(clinic => clinic.id === selectedProviderId);
                            const mappedClinic =
                              department === 'OPD KKL'
                                ? 'LINTANG'
                                : department === 'PBOA'
                                  ? 'PBOA'
                                  : department === 'HSS'
                                    ? 'HSS'
                                    : '';

                            return (
                              <div key={department} className="rounded-xl border border-white bg-white p-3 shadow-sm">
                                <div className="flex flex-col xl:flex-row xl:items-center gap-3">
                                  <div className="min-w-0 xl:w-[28%]">
                                    <div className="flex items-center justify-between gap-2">
                                      <span className="text-xs font-black text-slate-800">{department}</span>
                                      <span className="text-sm font-black text-rose-700">{count}</span>
                                    </div>
                                    {mappedClinic && (
                                      <p className="text-[10px] font-bold text-slate-400 mt-1">Legacy clinic → {mappedClinic}</p>
                                    )}
                                  </div>

                                  <div className="flex-1 flex flex-col sm:flex-row gap-2">
                                    <select
                                      value={selectedProviderId}
                                      onChange={(e) =>
                                        setMigrationProviderByLegacyDepartment(prev => ({
                                          ...prev,
                                          [department]: e.target.value,
                                        }))
                                      }
                                      disabled={migrationRunning || migrationScanning || count <= 0}
                                      className="flex-1 px-3 py-2.5 rounded-xl border border-slate-200 bg-white text-xs font-bold text-slate-700 outline-none focus:ring-2 focus:ring-emerald-200 disabled:opacity-50"
                                    >
                                      <option value="">Select fundus provider...</option>
                                      {getFundusProviderClinics(clinics).map(provider => (
                                        <option key={provider.id} value={provider.id}>
                                          {provider.name}
                                        </option>
                                      ))}
                                    </select>

                                    <button
                                      type="button"
                                      disabled={migrationRunning || migrationScanning || count <= 0 || !selectedProviderId}
                                      onClick={() => migrateMissingProvidersByLegacyDepartment(department, selectedProviderId)}
                                      className="sm:min-w-[150px] px-4 py-2.5 rounded-xl bg-emerald-600 text-white text-xs font-black hover:bg-emerald-700 disabled:opacity-50"
                                    >
                                      Assign Provider
                                    </button>
                                  </div>
                                </div>

                                {selectedProvider && (
                                  <p className="text-[10px] font-semibold text-emerald-700 mt-2">
                                    Selected: {selectedProvider.shortName}
                                  </p>
                                )}
                              </div>
                            );
                          })}
                      </div>
                    </div>

                    <div className="mt-3 rounded-xl border border-amber-100 bg-amber-50 p-3">
                      <p className="text-xs font-black text-amber-900">Safe historical assignment</p>
                      <p className="text-[11px] text-amber-800 mt-1 leading-relaxed">
                        Each legacy source is migrated separately. Review the source and provider before confirming; no record from another source will be changed.
                      </p>
                    </div>
                  </section>
                </div>

                <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pt-1">
                  <div className="text-xs font-semibold text-slate-500 min-h-[18px]">
                    {migrationScanning ? 'Scanning...' : migrationRunning ? 'Migration in progress...' : migrationMessage}
                  </div>
                  <button
                    disabled={migrationScanning || migrationRunning}
                    onClick={scanMigrationData}
                    className="px-4 py-2.5 rounded-xl border border-slate-200 bg-white text-slate-700 font-black text-xs hover:bg-slate-50 disabled:opacity-50"
                  >
                    Refresh Scan
                  </button>
                </div>

                {migrationStats && (
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                      <p>Users: <b className="text-slate-900">{migrationStats.usersTotal}</b> total · <b className="text-amber-700">{migrationStats.usersNeedsClinicMigration}</b> need clinic mapping</p>
                      <p>Appointments with clinicId: <b className="text-slate-900">{migrationStats.appointmentsWithClinicId}</b> / {migrationStats.appointmentsTotal}</p>
                    </div>
                  </div>
                )}
            </section>
          ) : (
          <>
          {/*--- Console Header ---*/}
          <section className="bg-white border border-violet-100 rounded-3xl p-5 md:p-7 shadow-sm">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              <div>
                <div className="flex items-center gap-3">
                  <div className="w-11 h-11 rounded-2xl bg-violet-600 text-white flex items-center justify-center shadow-lg">
                    <Shield size={22} />
                  </div>
                  <div>
                    <h1 className="text-xl md:text-2xl font-black text-slate-900">SINAR Super Admin Console</h1>
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-1">Multi-Clinic Administration</p>
                  </div>
                </div>
              </div>
              <div className="text-left md:text-right">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Active Clinics</p>
                <p className="text-3xl font-black text-violet-600">{clinics.filter(c => c.active).length}</p>
              </div>
            </div>
          </section>

          {/*--- Card navigation replaces the old persistent sidebar. ---*/}
          <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <button type="button" onClick={() => setActiveSuperAdminView('clinics')} className="min-h-[126px] rounded-2xl border border-blue-100 bg-blue-50 p-5 text-left transition hover:-translate-y-0.5 hover:shadow-md"><Building2 size={24} className="mb-4 text-blue-600"/><p className="font-black text-slate-900">Clinic Management</p><p className="mt-1 text-xs text-slate-500">Add, activate and configure standalone clinics.</p></button>
            <button type="button" onClick={() => setActiveSuperAdminView('users')} className="min-h-[126px] rounded-2xl border border-violet-100 bg-violet-50 p-5 text-left transition hover:-translate-y-0.5 hover:shadow-md"><Users size={24} className="mb-4 text-violet-600"/><p className="font-black text-slate-900">User Management</p><p className="mt-1 text-xs text-slate-500">Create and manage admins and staff by clinic.</p></button>
            <button type="button" onClick={() => setActiveSuperAdminView('fundus')} className="min-h-[126px] rounded-2xl border border-emerald-100 bg-emerald-50 p-5 text-left transition hover:-translate-y-0.5 hover:shadow-md"><Network size={24} className="mb-4 text-emerald-600"/><p className="font-black text-slate-900">Fundus Network</p><p className="mt-1 text-xs text-slate-500">Configure fundus provider clinics and referral routing.</p></button>
            <button type="button" onClick={() => setActiveSuperAdminView('specialistClinics')} className="min-h-[126px] rounded-2xl border border-cyan-100 bg-cyan-50 p-5 text-left transition hover:-translate-y-0.5 hover:shadow-md"><Building2 size={24} className="mb-4 text-cyan-600"/><p className="font-black text-slate-900">Specialist Clinic</p><p className="mt-1 text-xs text-slate-500">Manage specialist clinic directory and status.</p></button>
            <button type="button" onClick={() => setActiveSuperAdminView('specialistUsers')} className="min-h-[126px] rounded-2xl border border-amber-100 bg-amber-50 p-5 text-left transition hover:-translate-y-0.5 hover:shadow-md"><UserCog size={24} className="mb-4 text-amber-600"/><p className="font-black text-slate-900">User Specialist</p><p className="mt-1 text-xs text-slate-500">Manage specialist accounts and clinic assignments.</p></button>
            <button type="button" onClick={() => setActiveSuperAdminView('settings')} className="min-h-[126px] rounded-2xl border border-slate-200 bg-slate-50 p-5 text-left transition hover:-translate-y-0.5 hover:shadow-md"><Settings2 size={24} className="mb-4 text-slate-600"/><p className="font-black text-slate-900">System Configuration</p><p className="mt-1 text-xs text-slate-500">Global settings, data migration and maintenance.</p></button>
          </section>

          {/*--- Monthly Summary By Clinic ---*/}
          <section className="bg-white border border-slate-200 rounded-3xl p-5 md:p-7 shadow-sm">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-6">
              <div>
                <h2 className="text-lg md:text-xl font-black text-slate-900">Monthly Summary by Clinic</h2>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-1">Fundus workload across PKD clinics</p>
              </div>
              <div className="flex items-center gap-2 self-start md:self-auto">
                <button onClick={() => changeAnalyticsMonth(-1)} className="p-2 rounded-xl border border-slate-200 hover:bg-slate-50">
                  <ChevronLeft size={17} />
                </button>
                <span className="min-w-[145px] text-center text-sm font-black text-slate-700">
                  {selectedAnalyticsMonth.toLocaleString('en-US', { month: 'long', year: 'numeric' })}
                </span>
                <button disabled={isCurrentMonth} onClick={() => changeAnalyticsMonth(1)} className={`p-2 rounded-xl border border-slate-200 ${isCurrentMonth ? 'opacity-30 cursor-not-allowed' : 'hover:bg-slate-50'}`}>
                  <ChevronRight size={17} />
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {superAdminMonthlyClinicStats.map(({ clinic, total, pendingFundus, pendingReview, completed }) => (
                <div key={clinic.id} className="rounded-2xl border border-slate-200 bg-slate-50/50 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedSuperAdminClinicId(clinic.id);
                          setShowSuperAdminClinicDetail(true);
                        }}
                        className="text-left max-w-full group"
                      >
                        <p className="font-black text-slate-900 truncate group-hover:text-blue-600 transition-colors">{clinic.name}</p>
                        <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mt-1">{clinic.id}</p>
                      </button>
                    </div>
                    <span className={`shrink-0 px-2 py-1 rounded-lg text-[8px] font-black uppercase ${clinic.isFundusProvider ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-500'}`}>
                      {clinic.isFundusProvider ? 'Fundus Provider' : 'Referral Clinic'}
                    </span>
                  </div>

                  <div className="grid grid-cols-4 gap-2 mt-5">
                    <div className="text-center rounded-xl bg-white border border-slate-100 p-2">
                      <p className="text-[8px] font-black text-slate-400 uppercase">Total</p>
                      <p className="text-2xl font-black text-slate-900">{total}</p>
                    </div>
                    <div className="text-center rounded-xl bg-white border border-blue-100 p-2">
                      <p className="text-[8px] font-black text-blue-500 uppercase">Need Fundus</p>
                      <p className="text-2xl font-black text-blue-600">{pendingFundus}</p>
                    </div>
                    <div className="text-center rounded-xl bg-white border border-indigo-100 p-2">
                      <p className="text-[8px] font-black text-indigo-500 uppercase">Need Review</p>
                      <p className="text-2xl font-black text-indigo-600">{pendingReview}</p>
                    </div>
                    <div className="text-center rounded-xl bg-white border border-emerald-100 p-2">
                      <p className="text-[8px] font-black text-emerald-500 uppercase">Done</p>
                      <p className="text-2xl font-black text-emerald-600">{completed}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
          </>
          )}
            <AppFooter />
          </div>
        </main>
      )}

      {currentUser.role !== UserRole.SUPER_ADMIN && (
      <main className="flex-1 max-w-7xl mx-auto px-4 py-8 w-full space-y-8">
        
        {/* Monthly Stats Dashboard */}
        <section className="bg-white border border-slate-200 rounded-3xl p-4 md:p-8 shadow-sm">
          <div className="grid grid-cols-2 lg:grid-cols-12 gap-3 items-stretch">

  {/* Practice Summary */}
  <div className="col-span-2 lg:col-span-2 flex flex-col justify-center">
    <h1 className="text-xl md:text-2xl font-black text-slate-800 tracking-tight">
      Practice Summary
    </h1>

    <p className="text-2xl md:text-3xl font-black text-slate-300 leading-none mt-1">
      {yearlyStats.year}
    </p>
  </div>

 {/* Total Case */}
<div className="col-span-1 lg:col-span-2 rounded-2xl border border-blue-100 bg-blue-50 px-3 py-3 min-h-[120px]">

  <p className="text-xs font-black text-blue-500 uppercase tracking-widest text-center mb-3">
    TOTAL CASE
  </p>

  <div className="flex items-center justify-between">

    {/* Icon */}
    <div className="w-10 h-10 rounded-xl bg-blue-600 text-white flex items-center justify-center shadow-lg shadow-blue-100">
      <Activity size={20} />
    </div>

    {/* Divider */}
    <div className="h-16 w-px bg-slate-300" />

    {/* Total */}
    <p className="text-4xl md:text-5xl font-black text-slate-900 leading-none">
      {yearlyStats.total}
    </p>

  </div>

</div>

  {/* Pending Review */}
<div className="col-span-1 lg:col-span-2 rounded-2xl border border-violet-100 bg-violet-50 px-3 py-3 min-h-[120px]">

  <p className="text-xs font-black text-violet-600 uppercase tracking-widest text-center mb-3">
    PENDING REVIEW
  </p>

  <div className="flex items-center justify-between">

    {/* Icon */}
    <div className="w-10 h-10 rounded-xl bg-violet-600 text-white flex items-center justify-center shadow-lg shadow-violet-100">
      <Search size={20} />
    </div>

    {/* Divider */}
    <div className="h-16 w-px bg-slate-300" />

    {/* Total */}
    <p className="text-4xl md:text-5xl font-black text-slate-900 leading-none">
      {yearlyStats.reviewPending}
    </p>

  </div>

</div>

  {/* Monthly Analytics */}
  <div className="col-span-2 lg:col-span-6 rounded-2xl border border-slate-200 bg-slate-50/60 p-4">

    <div className="flex items-center justify-between">

      <div>
        <h2 className="text-sm font-bold text-blue-600 uppercase tracking-widest mb-1">
          Monthly Analytics
        </h2>

        <div className="flex items-center gap-3 mt-2">

<button
onClick={() => changeAnalyticsMonth(-1)}
className="p-1 rounded-full hover:bg-slate-200"
>
<ChevronLeft size={18}/>
</button>

<p className="text-slate-600 text-sm font-bold min-w-[120px] text-center">
{
selectedAnalyticsMonth.toLocaleString(
'en-US',
{
month:'long',
year:'numeric'
}
)
}
</p>

<button
  disabled={isCurrentMonth}
  onClick={() => changeAnalyticsMonth(1)}
  className={`p-1 rounded-full transition-all ${
    isCurrentMonth
      ? "opacity-30 cursor-not-allowed"
      : "hover:bg-slate-200"
  }`}
>
  <ChevronRight size={18}/>
</button>

</div>

  {(currentUser?.role === UserRole.ADMIN || currentUser?.role === UserRole.SUPER_ADMIN) && (

  <button
    onClick={exportToPDF}
    className="mt-4 w-full bg-slate-900 border border-slate-800 hover:bg-black text-white px-3 py-2 rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition-all"
  >
    <Download size={14}/>
    Export Monthly PDF
  </button>

)}

</div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">

        <div className="text-center">
          <p className="text-[10px] font-bold text-slate-400 uppercase">
            Total
          </p>
          <p className="text-[10px] font-bold text-slate-400 uppercase">
            Cases
          </p>
          <p className="text-3xl font-black">
            {monthlyStats.total}
          </p>
          
        </div>

        <div className="text-center">
          <p className="text-[10px] font-bold text-blue-500 uppercase">
            Pending Fundus
          </p>
          <p className="text-3xl font-black text-blue-600">
            {monthlyStats.fundusPending}
          </p>
        </div>

        <div className="text-center">
          <p className="text-[10px] font-bold text-indigo-500 uppercase">
            Pending Review
          </p>
          <p className="text-3xl font-black text-indigo-600">
            {monthlyStats.reviewPending}
          </p>
        </div>

        <div className="text-center">
          <p className="text-[10px] font-bold text-amber-500 uppercase">
            Incomplete Cases
          </p>
          <p className="text-3xl font-black text-amber-600">
            {monthlyStats.totalPending}
          </p>
        </div>

      </div>

    </div>

  </div>

</div>
        </section>
        
        {(specialistReviewPendingAppointments.length + specialistReportsReturnedAppointments.length > 0) && (
          <section className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-3 px-2 sm:grid-cols-3 sm:gap-4" aria-label="Specialist referral summary">
            <div className="flex items-center gap-3 rounded-xl border border-blue-200 bg-blue-50 p-4">
              <div className="rounded-lg bg-blue-100 p-2 text-blue-700"><Activity size={19}/></div>
              <div>
                <p className="text-[10px] font-black uppercase tracking-wider text-blue-700">Total Specialist Referrals</p>
                <p className="text-2xl font-black text-slate-900">{specialistReviewPendingAppointments.length + specialistReportsReturnedAppointments.length}</p>
              </div>
            </div>
            <div className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
              <div className="rounded-lg bg-amber-100 p-2 text-amber-700"><Clock size={19}/></div>
              <div>
                <p className="text-[10px] font-black uppercase tracking-wider text-amber-800">Pending Ophthalmology Review</p>
                <p className="text-2xl font-black text-slate-900">{specialistReviewPendingAppointments.length}</p>
              </div>
            </div>
            <div className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
              <div className="rounded-lg bg-emerald-100 p-2 text-emerald-700"><CheckCircle2 size={19}/></div>
              <div>
                <p className="text-[10px] font-black uppercase tracking-wider text-emerald-800">Reports Received</p>
                <p className="text-2xl font-black text-slate-900">{specialistReportsReturnedAppointments.length}</p>
              </div>
            </div>
          </section>
        )}

        {/* Today's Quick Section */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <Clock size={20} className="text-blue-600" />

<h2 className="text-lg font-bold text-slate-800 tracking-tight">
  Today's Queue
</h2>

<span className="text-sm font-semibold text-slate-500">
  {new Date().toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  })}
</span>
              <div className="flex flex-wrap items-center gap-2">
                <span className="bg-blue-600 text-white px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-tighter shadow-sm">
                  {allTodayAppointments.length} Total Cases
                </span>
                <span className="bg-slate-100 text-slate-600 px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-tighter">
                  {todayAppointments.length} Active
                </span>
              </div>

<div className="flex flex-wrap items-center gap-2 ml-2">

  {/*--- Show TCA notification when any department has TCA tomorrow ---*/}
  {tomorrowTCATotal > 0 && (

    <div className="md:hidden flex items-center gap-1 bg-amber-50 border border-amber-200 px-2 py-1 rounded-lg">

    <span>🔔</span>

    {/*--- Tomorrow's TCA counts generated from all departments ---*/}
    {availableDepartments.map((department) => {

      const count =
        tomorrowTCA[department.id] ?? 0;

      //--- Hide departments with no TCA tomorrow ---//
      if (count === 0) {
        return null;
      }

      const badgeClass =
        department.id === 'OPD KKL'
          ? 'bg-sky-500'
          : department.id === 'PBOA'
            ? 'bg-emerald-500'
            : department.id === 'HSS'
              ? 'bg-violet-500'
              : 'bg-slate-500';

      return (
        <div
          key={department.id}
          className="flex items-center gap-1"
        >

          <div
            className={`w-5 h-5 rounded-full ${badgeClass} text-white flex items-center justify-center text-[10px] font-black`}
          >
            {department.shortName.charAt(0)}
          </div>

          <span className="text-xs font-black">
            {count}
          </span>

        </div>
      );
    })}

  </div>

  )}

</div>

            </div>
            <div className="flex flex-wrap items-center gap-2">

  {/*--- Show TCA notification when any department has TCA tomorrow ---*/}
  {tomorrowTCATotal > 0 && (

  <div className="hidden md:flex items-center gap-2 bg-amber-50 border border-amber-200 px-3 py-2 rounded-lg">

    <span className="text-amber-600">
      🔔
    </span>

    <span className="hidden md:inline text-xs font-bold text-slate-700">
      Tomorrow's TCA
    </span>

    {/*--- Tomorrow's TCA counts generated from all departments ---*/}
    <div className="flex items-center gap-2">

      {availableDepartments.map((department) => {

        const count =
          tomorrowTCA[department.id] ?? 0;

        //--- Hide departments with no TCA tomorrow ---//
        if (count === 0) {
          return null;
        }

        const badgeClass =
          department.id === 'OPD KKL'
            ? 'bg-sky-500'
            : department.id === 'PBOA'
              ? 'bg-emerald-500'
              : department.id === 'HSS'
                ? 'bg-violet-500'
                : 'bg-slate-500';

        return (
          <div
            key={department.id}
            className="flex items-center gap-1"
          >

            <div
              className={`w-5 h-5 rounded-full ${badgeClass} text-white flex items-center justify-center text-[10px] font-black`}
            >
              {department.shortName.charAt(0)}
            </div>

            <span className="text-xs font-black text-slate-700">
              {count}
            </span>

          </div>
        );

      })}

    </div>

  </div>

  )}

  <button
    onClick={() => setShowTCASchedule(true)}
    className="bg-white border border-slate-200 
                hover:bg-green-200 hover:text-green-700 hover:border-green-300 
                text-slate-700 px-4 py-2 rounded-lg flex items-center gap-2 text-sm font-semibold shadow-sm transition-all"
  >
    <Calendar size={18} />
    TCA Schedule
  </button>

  <button
  onClick={() => {
    setLookupIC("");
    setIsICLookupOpen(true);
  }}
  className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg flex items-center gap-2 text-sm font-semibold shadow-sm transition-all active:scale-95"
>
  <Plus size={18} />
  New Appointment
</button>

</div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {todayAppointments.length > 0 ? (
              todayAppointments.map((app) => {
                const globalQueueIndex = allTodayAppointments.findIndex(a => a.id === app.id);
                return (
                  <motion.div 
                    layout
                    key={app.id}
                    className={`p-4 rounded-xl shadow-sm border transition-all ${
                      app.status === AppointmentStatus.DONE ? 'bg-emerald-50 border-emerald-100' :
                      app.status === AppointmentStatus.NO_SHOW ? 'bg-rose-50 border-rose-100' : 'bg-white border-slate-100'
                    }`}
                  >
                    <div className="flex justify-between items-start mb-3">
                      <div className="flex items-center gap-1.5">
                         {/* Eye Photo Quick View */}
                         <div className="flex -space-x-2">
                          {['right', 'left'].map(eye => {
                            const photo = eye === 'right' ? app.rightEyePhoto : app.leftEyePhoto;
                            return (
                              <button 
                                key={eye}
                                onClick={() => {
  setSelectedPhotoApp({ app, eye: eye as any });
  setIsReferred(app.referred === true);
}} 
                                className="w-8 h-8 rounded-full border-2 border-white overflow-hidden bg-slate-100 flex items-center justify-center relative group/btn shadow-sm"
                              >
                                {photo ? (

  <img
    src={photo}
    className="w-full h-full object-cover"
    alt=""
  />

) : (
  (() => {

    const imageStatus =
      eye === "right"
        ? app.rightEyeImageStatus
        : app.leftEyeImageStatus;

    if (imageStatus === "Not Obtainable") {

      return (
        <CircleOff
          size={15}
          className="text-amber-600"
        />
      );

    }

    return (
      <span className="text-[10px] font-bold text-slate-400">
        {eye === "right" ? "R" : "L"}
      </span>
    );

  })()
)}
                              </button>
                            );
                          })}
                         </div>
                     </div>

<div className="flex flex-col items-end gap-1">

  <div className="flex flex-wrap items-center gap-2">

    <span className="text-[8px] px-2 py-[1px] rounded-full font-black border uppercase bg-blue-50 text-blue-700 border-blue-200">
      {getClinicById(clinics, app.clinicId)?.shortName || 'Clinic'}
    </span>

    <span className="text-lg font-black text-blue-600 uppercase tracking-tight leading-none">
      {(globalQueueIndex + 1).toString().padStart(2, '0')}
    </span>

  </div>

  <StatusBadge status={app.status} />

</div>
                    </div>
                    <h3 className="font-bold text-slate-800 text-[15px] leading-tight truncate">
                      {app.patientName}
                    </h3>
                  <p className="text-[11px] font-medium text-slate-500 mb-2">{app.icNumber}</p>

                  {String(app.remarks || '').trim() && (
                    <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-2.5">
                      <div className="flex items-start gap-2">
                        <AlertCircle size={14} className="mt-0.5 shrink-0 text-amber-700" />
                        <div className="min-w-0">
                          <p className="text-[9px] font-black uppercase tracking-wider text-amber-800">Remarks</p>
                          <p className="mt-1 text-xs leading-relaxed text-slate-700 whitespace-pre-wrap break-words">{app.remarks}</p>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="space-y-2 mb-4">
                    <p className="text-[9px] font-black text-slate-400 uppercase tracking-tighter mb-1 px-1">Upload Images</p>
                     <div className="grid grid-cols-2 gap-2">
                       <button
  disabled={
    uploadingImageId === `${app.id}-right` ||
    !!app.rightEyePhoto ||
    app.rightEyeImageStatus === "Not Obtainable"
  }
  onClick={() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = (e) =>
      handleImageUpload(app.id, "right", e as any);
    input.click();
  }}
  className={`py-2 rounded-xl text-[9px] font-bold uppercase transition-all flex items-center justify-center gap-1.5 disabled:cursor-default ${
    app.rightEyePhoto
      ? "bg-emerald-50 text-emerald-600 border border-emerald-100"
      : app.rightEyeImageStatus === "Not Obtainable"
      ? "bg-amber-50 text-amber-700 border border-amber-200"
      : "bg-blue-600 text-white shadow-md hover:bg-blue-700"
  }`}
>
  {app.rightEyePhoto ? (
    <CheckCircle2 size={10} />
  ) : app.rightEyeImageStatus === "Not Obtainable" ? (
    <AlertTriangle size={10} />
  ) : (
    <Plus size={10} />
  )}

  {uploadingImageId === `${app.id}-right`
    ? "Uploading..."
    : app.rightEyeImageStatus === "Not Obtainable"
    ? "RE Not Obtainable"
    : "Right (RE)"}
</button>
                       <button
  disabled={
    uploadingImageId === `${app.id}-left` ||
    (
      !app.rightEyePhoto &&
      app.rightEyeImageStatus !== "Not Obtainable"
    ) ||
    !!app.leftEyePhoto ||
    app.leftEyeImageStatus === "Not Obtainable"
  }
  onClick={() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = (e) =>
      handleImageUpload(app.id, "left", e as any);
    input.click();
  }}
  className={`py-2 rounded-xl text-[9px] font-bold uppercase transition-all flex items-center justify-center gap-1.5 disabled:cursor-default ${
    app.leftEyePhoto
      ? "bg-emerald-50 text-emerald-600 border border-emerald-100"
      : app.leftEyeImageStatus === "Not Obtainable"
      ? "bg-amber-50 text-amber-700 border border-amber-200"
      : (
          !app.rightEyePhoto &&
          app.rightEyeImageStatus !== "Not Obtainable"
        )
      ? "bg-slate-100 text-slate-400 border border-slate-200"
      : "bg-blue-600 text-white shadow-md hover:bg-blue-700"
  }`}
>
  {app.leftEyePhoto ? (
    <CheckCircle2 size={10} />
  ) : app.leftEyeImageStatus === "Not Obtainable" ? (
    <AlertTriangle size={10} />
  ) : (
    <Plus size={10} />
  )}

  {uploadingImageId === `${app.id}-left`
    ? "Uploading..."
    : app.leftEyeImageStatus === "Not Obtainable"
    ? "LE Not Obtainable"
    : "Left (LE)"}
</button>
                    </div>

{/* Image Status */}
{(() => {

  const rightCompleted =
    !!app.rightEyePhoto ||
    app.rightEyeImageStatus === "Not Obtainable";

  const leftCompleted =
    !!app.leftEyePhoto ||
    app.leftEyeImageStatus === "Not Obtainable";

  return !(rightCompleted && leftCompleted) && (

    <button
      onClick={() => {

        setSelectedUnableApp(app);

        setUnableEye("right");

        setUnableReason("Dense Cataract");

        setUnableOtherReason("");

        setShowImageNotObtainable(true);

      }}
      className="w-full mt-2 py-2 rounded-xl border border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-700 text-[10px] font-bold uppercase tracking-widest transition-all flex items-center justify-center gap-2"
    >
      <CameraOff size={14} />
      Image Not Obtainable
    </button>

  );

})()}

{(app.rightEyePhoto || app.leftEyePhoto) && (
                       <button 
  onClick={() => {

    const isReviewed =
      app.rightEyeReview &&
      app.leftEyeReview;

    setIsReviewViewMode(!!isReviewed);

    setSelectedPhotoApp({
      app,
      eye: app.rightEyePhoto ? 'right' : 'left'
    });

  }}
                         className={`w-full py-2 rounded-xl whitespace-nowrap text-[10px] disabled:opacity-50 disabled:cursor-not-allowed text-[10px] font-bold uppercase tracking-widest transition-all flex items-center justify-center gap-2 ${
                           isReviewCompleted(app)
                             ? 'bg-indigo-50 text-indigo-600 border border-indigo-100'
                             : 'bg-slate-900 text-white shadow-lg shadow-slate-200 hover:bg-black'
                         }`}
                       >
                         { isReviewCompleted(app) ? <CheckCircle2 size={12} /> : <Search size={12} /> }
                         { isReviewCompleted(app) ? 'Review Complete' : 'Perform Clinical Review' }
                       </button>
                     )}
                  </div>
                  
                  {app.status === AppointmentStatus.PENDING && (
                    <div className="flex gap-2">
                      <button 
                        onClick={() => updateStatus(app.firestoreId, AppointmentStatus.DONE)}
                        className="flex-1 bg-white hover:bg-emerald-600 hover:text-white text-emerald-600 border border-emerald-200 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-1"
                      >
                        <CheckCircle2 size={14} /> Done
                      </button>
                      <button 
                        onClick={() => updateStatus(app.firestoreId, AppointmentStatus.NO_SHOW)}
                        className="flex-1 bg-white hover:bg-rose-600 hover:text-white text-rose-600 border border-rose-200 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-1"
                      >
                        <XCircle size={14} /> No Show
                      </button>
                    </div>
                  )}
                </motion.div>
              );
            })
            ) : (
              <div className="col-span-full py-12 bg-white rounded-2xl border border-dashed border-slate-200 flex flex-col items-center justify-center text-slate-400">
                <Calendar size={32} strokeWidth={1.5} className="mb-2" />
                <p className="text-sm font-medium">No appointments scheduled for today</p>
              </div>
            )}
          </div>
        </section>

        {/* Global Directory */}
        <section className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden flex flex-col">
          {/* Controls */}
          <div className="p-4 border-b border-slate-100 bg-slate-50/50 flex flex-col xl:flex-row gap-4 xl:items-center">
            
            {/* SEARCH BAR */}
            <div className="relative w-full sm:flex-1">
              <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input 
                type="text" 
                placeholder="Search Patient or IC..." 
                className="w-full pl-10 pr-4 py-2 bg-white border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
              />
            </div>
            
            <div className="grid grid-cols-1 sm:flex sm:flex-wrap items-center gap-2">

{/* DATE RANGE FILTER */}
<div className="flex items-center gap-2 bg-white border border-blue-500 rounded-lg px-3 py-1.5">

  <Calendar size={16} className="text-orange-500 shrink-0" />

  <input
  type="date"
  aria-label="Start date"
  title="Start date"
  
  className={`bg-transparent border-none outline-none text-xs w-[120px] ${
  filterDateFrom
    ? "text-slate-800 font-bold"
    : "text-slate-400 font-medium"
} [&::-webkit-calendar-picker-indicator]:cursor-pointer`}

  value={filterDateFrom}
  max={filterDateTo || undefined}
  onChange={e => setFilterDateFrom(e.target.value)}
/>

  <span className="text-black-500 font-bold">
    ⬌
  </span>

  <input
  type="date"
  aria-label="End date"
  title="End date"

  className={`bg-transparent border-none outline-none text-xs w-[120px] ${
  filterDateTo
    ? "text-slate-800 font-bold"
    : "text-slate-400 font-medium"
} [&::-webkit-calendar-picker-indicator]:cursor-pointer`}

  value={filterDateTo}
  min={filterDateFrom || undefined}
  onChange={e => setFilterDateTo(e.target.value)}
/>

</div>

              {/* STATUS FILTER */}

              <div className="flex items-center gap-2 bg-white border border-blue-500 rounded-lg px-3 py-1.5">
                <Filter size={16} className="text-slate-400" />
                <select 
                  className="bg-transparent border-none outline-none text-xs font-medium appearance-none cursor-pointer"
                  value={filterStatus}
                  onChange={e => setFilterStatus(e.target.value as any)}
                >
                  <option value="Active">Active Queue</option>
                  <option value="All">All Records</option>
                </select>
              </div>

              {/* REVIEW FILTER */}

              <div className="flex items-center gap-2 bg-white border border-blue-500 rounded-lg px-3 py-1.5">
  <ShieldCheck size={16} className="text-blue-500" />
  <select
    className="bg-transparent border-none outline-none text-xs font-medium appearance-none cursor-pointer"
    value={filterReview}
    onChange={e => setFilterReview(e.target.value as any)}
  >
    <option value="All">All Reviews (Any)</option>
    <option value="Pending">Pending Review</option>
    <option value="Abnormal">Abnormal Findings</option>
    <option value="Normal">Normal Findings</option>\n     <option value="Ungradable">Ungradable</option>
  </select>
</div>

{/*---Department filter removed: clinic identity is now the operational scope---*/}
              {(
  searchQuery ||
  filterDateFrom ||
  filterDateTo ||
  filterStatus !== 'Active' ||
  filterReview !== 'All'
) && (

  <button
    onClick={() => {
      setSearchQuery('');
      setFilterDateFrom('');
      setFilterDateTo('');
      setFilterStatus('Active');
      setFilterReview('All');
      setFilterDepartment('All');
    }}
    
  className="text-xs text-blue-600 font-bold hover:underline px-2"
  >
    Clear Filters
  </button>
              )}
            </div>
          </div>

          {/* Table */}
          <div className="w-full overflow-x-hidden">
            <table className="w-full table-fixed text-left border-collapse">
              <colgroup>
                <col style={{ width: '12%' }} />
                <col style={{ width: '14%' }} />
                <col style={{ width: '9%' }} />
                <col style={{ width: '10%' }} />
                <col style={{ width: '10%' }} />
                <col style={{ width: '10%' }} />
                <col style={{ width: '17%' }} />
                <col style={{ width: '18%' }} />
              </colgroup>
              <thead className="bg-slate-50/80 backdrop-blur-sm">
                <tr className="border-b border-slate-200 bg-slate-200">
                  <th className="px-3 md:px-6 py-3 md:py-4 text-[10px] font-bold text-slate-600 uppercase tracking-wider text-center">RE / LE Photos</th>
                  <th className="px-3 md:px-6 py-3 md:py-4 text-[10px] font-bold text-slate-600 uppercase tracking-wider text-center">Patient Details</th>
                  <th className="px-3 md:px-6 py-3 md:py-4 text-[10px] font-bold text-slate-600 uppercase tracking-wider text-center">Input By</th>
                  <th className="px-3 md:px-6 py-3 md:py-4 text-[10px] font-bold text-slate-600 uppercase tracking-wider text-center">Schedule</th>
                  <th className="px-3 md:px-6 py-3 md:py-4 text-[10px] font-bold text-slate-600 uppercase tracking-wider text-center">Status</th>
                  <th className="px-3 md:px-6 py-3 md:py-4 text-[10px] font-bold text-slate-600 uppercase tracking-wider text-center">Fundus Actions</th>
                  <th className="px-3 md:px-6 py-3 md:py-4 text-[10px] font-bold text-slate-600 uppercase tracking-wider text-center">Review Findings</th>
                  <th className="px-3 md:px-6 py-3 md:py-4 text-[10px] font-bold text-slate-600 uppercase tracking-wider text-center">Options</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                <AnimatePresence>
                  {paginatedAppointments.map((app) => {
                    // Calculate queue number for that specific day
                    const sameDayApps = visibleAppointments
                      .filter(a => a && a.date === app.date)
                      .sort((a, b) => (Number(a?.createdAt) || 0) - (Number(b?.createdAt) || 0));
                    const dailyQueueIndex = sameDayApps.findIndex(a => a && a.id === app.id);
                    const dailyQueueNumber = (dailyQueueIndex + 1).toString().padStart(2, '0');

                    return (
                      <motion.tr 
  key={app.id}
  initial={{ opacity: 0 }}
  animate={{ opacity: 1 }}
  exit={{ opacity: 0 }}
  className={`group hover:bg-slate-50 transition-colors border-l-4 ${getClinicBorderClass(
  clinics,
  getReferringClinicId(app),
  currentUser?.clinicId || 'LINTANG'
)} ${
        app.status === AppointmentStatus.DONE
      ? 'bg-emerald-50/20'
      : app.status === AppointmentStatus.DONE_FUNDUS
      ? 'bg-blue-50/20'
      : app.status === AppointmentStatus.NO_SHOW
      ? 'bg-rose-50/20'
      : ''
  }`}
>

                      <td className="px-3 md:px-6 py-3 md:py-4">
                        <div className="flex flex-col items-center gap-1">
                          {app.status === AppointmentStatus.NO_SHOW ? (

  <div className="w-[92px] h-10 rounded-lg border border-rose-200 bg-rose-50 flex flex-col items-center justify-center">

    <UserX
      size={12}
      className="text-rose-600"
    />

    <span className="text-[8px] font-black uppercase text-rose-700 mt-0.5">
      No Show
    </span>

  </div>

) : (
                          <div className="flex gap-2">
                            {['right', 'left'].map(eye => {
                              const photo = eye === 'right' ? app.rightEyePhoto : app.leftEyePhoto;
                              return (
                                    <div key={eye} className="relative w-11 h-11 group/photo overflow-visible">
                                      {photo ? (

  <>
    <button
  onClick={() => {

    if (isReviewCompleted(app)) {

      setShowPatientHistory(false);
      setSelectedReviewSummary(app);

      return;

    }

    setSelectedPhotoApp({
      app,
      eye: eye as any
    });

  }}
      className={`w-full h-full rounded-lg overflow-hidden transition-all bg-white
  ${
    isReviewCompleted(app)
      ? "border-emerald-300 hover:ring-2 hover:ring-emerald-500"
      : "border-slate-200 hover:ring-2 hover:ring-blue-500"
  }`}
    >
      <img
  src={photo}
  className="w-full h-full object-cover"
  alt=""
/>

  <div className="absolute inset-0 bg-black/45 opacity-0 group-hover/photo:opacity-100 transition-all duration-200 flex items-center justify-center">

    <Eye
  size={16}
  className="text-white scale-90 group-hover/photo:scale-110 transition-transform duration-200"
/>

  </div>

    </button>

  </>

) : (

  (eye === "right"
      ? app.rightEyeImageStatus === "Not Obtainable"
      : app.leftEyeImageStatus === "Not Obtainable") ? (

    <button
  onClick={() => {

    if (isReviewCompleted(app)) {

      setShowPatientHistory(false);
      setSelectedReviewSummary(app);

      return;

    }

    setSelectedPhotoApp({
      app,
      eye: eye as any
    });

  }}
      className={`w-full h-full rounded-lg flex items-center justify-center transition-all
  ${
    isReviewCompleted(app)
      ? "border-emerald-300 bg-emerald-50 hover:ring-2 hover:ring-emerald-500"
      : "border-amber-200 bg-amber-50 hover:bg-amber-100"
  }`}
    >
      <CircleOff
        size={18}
        className="text-amber-600"
      />

  <div className="absolute inset-0 bg-black/45 opacity-0 group-hover/photo:opacity-100 transition-all duration-200 rounded-lg flex items-center justify-center">

    <Eye
  size={16}
  className="text-white scale-90 group-hover/photo:scale-110 transition-transform duration-200"
/>

  </div>

    </button>

  ) : (

    <label className="w-full h-full bg-slate-100 border border-dashed border-slate-300 rounded-lg flex flex-col items-center justify-center text-slate-400 cursor-pointer hover:bg-slate-200 transition-colors">

      <Plus size={14} />

      <span className="text-[7px] font-bold uppercase">
        {eye === "right" ? "RE" : "LE"}
      </span>

      <input
        type="file"
        className="hidden"
        accept="image/*"
        onChange={(e) =>
          handleImageUpload(
            app.id,
            eye as any,
            e
          )
        }
      />

    </label>

  )

)}
                                    </div>
                              );
                                })}
  </div>

)}
                          {(
  app.rightEyeUploadedBy ||
  app.leftEyeUploadedBy ||
  app.rightEyeImageStatus === "Not Obtainable" ||
  app.leftEyeImageStatus === "Not Obtainable"
) && (
                            <div className="flex flex-col items-center mt-1">
                              <span className="text-[8px] text-slate-400 font-bold uppercase tracking-tighter leading-none">
                                DONE BY:
                              </span>
                              <span className="text-xs text-slate-600 font-black uppercase tracking-tighter mt-0.5">
                                {getUserDisplayName(

  app.rightEyeUploadedBy ||

  app.leftEyeUploadedBy ||

  app.imageStatusUpdatedBy ||

  ''

)}
                              </span>
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex flex-col">
                          <span className="font-bold text-[13px] text-slate-800">{app.patientName}</span>
                          <div className="flex flex-wrap gap-1 mt-0.5">
                            {app.diseaseTypes?.map(d => (
                              <span key={d} className="text-[8px] bg-rose-100 text-rose-700 px-1 py-[1px] rounded font-bold border border-blue-100 uppercase">{d}</span>
                            ))}
                            {app.otherDisease && (
                              <span className="text-[8px] bg-slate-50 text-slate-600 px-1 py-[1px] rounded font-bold border border-slate-100 uppercase">{app.otherDisease}</span>
                            )}
<span
  className={`text-[8px] px-2 py-[1px] rounded font-black border uppercase ${getClinicBadgeClass(
    clinics,
    getReferringClinicId(app),
    currentUser?.clinicId || 'LINTANG'
  )}`}
>
  {getClinicById(clinics, getReferringClinicId(app))?.shortName || 'Clinic'}
</span>
                          </div>
                          <span className="text-[9px] md:text-[11px] font-normal text-slate-500 mt-1">
  IC: {app.icNumber}
</span>

<span className="text-[10px] md:text-xs text-slate-500 mt-1 flex items-center gap-1">
  <Phone size={10} /> {app.phoneNumber}
</span>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-center">
                        <div className="flex flex-col items-center text-center">
                          <span className="text-sm font-black text-slate-600 uppercase tracking-tighter">{getUserDisplayName(app.createdBy)}</span>
                          
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex flex-col">
                          <span className="text-sm font-medium text-slate-700">
  {isToday(app.date)
    ? 'Today'
    : new Date(app.date).toLocaleDateString('en-GB')}
</span>
                          <span className="text-[10px] font-black text-blue-600 tracking-wider mt-0.5">{dailyQueueNumber}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-center">
  <div className="flex flex-col items-center gap-1 text-center">

    <div className="flex items-center justify-center gap-2">
      <StatusBadge status={app.status} />
    </div>

    {(app as any).specialistReportStatus === 'Returned' ? (
      <span className="mt-1 inline-flex w-fit rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[9px] font-black uppercase text-violet-700">Ophthalmology report received</span>
    ) : app.referralSent === true && app.specialistClinicId ? (
      <span className="mt-1 inline-flex w-fit rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[9px] font-black uppercase text-amber-700">Ophthalmology pending review</span>
    ) : null}

    {app.status === AppointmentStatus.DONE && (

  <div className="flex flex-col items-center text-center mt-1">

    <span className="text-[8px] text-slate-400 font-bold uppercase tracking-tighter leading-none">

      {(app.rightEyeImageStatus === "Not Obtainable" &&
        app.leftEyeImageStatus === "Not Obtainable")

        ? "IMAGE STATUS BY:"

        : (app.isEdited
            ? "REVIEW EDITED BY:"
            : "REVIEW BY:")}

    </span>

    <span className="text-xs text-slate-600 font-black uppercase tracking-tighter mt-0.5">

      {getUserDisplayName(

        (app.rightEyeImageStatus === "Not Obtainable" &&
         app.leftEyeImageStatus === "Not Obtainable")

          ? (app.imageStatusUpdatedBy || "")

          : (app.updatedBy || "")

      )}

    </span>

  </div>

)}

  </div>
</td>
                      <td className="px-6 py-4">
                        <div className="flex flex-wrap items-center gap-2">
                          {app.status !== AppointmentStatus.NO_SHOW && (
                            <>
                           <div className="flex gap-1">
                             <button
  disabled={
    !!app.rightEyePhoto ||
    app.rightEyeImageStatus === "Not Obtainable"
  }
  onClick={() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = (e) =>
      handleImageUpload(app.id, "right", e as any);
    input.click();
  }}
  className={`px-2 py-1.5 rounded-lg text-[9px] font-bold uppercase transition-all flex items-center gap-1 ${
    app.rightEyePhoto
      ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
      : app.rightEyeImageStatus === "Not Obtainable"
      ? "bg-amber-50 text-amber-700 border border-amber-200"
      : "bg-blue-600 text-white hover:bg-blue-700 shadow"
  }`}
>
  {app.rightEyePhoto ? (
    <CheckCircle2 size={10} />
  ) : app.rightEyeImageStatus === "Not Obtainable" ? (
    <CircleOff size={10} />
  ) : (
    <Plus size={10} />
  )}

  RE
</button>
                             <button
  disabled={
    !!app.leftEyePhoto ||
    app.leftEyeImageStatus === "Not Obtainable"
  }
  onClick={() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = (e) =>
      handleImageUpload(app.id, "left", e as any);
    input.click();
  }}
  className={`px-2 py-1.5 rounded-lg text-[9px] font-bold uppercase transition-all flex items-center gap-1 ${
    app.leftEyePhoto
      ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
      : app.leftEyeImageStatus === "Not Obtainable"
      ? "bg-amber-50 text-amber-700 border border-amber-200"
      : "bg-blue-600 text-white hover:bg-blue-700 shadow"
  }`}
>
  {app.leftEyePhoto ? (
    <CheckCircle2 size={10} />
  ) : app.leftEyeImageStatus === "Not Obtainable" ? (
    <CircleOff size={10} />
  ) : (
    <Plus size={10} />
  )}

  LE
</button>
                           </div>
                           {/* No Show */}
    {app.status === AppointmentStatus.PENDING && (

  <button
  onClick={() =>
    updateStatus(
      app.firestoreId,
      AppointmentStatus.NO_SHOW
    )
  }
  className="flex-1 bg-white hover:bg-rose-600 hover:text-white text-rose-600 border border-rose-200 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-1"
>
  <XCircle size={14} />
  No Show
</button>

)}
 </>

    )}
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex flex-col gap-3 min-w-[200px]">
                          {(app.rightEyePhoto || app.leftEyePhoto) && (
                            <button
                                onMouseEnter={() => setHoveredReviewId(app.id)}
                                onMouseLeave={() => setHoveredReviewId(null)} 
                              onClick={() => {

  const isReviewed =
    app.rightEyeReview ||
    app.leftEyeReview;

  if (isReviewed) {

setShowPatientHistory(false);
setSelectedReviewSummary(app);

  } else {

    setSelectedPhotoApp({
      app,
      eye: app.rightEyePhoto ? 'right' : 'left'
    });

  }

}}
                              className={`w-full py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2 border ${
                                isReviewCompleted(app)
                                  ? 'bg-emerald-50 text-emerald-600 border-emerald-100 hover:bg-emerald-600 hover:text-white'
                                  : 'bg-blue-600 text-white border-blue-700 shadow-lg shadow-blue-100 hover:bg-blue-700'
                              }`}
                            >
                              {isReviewCompleted(app)
  ? (
      hoveredReviewId === app.id
        ? <Eye size={14} />
        : <CheckCircle2 size={14} />
    )
  : (
      <Search size={14} />
    )
}

{isReviewCompleted(app)
  ? (
      hoveredReviewId === app.id
        ? 'Review Details'
        : 'Clinical Review Done'
    )
  : (
      'Perform Clinical Review'
    )
}
                            </button>
                          )}
                          
                          {app.status === AppointmentStatus.NO_SHOW ? (

  <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-3 text-center">

  <UserX
    size={14}
    className="mx-auto mb-1 text-rose-600"
  />

  <p className="text-[9px] text-rose-600 leading-4 font-medium">
    Patient did not attend fundus examination appointment.
  </p>

</div>

) : (
                          <div className="grid grid-cols-2 gap-2">
                            {['right', 'left'].map(eye => {
                              const review = eye === 'right' ? app.rightEyeReview : app.leftEyeReview;
                              const details = eye === 'right' ? app.rightEyeReviewDetails : app.leftEyeReviewDetails;
                              
                              return (
                                <div key={eye} className="flex flex-col gap-1 p-2 bg-slate-50/50 rounded-lg border border-slate-100">
                                  <div className="flex items-center gap-1.5 mb-1">
                                    <span className={`w-1.5 h-1.5 rounded-full ${eye === 'right' ? 'bg-blue-600' : 'bg-emerald-600'}`}></span>
                                    <span className="text-[9px] font-black text-slate-400 uppercase tracking-tighter">
                                      {eye === 'right' ? 'RE' : 'LE'}
                                    </span>
                                  </div>
                                  
                                  {review ? (

  <>
    <span
      className={`text-[10px] font-bold uppercase leading-none ${
        details?.status === "Abnormal"
          ? "text-rose-600"
          : details?.status === "Ungradable"
            ? "text-orange-600"
            : "text-emerald-600"
      }`}
    >
      {details?.status || "Reviewed"}
    </span>

    {details?.status === "Abnormal" &&
      details?.abnormalTypes &&
      details.abnormalTypes.length > 0 && (

        <span className="text-[8px] font-medium text-slate-500 uppercase truncate">
          {details.abnormalTypes.join(", ")}
        </span>

    )}

  </>

) : (
  (
    eye === "right"
      ? app.rightEyeImageStatus === "Not Obtainable"
      : app.leftEyeImageStatus === "Not Obtainable"
  ) ? (

    <>
      <span className="text-[10px] font-bold text-amber-600 uppercase leading-none">
        Not Obtainable
      </span>

      <span className="text-[8px] text-slate-500 uppercase truncate">
        {eye === "right"
          ? app.rightEyeImageReason
          : app.leftEyeImageReason}
      </span>

    </>

  ) : (

    <span className="text-[9px] text-slate-300 italic font-medium uppercase tracking-tighter">
      Pending review
    </span>

  )
)}
                                </div>
                              );
                                                        })}
                          </div>

                        )}

                        </div>
                      </td>
<td className="px-6 py-4 text-center">

  {(() => {
    const canRepeatFundus =
      app.status === AppointmentStatus.DONE ||
      app.status === AppointmentStatus.NO_SHOW;

    return (
      <div className="flex w-full min-w-0 flex-col items-center gap-2">

        <div className="flex max-w-full flex-wrap items-center justify-center gap-1">
        {(currentUser?.role === UserRole.ADMIN || currentUser?.role === UserRole.SUPER_ADMIN) && isReviewCompleted(app) && app.referred === true && (
          <button
            onClick={() => startPatientReferral(app)}
            disabled={app.referralSent === true}
            className={`p-1.5 rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-70 ${app.referralSent ? 'text-emerald-600' : 'text-violet-600 hover:bg-violet-50'}`}
            title={app.referralSent ? `Referral dihantar${app.specialistClinicName ? ` ke ${app.specialistClinicName}` : ''}` : 'Lengkapkan borang dan hantar referral'}
            aria-label={`Rujuk pesakit ${app.patientName || 'patient'}`}
          >
            <Network size={18} />
          </button>
        )}

        {isReviewCompleted(app) && (
          <button
            onClick={() => void printPatientReport(app)}
            className="p-1.5 text-slate-500 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
            title="Print Patient Report (PDF)"
            aria-label={`Print patient report for ${app.patientName || 'patient'}`}
          >
            <Printer size={18} />
          </button>
        )}

        {/* ADMIN ONLY */}
        {(currentUser?.role === UserRole.ADMIN || currentUser?.role === UserRole.SUPER_ADMIN) && (
          <div className="flex items-center gap-2">

            <button
              onClick={() => {
                setEditingAppointment(app);
                setIsFormOpen(true);
              }}
              className="p-2 text-slate-500 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
              title="Edit"
            >
              <Edit2 size={18} />
            </button>

            <button
              onClick={() => confirmDelete(app)}
              className="p-1.5 text-slate-500 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors"
              title="Delete Patient Record"
            >
              <Trash2 size={18} />
            </button>

          </div>
        )}
        </div>

        {/* REPEAT FUNDUS */}
        <button
          disabled={!canRepeatFundus}
          onClick={() => {
            if (!canRepeatFundus) return;

            setEditingAppointment(null);
            setExistingPatient(app);
            setFormIC(app.icNumber);
            setFormPhone(app.phoneNumber);
            setFormReferringClinicId(app.referringClinicId || app.clinicId || currentUser?.clinicId || 'LINTANG');
            setFormFundusProviderClinicId(app.fundusProviderClinicId || currentClinic?.id || fundusProviderClinics[0]?.id || '');
            setSelectedDate(todayStr);
            setIsFormOpen(true);
          }}
          className={`px-3 py-1.5 rounded-lg text-[10px] font-bold transition-colors ${
            canRepeatFundus
              ? 'bg-cyan-600 text-white hover:bg-blue-700 cursor-pointer'
              : 'bg-slate-200 text-slate-400 cursor-not-allowed'
          }`}
          title={
            canRepeatFundus
              ? 'Repeat Fundus'
              : 'Available after Done or No Show'
          }
        >
          Repeat Fundus
        </button>

      </div>
    );
  })()}

</td>
                    </motion.tr>
                  );
                })}
              </AnimatePresence>
              {sortedAndFilteredAppointments.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-6 py-12 text-center text-slate-400 text-sm">
                    No appointments matching the current filters.
                  </td>
                </tr>
              )}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between px-6 py-4 border-t border-slate-100">

  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
    Page {currentPage} of {totalPages || 1}
  </span>

<div className="flex items-center gap-2 flex-wrap">

  <button
    onClick={() =>
      setCurrentPage(prev =>
        Math.max(prev - 1, 1)
      )
    }
    disabled={currentPage === 1}
    className="px-3 py-1 rounded-lg border border-slate-200 text-xs font-bold disabled:opacity-40"
  >
    Previous
  </button>

  {currentPage > 3 && (
    <>
      <button
        onClick={() => setCurrentPage(1)}
        className="w-8 h-8 rounded-lg text-xs font-black bg-white border border-slate-200 text-slate-600 hover:bg-slate-100"
      >
        1
      </button>

      <span className="text-slate-400 px-1">
        ...
      </span>
    </>
  )}

  {Array.from(
    { length: totalPages },
    (_, i) => i + 1
  )
    .filter(
      page =>
        page >= currentPage - 2 &&
        page <= currentPage + 2
    )
    .map(page => (

      <button
        key={page}
        onClick={() => setCurrentPage(page)}
        className={`w-8 h-8 rounded-lg text-xs font-black transition-all ${
          currentPage === page
            ? 'bg-slate-900 text-white'
            : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-100'
        }`}
      >
        {page}
      </button>

    ))}

  {currentPage < totalPages - 2 && (
    <>
      <span className="text-slate-400 px-1">
        ...
      </span>

      <button
        onClick={() =>
          setCurrentPage(totalPages)
        }
        className="w-8 h-8 rounded-lg text-xs font-black bg-white border border-slate-200 text-slate-600 hover:bg-slate-100"
      >
        {totalPages}
      </button>
    </>
  )}

  <button
    onClick={() =>
      setCurrentPage(prev =>
        Math.min(prev + 1, totalPages)
      )
    }
    disabled={currentPage === totalPages}
    className="px-3 py-1 rounded-lg border border-slate-200 text-xs font-bold disabled:opacity-40"
  >
    Next
  </button>

</div>
</div>
        </section>

        <AppFooter />
      </main>
      )}



      {/* =====================================================
          FUNDUS NETWORK
          Super Admin controls provider status and referral routing.
         ===================================================== */}
      <AnimatePresence>
        {showFundusNetwork && currentUser.role === UserRole.SUPER_ADMIN && (
          <div className="fixed inset-0 z-[120] flex items-start sm:items-center justify-center p-2 sm:p-4 overflow-y-auto overscroll-contain">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowFundusNetwork(false)}
              className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-5xl max-h-[calc(100dvh-1rem)] sm:max-h-[calc(100dvh-2rem)] bg-white rounded-[28px] shadow-2xl overflow-hidden flex flex-col"
            >
              <div className="p-4 sm:p-6 border-b border-slate-100 flex items-center justify-between bg-emerald-50/70">
                <div>
                  <h2 className="text-xl font-black text-slate-900">Fundus Network</h2>
                  <p className="text-[10px] font-black text-emerald-600 uppercase tracking-widest mt-1">
                    Provider clinics & referral routing
                  </p>
                </div>
                <button onClick={() => setShowFundusNetwork(false)} className="p-2 rounded-xl hover:bg-emerald-100 text-slate-400">
                  <XCircle size={24} />
                </button>
              </div>

              <div className="p-6 overflow-y-auto space-y-6">
                {/*--- Provider clinics ---*/}
                <section className="rounded-2xl border border-emerald-100 bg-emerald-50/40 p-5">
                  <div className="flex items-center justify-between gap-4 mb-4">
                    <div>
                      <h3 className="font-black text-slate-900">Fundus Provider Clinics</h3>
                      <p className="text-xs text-slate-500 mt-1">
                        Turn fundus service on or off for active clinics.
                      </p>
                    </div>
                    <div className="px-3 py-1.5 rounded-full bg-white border border-emerald-200 text-[10px] font-black text-emerald-700 uppercase">
                      {getFundusProviderClinics(clinics).length} active providers
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {clinics.filter(c => c.active).map(clinic => (
                      <div key={clinic.id} className="flex items-center justify-between gap-4 bg-white border border-slate-200 rounded-2xl p-4">
                        <div className="min-w-0">
                          <p className="font-black text-slate-900 truncate">{clinic.name}</p>
                          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mt-1">
                            {clinic.shortName} · {clinic.id}
                          </p>
                        </div>
                        <button
                          disabled={fundusNetworkSaving === `provider:${clinic.id}`}
                          onClick={async () => {
                            const nextValue = !clinic.isFundusProvider;
                            if (!nextValue && getFundusProviderClinics(clinics).length <= 1) {
                              alert('At least one active fundus provider clinic is required.');
                              return;
                            }
                            const savingKey = `provider:${clinic.id}`;
                            setFundusNetworkSaving(savingKey);

                            //--- Optimistic UI update ---//
                            const previousClinics = clinics;
                            pendingFundusProviderRef.current[clinic.id] = nextValue;
                            setClinics(prev =>
                              prev.map(c =>
                                c.id === clinic.id
                                  ? { ...c, isFundusProvider: nextValue }
                                  : !nextValue
                                    ? {
                                        ...c,
                                        fundusProviderClinicIds: (c.fundusProviderClinicIds || [])
                                          .filter(id => id !== clinic.id)
                                      }
                                    : c
                              )
                            );

                            try {
                              await setDoc(
                                doc(db, 'clinics', clinic.id),
                                { isFundusProvider: nextValue },
                                { merge: true }
                              );

                              //--- When a provider is disabled, remove it from referral routing ---//
                              if (!nextValue) {
                                const referralClinics = previousClinics.filter(
                                  c => c.active && !c.isFundusProvider && c.id !== clinic.id
                                );

                                await Promise.all(
                                  referralClinics
                                    .filter(c => (c.fundusProviderClinicIds || []).includes(clinic.id))
                                    .map(c =>
                                      setDoc(
                                        doc(db, 'clinics', c.id),
                                        {
                                          fundusProviderClinicIds: (c.fundusProviderClinicIds || [])
                                            .filter(id => id !== clinic.id)
                                        },
                                        { merge: true }
                                      )
                                    )
                                );
                              }

                              addActivityLog(
                                nextValue ? 'Enabled Fundus Provider' : 'Disabled Fundus Provider',
                                `${clinic.name} (${clinic.id})`,
                                currentUser.displayName
                              );
                            } catch (error) {
                              console.error('Failed to update fundus provider status', error);
                              delete pendingFundusProviderRef.current[clinic.id];
                              setClinics(previousClinics);
                              const code = (error as any)?.code || 'unknown';
                              alert(`Failed to update ${clinic.shortName}. Firestore error: ${code}`);
                            } finally {
                              setFundusNetworkSaving(null);
                            }
                          }}
                          className={`px-3 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest border ${
                            clinic.isFundusProvider
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                              : 'bg-slate-50 text-slate-500 border-slate-200'
                          }`}
                        >
                          {fundusNetworkSaving === `provider:${clinic.id}`
                            ? 'Saving...'
                            : clinic.isFundusProvider ? 'Provider: ON' : 'Provider: OFF'}
                        </button>
                      </div>
                    ))}
                  </div>
                </section>

                {/*--- Referral routing: multiple providers can be selected ---*/}
                <section className="rounded-2xl border border-blue-100 bg-blue-50/40 p-5">
                  <div className="mb-4">
                    <h3 className="font-black text-slate-900">Referral Routing</h3>
                    <p className="text-xs text-slate-500 mt-1">
                      Each non-provider clinic can have more than one fundus provider available for referral.
                    </p>
                  </div>

                  {/*--- Compact 3-column routing cards on larger screens so the modal stays usable on small laptops ---*/}
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                    {clinics.filter(c => c.active && !c.isFundusProvider).map(clinic => {
                      const providers = getFundusProviderClinics(clinics);
                      const selectedProviders = clinic.fundusProviderClinicIds || [];

                      return (
                        <div
                          key={clinic.id}
                          className="bg-white border border-slate-200 rounded-2xl p-3"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <p className="font-black text-slate-900">{clinic.name}</p>
                              <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mt-1">
                                Referral / source clinic
                              </p>
                            </div>

                            <div className="shrink-0 px-2 py-1 rounded-full bg-blue-50 border border-blue-100 text-[9px] font-black text-blue-700 uppercase">
                              {selectedProviders.length} provider{selectedProviders.length === 1 ? '' : 's'} selected
                            </div>
                          </div>

                          {providers.length === 0 ? (
                            <div className="mt-4 p-3 rounded-xl bg-amber-50 border border-amber-100 text-xs font-bold text-amber-700">
                              No active fundus provider clinic is available.
                            </div>
                          ) : (
                            <div className="mt-3 grid grid-cols-1 gap-2">
                              {providers.map(provider => {
                                const checked = selectedProviders.includes(provider.id);

                                return (
                                  <label
                                    key={provider.id}
                                    className={`flex items-center gap-2 p-2.5 rounded-xl border cursor-pointer transition-all ${
                                      checked
                                        ? 'bg-blue-50 border-blue-200'
                                        : 'bg-white border-slate-200 hover:bg-slate-50'
                                    }`}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      disabled={fundusNetworkSaving === `routing:${clinic.id}:${provider.id}`}
                                      onChange={async e => {
                                        const savingKey = `routing:${clinic.id}:${provider.id}`;
                                        const checkedNow = e.currentTarget.checked;
                                        setFundusNetworkSaving(savingKey);

                                        //--- Queue this clinic's routing change. Each queued action reads the latest state when it actually runs, preventing stale checkbox closures from overwriting earlier selections. ---//
                                        const previousQueue =
                                          fundusRoutingWriteQueueRef.current[clinic.id] || Promise.resolve();

                                        const queuedWrite = previousQueue.then(async () => {
                                          const latestClinic = clinicsRef.current.find(c => c.id === clinic.id);
                                          const currentProviders = latestClinic?.fundusProviderClinicIds || [];
                                          const nextProviders = checkedNow
                                            ? Array.from(new Set([...currentProviders, provider.id]))
                                            : currentProviders.filter(id => id !== provider.id);

                                          //--- Mark this clinic's latest routing value as pending ---//
                                          pendingFundusRoutingRef.current[clinic.id] = nextProviders;

                                          //--- Optimistic UI update using the latest queued value ---//
                                          setClinics(prev =>
                                            prev.map(c =>
                                              c.id === clinic.id
                                                ? { ...c, fundusProviderClinicIds: nextProviders }
                                                : c
                                            )
                                          );

                                          try {
                                            await setDoc(
                                              doc(db, 'clinics', clinic.id),
                                              { fundusProviderClinicIds: nextProviders },
                                              { merge: true }
                                            );

                                            addActivityLog(
                                              'Updated Fundus Routing',
                                              `${clinic.shortName} → ${nextProviders.length
                                                ? nextProviders.map(id => getClinicById(clinicsRef.current, id)?.shortName || id).join(', ')
                                                : 'No provider selected'}`,
                                              currentUser.displayName
                                            );
                                          } catch (error) {
                                            console.error('Failed to update fundus routing', error);
                                            delete pendingFundusRoutingRef.current[clinic.id];
                                            const code = (error as any)?.code || 'unknown';
                                            alert(`Failed to update ${clinic.shortName} routing. Firestore error: ${code}`);
                                          }
                                        });

                                        const queuedSafe = queuedWrite.catch(() => undefined);
                                        fundusRoutingWriteQueueRef.current[clinic.id] = queuedSafe;

                                        try {
                                          await queuedWrite;
                                        } finally {
                                          //--- Clear the queue entry only when this is still the latest queued task ---//
                                          if (fundusRoutingWriteQueueRef.current[clinic.id] === queuedSafe) {
                                            delete fundusRoutingWriteQueueRef.current[clinic.id];
                                            setFundusNetworkSaving(null);
                                          }
                                        }
                                      }}
                                      className="h-4 w-4"
                                    />

                                    <div className="min-w-0">
                                      <p className={`text-xs font-black ${
                                        checked ? 'text-blue-800' : 'text-slate-700'
                                      }`}>
                                        {provider.shortName}
                                      </p>
                                      <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">
                                        {provider.id}
                                      </p>
                                    </div>

                                    {checked && (
                                      <CheckCircle2 size={16} className="ml-auto text-blue-600 shrink-0" />
                                    )}
                                  </label>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}

                    {clinics.filter(c => c.active && !c.isFundusProvider).length === 0 && (
                      <div className="col-span-full text-center py-8 text-sm font-bold text-slate-400">
                        All active clinics are currently fundus providers.
                      </div>
                    )}
                  </div>
                </section>

                <div className="flex justify-end">
                  <button onClick={() => setShowFundusNetwork(false)} className="px-5 py-2.5 rounded-xl bg-slate-900 text-white text-xs font-black uppercase tracking-widest">
                    Done
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* =====================================================
          CLINIC MANAGEMENT
          Super Admin can add new clinics without editing code.
         ===================================================== */}
      <AnimatePresence>
        {showClinicManager && currentUser.role === UserRole.SUPER_ADMIN && (
          <div className="fixed inset-0 z-[120] flex items-start sm:items-center justify-center p-2 sm:p-4 overflow-y-auto overscroll-contain">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setShowClinicManager(false)} className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm" />
            <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} className="relative w-full max-w-4xl max-h-[calc(100dvh-1rem)] sm:max-h-[calc(100dvh-2rem)] bg-white rounded-[28px] shadow-2xl overflow-hidden flex flex-col">
              <div className="p-4 sm:p-6 border-b border-slate-100 flex items-center justify-between bg-slate-50/70">
                <div>
                  <h2 className="text-xl font-black text-slate-900">Clinic Management</h2>
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-1">Dynamic clinic master</p>
                </div>
                <button onClick={() => setShowClinicManager(false)} className="p-2 rounded-xl hover:bg-slate-200 text-slate-400"><XCircle size={24} /></button>
              </div>

              <div className="p-6 overflow-y-auto space-y-6">
                <form onSubmit={async (e) => {
                  e.preventDefault();
                  setIsAddingClinic(true);
                  const id = newClinicId.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
                  if (!id || !newClinicName.trim()) return;
                  if (clinics.some(c => c.id === id)) { alert('Clinic ID already exists.'); return; }
                  const clinic: Clinic = {
                    id,
                    name: newClinicName.trim(),
                    shortName: newClinicShortName.trim() || newClinicName.trim(),
                    address: newClinicAddress.trim(),
                    phone: newClinicPhone.trim(),
                    active: true,
                    isFundusProvider: newClinicIsFundusProvider,
                    colorKey: newClinicColorKey,
                  };
                  try {
                    await setDoc(doc(db, 'clinics', clinic.id), clinic);
                    addActivityLog('Created Clinic', `${clinic.name} (${clinic.id})`, currentUser.displayName);
                    setNewClinicId('');
                    setNewClinicName('');
                    setNewClinicShortName('');
                    setNewClinicAddress('');
                    setNewClinicPhone('');
                    setNewClinicIsFundusProvider(false);
                    setNewClinicColorKey('pink');
                  } catch (error) {
                    console.error('Failed to create clinic', error);
                    alert('Failed to create clinic. Please try again.');
                  } finally {
                    setIsAddingClinic(false);
                  }
                }} className="p-5 rounded-2xl border border-blue-100 bg-blue-50/50">
                  <div className="flex items-center gap-2 mb-4">
                    <Plus size={16} className="text-blue-600" />
                    <p className="text-xs font-black text-slate-800 uppercase tracking-widest">Add New Clinic</p>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-6 gap-3">
                    <input required value={newClinicId} onChange={e => setNewClinicId(e.target.value)} placeholder="CLINIC_ID" className="px-3 py-2.5 rounded-xl border border-blue-200 bg-white text-sm font-bold uppercase outline-none focus:ring-2 focus:ring-blue-500" />
                    <input required value={newClinicName} onChange={e => setNewClinicName(e.target.value)} placeholder="Clinic name" className="px-3 py-2.5 rounded-xl border border-blue-200 bg-white text-sm outline-none focus:ring-2 focus:ring-blue-500" />
                    <input value={newClinicShortName} onChange={e => setNewClinicShortName(e.target.value)} placeholder="Short name" className="px-3 py-2.5 rounded-xl border border-blue-200 bg-white text-sm outline-none focus:ring-2 focus:ring-blue-500" />
                    <textarea value={newClinicAddress} onChange={e => setNewClinicAddress(e.target.value)} rows={3} placeholder="Full clinic address (one line per row)" className="px-3 py-2.5 rounded-xl border border-blue-200 bg-white text-sm outline-none focus:ring-2 focus:ring-blue-500 md:col-span-2 resize-y" />
                    <input value={newClinicPhone} onChange={e => setNewClinicPhone(e.target.value)} placeholder="Clinic telephone number" className="px-3 py-2.5 rounded-xl border border-blue-200 bg-white text-sm outline-none focus:ring-2 focus:ring-blue-500" />
                    <select value={newClinicColorKey} onChange={e => setNewClinicColorKey(e.target.value as ClinicColorKey)} className="px-3 py-2.5 rounded-xl border border-blue-200 bg-white text-sm font-bold outline-none focus:ring-2 focus:ring-blue-500">
                      {CLINIC_COLORS.map(color => (
                        <option key={color.key} value={color.key}>{color.label}</option>
                      ))}
                    </select>
                    <button type="submit" disabled={isAddingClinic} className="px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-black text-xs uppercase tracking-widest disabled:opacity-50">{isAddingClinic ? 'Saving...' : 'Add Clinic'}</button>
                  </div>
                  <label className="flex items-center gap-2 mt-3 text-xs font-bold text-slate-600 cursor-pointer">
                    <input type="checkbox" checked={newClinicIsFundusProvider} onChange={e => setNewClinicIsFundusProvider(e.target.checked)} />
                    This clinic provides fundus screening
                  </label>
                </form>

                <div className="space-y-3">
                  {clinics.map(clinic => (
                    <div key={clinic.id} className="p-4 rounded-2xl border border-slate-200 bg-white flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-black text-slate-900">{clinic.name}</p>
                          <span className="text-[9px] font-black px-2 py-0.5 rounded bg-slate-100 text-slate-500 uppercase">{clinic.id}</span>
                        </div>
                        <p className="text-xs text-slate-400 mt-1">{clinic.shortName}</p>
                        {editingClinicAddressId === clinic.id ? (
                          <div className="mt-3 flex flex-col gap-2 max-w-2xl">
                            <textarea value={clinicAddressDraft} onChange={e => setClinicAddressDraft(e.target.value)} rows={3} placeholder="Alamat penuh klinik (satu baris untuk setiap baris alamat)" className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-sm outline-none focus:ring-2 focus:ring-blue-500 resize-y" />
                            <input value={clinicPhoneDraft} onChange={e => setClinicPhoneDraft(e.target.value)} placeholder="No. telefon klinik" className="w-full sm:max-w-sm px-3 py-2 rounded-xl border border-slate-200 bg-white text-sm outline-none focus:ring-2 focus:ring-blue-500" />
                            <div className="flex gap-2">
                              <button type="button" disabled={clinicAddressSaving === clinic.id} onClick={async () => {
                                setClinicAddressSaving(clinic.id);
                                try {
                                  await updateDoc(doc(db, 'clinics', clinic.id), { address: clinicAddressDraft.trim(), phone: clinicPhoneDraft.trim() });
                                  addActivityLog('Updated Clinic Address and Telephone', clinic.name, currentUser.displayName);
                                  setEditingClinicAddressId(null);
                                } catch (error) {
                                  console.error('Failed to update clinic address', error);
                                  alert('Failed to update clinic address. Please try again.');
                                } finally {
                                  setClinicAddressSaving(null);
                                }
                              }} className="px-3 py-2 rounded-lg bg-blue-600 text-white text-xs font-black disabled:opacity-50">{clinicAddressSaving === clinic.id ? 'Saving...' : 'Save address'}</button>
                              <button type="button" disabled={clinicAddressSaving === clinic.id} onClick={() => setEditingClinicAddressId(null)} className="px-3 py-2 rounded-lg border border-slate-200 text-slate-600 text-xs font-bold">Cancel</button>
                            </div>
                          </div>
                        ) : (
                          <div className="mt-2 flex items-start gap-2">
                            <div className="min-w-0"><p className="text-xs text-slate-500 whitespace-pre-line">{clinic.address || 'Full address not set'}</p><p className="text-xs text-slate-500 mt-1">{clinic.phone ? `Tel: ${clinic.phone}` : 'Telephone not set'}</p></div>
                            <button type="button" onClick={() => { setEditingClinicAddressId(clinic.id); setClinicAddressDraft(clinic.address || ''); setClinicPhoneDraft(clinic.phone || ''); }} className="shrink-0 px-2 py-1 rounded-lg border border-blue-200 text-blue-700 hover:bg-blue-50 text-[10px] font-black">{clinic.address ? 'Edit address' : 'Add address'}</button>
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <div className="flex items-center gap-2">
                          <span className={`w-3.5 h-3.5 rounded-full shrink-0 ${getClinicColor(clinic).dot}`} />
                          <span className="text-[8px] font-black text-slate-500 uppercase tracking-wide">Color</span>
                          <select
                            value={getClinicColor(clinic).key}
                            disabled={clinicColorSaving === clinic.id}
                            onChange={e => handleClinicColorChange(clinic, e.target.value as ClinicColorKey)}
                            className="h-8 min-w-[96px] px-2.5 rounded-lg border border-slate-200 bg-white text-[10px] font-black text-slate-700 outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
                            aria-label={`Choose color for ${clinic.name}`}
                          >
                            {CLINIC_COLORS.map(color => (
                              <option key={color.key} value={color.key}>{color.label}</option>
                            ))}
                          </select>
                        </div>
                        <span className={`px-2 py-1 rounded-lg text-[9px] font-black uppercase ${clinic.active ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>{clinic.active ? 'Active' : 'Inactive'}</span>
                        <span className={`px-2 py-1 rounded-lg text-[9px] font-black uppercase ${clinic.isFundusProvider ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-500'}`}>{clinic.isFundusProvider ? 'Fundus Provider' : 'Referral Clinic'}</span>
                        <button
                          type="button"
                          onClick={() => handleDeleteClinic(clinic)}
                          className="ml-1 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-rose-200 bg-rose-50 text-rose-600 hover:bg-rose-100 hover:border-rose-300 transition-all text-[9px] font-black uppercase"
                          title={`Delete ${clinic.name}`}
                        >
                          <Trash2 size={13} />
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* =====================================================
          REFERRAL CLINIC TCA SCHEDULE
          Clinic Admin manages TCA days only for referral clinics
          already authorised by Super Admin in Fundus Network.
         ===================================================== */}
      <AnimatePresence>
        {showReferralClinicManager && currentUser?.role === UserRole.ADMIN && (
          <div className="fixed inset-0 z-[120] flex items-start sm:items-center justify-center p-2 sm:p-4 overflow-y-auto overscroll-contain">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => !referralTcaSaving && setShowReferralClinicManager(false)}
              className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-3xl max-h-[calc(100dvh-1rem)] sm:max-h-[calc(100dvh-2rem)] bg-white rounded-[28px] shadow-2xl overflow-hidden flex flex-col"
            >
              <div className="p-4 sm:p-6 border-b border-slate-100 flex items-center justify-between bg-indigo-50/70">
                <div className="flex items-center gap-3">
                  <div className="w-11 h-11 rounded-2xl bg-indigo-600 text-white flex items-center justify-center shadow-lg">
                    <Calendar size={21} />
                  </div>
                  <div>
                    <h2 className="text-xl font-black text-slate-900">Manage Referral Clinic</h2>
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-1">
                      TCA schedule · {currentClinic?.shortName || currentUser?.clinicId || 'Clinic'}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  disabled={referralTcaSaving}
                  onClick={() => setShowReferralClinicManager(false)}
                  className="p-2 rounded-xl hover:bg-indigo-100 text-slate-400 disabled:opacity-50"
                >
                  <XCircle size={24} />
                </button>
              </div>

              <div className="p-6 overflow-y-auto space-y-4">
                <div className="rounded-2xl border border-indigo-100 bg-indigo-50/50 p-4">
                  <p className="text-xs font-black text-indigo-900">Referral clinic schedule</p>
                  <p className="text-[11px] text-indigo-700 mt-1 leading-relaxed">
                    Only clinics authorised by Super Admin through Fundus Network are shown here. Select one or more days when your clinic accepts TCA for each referral source.
                  </p>
                </div>

                {(() => {
                  const providerClinicId = currentUser?.clinicId;
                  const referralClinics = clinics.filter(
                    c => c.active && c.id !== providerClinicId && (c.fundusProviderClinicIds || []).includes(providerClinicId || '')
                  );
                  const dayOptions = [
                    { value: 1, label: 'Monday' },
                    { value: 2, label: 'Tuesday' },
                    { value: 3, label: 'Wednesday' },
                    { value: 4, label: 'Thursday' },
                    { value: 5, label: 'Friday' },
                    { value: 6, label: 'Saturday' },
                    { value: 0, label: 'Sunday' },
                  ];

                  if (referralClinics.length === 0) {
                    return (
                      <div className="text-center py-10 rounded-2xl border border-dashed border-slate-200 bg-slate-50">
                        <Network size={28} className="mx-auto text-slate-300 mb-3" />
                        <p className="text-sm font-black text-slate-500">No referral clinic configured</p>
                        <p className="text-[11px] text-slate-400 mt-1">Ask Super Admin to enable a referral route to this clinic first.</p>
                      </div>
                    );
                  }

                  return referralClinics.map(referralClinic => {
                    const selectedDays = referralTcaDraft[referralClinic.id] || [];
                    return (
                      <section key={referralClinic.id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                        <div className="flex items-center justify-between gap-3 mb-4">
                          <div>
                            <p className="font-black text-slate-900">{referralClinic.name}</p>
                            <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mt-1">{referralClinic.id}</p>
                          </div>
                          <span className="text-[9px] font-black uppercase px-2.5 py-1 rounded-lg bg-blue-50 text-blue-700 border border-blue-100">Referral Source</span>
                        </div>

                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                          {dayOptions.map(day => {
                            const checked = selectedDays.includes(day.value);
                            return (
                              <label
                                key={day.value}
                                className={`flex items-center gap-2 p-3 rounded-xl border cursor-pointer transition-all ${
                                  checked
                                    ? 'border-indigo-300 bg-indigo-50 text-indigo-800'
                                    : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100'
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  disabled={referralTcaSaving}
                                  onChange={e => {
                                    setReferralTcaDraft(prev => {
                                      const current = prev[referralClinic.id] || [];
                                      const next = e.target.checked
                                        ? Array.from(new Set([...current, day.value])).sort((a, b) => a - b)
                                        : current.filter(value => value !== day.value);
                                      return { ...prev, [referralClinic.id]: next };
                                    });
                                  }}
                                  className="accent-indigo-600"
                                />
                                <span className="text-xs font-black">{day.label}</span>
                              </label>
                            );
                          })}
                        </div>
                        <p className="text-[10px] text-slate-400 mt-3 font-semibold">
                          Selected: {selectedDays.length ? selectedDays.map(day => dayOptions.find(x => x.value === day)?.label).join(', ') : 'No TCA day configured'}
                        </p>
                      </section>
                    );
                  });
                })()}
              </div>

              <div className="p-5 border-t border-slate-100 bg-slate-50 flex justify-end gap-2">
                <button
                  type="button"
                  disabled={referralTcaSaving}
                  onClick={() => setShowReferralClinicManager(false)}
                  className="px-5 py-2.5 rounded-xl border border-slate-200 bg-white text-slate-600 text-xs font-black disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={referralTcaSaving}
                  onClick={async () => {
                    const providerClinicId = currentUser?.clinicId;
                    if (!providerClinicId) return;
                    setReferralTcaSaving(true);
                    try {
                      const providerClinic = clinics.find(c => c.id === providerClinicId);
                      if (!providerClinic) throw new Error('Provider clinic not found');

                      const allowedReferralIds = new Set(
                        clinics
                          .filter(c => c.active && c.id !== providerClinicId && (c.fundusProviderClinicIds || []).includes(providerClinicId))
                          .map(c => c.id)
                      );

                      const cleanedSchedule: Record<string, number[]> = {};
                      Object.entries(referralTcaDraft).forEach(([clinicId, days]) => {
                        if (allowedReferralIds.has(clinicId)) {
                          cleanedSchedule[clinicId] = Array.from(new Set(days)).sort((a, b) => a - b);
                        }
                      });

                      await setDoc(
                        doc(db, 'clinics', providerClinicId),
                        { referralTcaDays: cleanedSchedule },
                        { merge: true }
                      );

                      setClinics(prev => prev.map(c => c.id === providerClinicId ? { ...c, referralTcaDays: cleanedSchedule } : c));
                      addActivityLog(
                        'Updated Referral TCA Schedule',
                        `${providerClinic.shortName}: ${Object.entries(cleanedSchedule).map(([id, days]) => `${id} [${days.join(',') || 'none'}]`).join(' · ') || 'No schedules configured'}`,
                        currentUser.displayName
                      );
                      setShowReferralClinicManager(false);
                    } catch (error) {
                      console.error('Failed to save referral TCA schedule', error);
                      alert('Failed to save referral clinic schedule. Please try again.');
                    } finally {
                      setReferralTcaSaving(false);
                    }
                  }}
                  className="px-5 py-2.5 rounded-xl bg-indigo-600 text-white text-xs font-black hover:bg-indigo-700 disabled:opacity-50"
                >
                  {referralTcaSaving ? 'Saving...' : 'Save Schedule'}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Staff Management Console */}
      <AnimatePresence>
        {showAdminConsole && (
          <div className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto overscroll-contain bg-slate-900/40 p-2 backdrop-blur-sm sm:p-5">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => {
                if (isSavingStaff) return;
                setShowAdminConsole(false);
                setShowStaffForm(false);
                setEditingUser(null);
                setNewStaffId('');
                setNewStaffName('');
                setNewStaffPass('');
                setShowStaffPassword(false);
                setNewStaffRole(UserRole.STAFF);
                setNewStaffClinicId(currentUser?.clinicId ?? 'LINTANG');
              }}
              className="absolute inset-0 bg-transparent" 
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative my-auto w-full max-w-4xl max-h-[calc(100dvh-1rem)] sm:max-h-[calc(100dvh-2.5rem)] bg-white rounded-3xl border border-slate-200 shadow-2xl flex flex-col overflow-hidden"
            >
              <div className="p-5 sm:p-7 border-b border-slate-100 flex items-start justify-between bg-white">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 bg-teal-700 rounded-xl shadow-sm">
                    <Users size={20} className="text-white" />
                  </div>
                  <div>
                    <p className="text-[10px] font-black text-teal-700 uppercase tracking-[.18em] mb-1">{currentUser?.role === UserRole.SUPER_ADMIN ? 'Multi-clinic administration' : 'Clinic administration'}</p>
                    <h2 className="text-2xl font-black text-slate-900 leading-tight">{currentUser?.role === UserRole.SUPER_ADMIN ? 'User Management' : 'Staff Management'}</h2>
                    <p className="text-sm text-slate-500 mt-1">{currentUser?.role === UserRole.SUPER_ADMIN ? 'Manage user accounts across clinics.' : `Manage staff accounts for ${currentClinic?.name || 'this clinic'}.`}</p>
                  </div>
                </div>
                <button 
                  onClick={() => {

  if (isSavingStaff) return;

  setShowAdminConsole(false);
  setShowStaffForm(false);
  setEditingUser(null);

  setNewStaffId('');
  setNewStaffName('');
  setNewStaffPass('');
  setShowStaffPassword(false);
  setNewStaffRole(UserRole.STAFF);
  setNewStaffClinicId(currentUser?.clinicId ?? 'LINTANG');

}}
                  className="p-2 hover:bg-slate-100 rounded-xl transition-colors text-slate-400"
                >
                  <XCircle size={24} />
                </button>
              </div>

              <div className="p-5 sm:p-7 space-y-5 overflow-y-auto bg-white">
                {/* Add/Edit Staff Form */}
                <section>

  <button
    type="button"
    onClick={() => {
      if (showStaffForm) {
        setShowStaffForm(false);
        setNewStaffId('');
        setNewStaffName('');
        setNewStaffPass('');
        setShowStaffPassword(false);
        setNewStaffRole(UserRole.STAFF);
        setNewStaffClinicId(currentUser?.clinicId ?? 'LINTANG');
      } else {
        setEditingUser(null);
        setNewStaffId('');
        setNewStaffName('');
        setNewStaffPass('');
        setShowStaffPassword(false);
        setNewStaffRole(UserRole.STAFF);
        setNewStaffClinicId(currentUser?.clinicId ?? 'LINTANG');
        setShowStaffForm(true);
      }
    }}
    className="w-full flex items-center justify-between mb-4"
  >
    <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-2">
      {editingUser ? <Edit2 size={14} className="text-teal-700" /> : <UserPlus size={14} className="text-teal-700" />}
      {editingUser ? `Editing Account: ${editingUser.id}` : (currentUser?.role === UserRole.SUPER_ADMIN ? 'Register New Clinic User' : 'Register New Clinical Staff')}
    </h3>

    {!editingUser && (
      <span className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-4 py-3 text-xs font-black text-white shadow-sm transition hover:bg-violet-700 disabled:opacity-40">
        {showStaffForm ? <XCircle size={16}/> : <UserPlus size={16}/>} {showStaffForm ? 'Close form' : 'Add new user'}
      </span>
    )}
  </button>

  {(showStaffForm || editingUser) && (

  <form
  onSubmit={editingUser ? updateStaffMember : addStaffMember}
  className="bg-teal-50/50 p-3 md:p-4 rounded-2xl border border-teal-100"
>

  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">

    <div className="space-y-1">
      <label className="text-[9px] font-bold text-teal-700 uppercase ml-1">
        Staff User ID
      </label>

      <input
        type="text"
        required
        className="w-full px-4 py-2.5 rounded-xl border border-teal-200 focus:ring-2 focus:ring-teal-600 outline-none text-sm font-bold"
        value={editingUser ? editingUser.id : newStaffId}
        onChange={e =>
          editingUser
            ? setEditingUser({
                ...editingUser,
                id: e.target.value
              })
            : setNewStaffId(e.target.value)
        }
      />
    </div>

    <div className="space-y-1">
      <label className="text-[9px] font-bold text-teal-700 uppercase ml-1">
        Password
      </label>

      <div className="relative">
        <input
          type={showStaffPassword ? "text" : "password"}
          required={!editingUser}
          placeholder={editingUser ? 'Leave blank to keep current password' : 'Enter password'}
          className="w-full px-4 pr-11 py-2.5 rounded-xl border border-teal-200 focus:ring-2 focus:ring-teal-600 outline-none text-sm font-medium"
          value={newStaffPass}
          onChange={e =>
            editingUser
              ? setEditingUser({
                  ...editingUser,
                  password: e.target.value
                })
              : setNewStaffPass(e.target.value)
          }
        />
        <button
          type="button"
          onClick={() => setShowStaffPassword(prev => !prev)}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
          aria-label={showStaffPassword ? "Hide password" : "Show password"}
        >
          {showStaffPassword ? <EyeOff size={17} /> : <Eye size={17} />}
        </button>
      </div>
    </div>

    <div className="space-y-1">
      <label className="text-[9px] font-bold text-teal-700 uppercase ml-1">
        Display Name
      </label>

      <input
        type="text"
        required
        placeholder="e.g. Dr. Johny"
        className="w-full px-4 py-2.5 rounded-xl border border-teal-200 focus:ring-2 focus:ring-teal-600 outline-none text-sm font-medium"
        value={
          editingUser
            ? editingUser.displayName
            : newStaffName
        }
        onChange={e =>
          editingUser
            ? setEditingUser({
                ...editingUser,
                displayName: e.target.value
              })
            : setNewStaffName(e.target.value)
        }
      />
    </div>

  </div>

  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">

    <div className="space-y-1">
      <label className="text-[9px] font-bold text-teal-700 uppercase ml-1">
        Clinic
      </label>
      {currentUser?.role === UserRole.SUPER_ADMIN ? (
        <select
          value={editingUser ? (editingUser.clinicId || '') : newStaffClinicId}
          onChange={e =>
            editingUser
              ? setEditingUser({ ...editingUser, clinicId: e.target.value || null })
              : setNewStaffClinicId(e.target.value)
          }
          disabled={editingUser?.role === UserRole.SUPER_ADMIN}
          className="w-full px-4 py-2.5 rounded-xl border border-teal-200 bg-white text-sm font-bold text-slate-700 outline-none focus:ring-2 focus:ring-teal-600 disabled:bg-slate-100 disabled:text-slate-500"
        >
          <option value="">No clinic (Super Admin)</option>
          {clinics.filter(clinic => clinic.active).map(clinic => (
            <option key={clinic.id} value={clinic.id}>{clinic.name}</option>
          ))}
        </select>
      ) : (
        <div className="w-full px-4 py-2.5 rounded-xl border border-teal-200 bg-white text-sm font-bold text-slate-700">
          {currentClinic?.name || 'Klinik Kesihatan Lintang'}
        </div>
      )}
      <p className="text-[9px] text-slate-400 ml-1 mt-1">
        {currentUser?.role === UserRole.SUPER_ADMIN ? 'Assign this account to a clinic.' : 'Account is automatically assigned to this clinic.'}
      </p>
    </div>

    <div className="space-y-1">
      <label className="text-[9px] font-bold text-teal-700 uppercase ml-1">
        Role
      </label>
      {currentUser?.role === UserRole.SUPER_ADMIN ? (
        <select
          value={editingUser ? editingUser.role : newStaffRole}
          onChange={e =>
            editingUser
              ? setEditingUser({ ...editingUser, role: e.target.value as UserRole, clinicId: e.target.value === UserRole.SUPER_ADMIN ? null : (editingUser.clinicId || newStaffClinicId || 'LINTANG') })
              : setNewStaffRole(e.target.value as UserRole)
          }
          className="w-full px-4 py-2.5 rounded-xl border border-teal-200 bg-white text-sm font-bold text-slate-700 outline-none focus:ring-2 focus:ring-teal-600"
        >
          <option value={UserRole.STAFF}>STAFF</option>
          <option value={UserRole.ADMIN}>ADMIN</option>
        </select>
      ) : editingUser && currentUser?.role === UserRole.ADMIN ? (
        <select
          value={editingUser.role}
          onChange={e => setEditingUser({ ...editingUser, role: e.target.value as UserRole })}
          className="w-full px-4 py-2.5 rounded-xl border border-teal-200 bg-white text-sm font-bold text-slate-700 outline-none focus:ring-2 focus:ring-teal-600"
        >
          <option value={UserRole.STAFF}>STAFF</option>
          <option value={UserRole.ADMIN}>ADMIN</option>
        </select>
      ) : (
        <div className="w-full px-4 py-2.5 rounded-xl border border-teal-200 bg-slate-50 text-sm font-bold text-slate-700">
          STAFF
        </div>
      )}
      <p className="text-[9px] text-slate-400 ml-1 mt-1">
        {currentUser?.role === UserRole.SUPER_ADMIN
          ? 'Super Admin can create ADMIN or STAFF accounts for each clinic.'
          : editingUser
            ? 'Admin klinik boleh menukar role akaun sedia ada antara STAFF dan ADMIN. Akaun baharu kekal STAFF.'
            : 'Akaun baharu oleh admin klinik akan dicipta sebagai STAFF. Untuk cipta ADMIN baharu, hubungi Super Admin.'}
      </p>
    </div>

  </div>

  <div className="flex justify-end mt-5 gap-2">

    {editingUser && (
      <button
        type="button"
        onClick={() => setEditingUser(null)}
        className="bg-white border border-slate-200 text-slate-500 font-bold px-4 py-2 rounded-xl text-[10px] uppercase tracking-widest hover:bg-slate-50"
      >
        Cancel Edit
      </button>
    )}

    <button
      type="submit"
      disabled={isSavingStaff}
      className={`${
        editingUser
          ? 'bg-emerald-600 hover:bg-emerald-700'
          : 'bg-teal-700 hover:bg-teal-800'
      } text-white font-black px-5 py-2.5 rounded-xl transition-all shadow-lg active:scale-95 text-[10px] uppercase tracking-widest`}
    >
      {isSavingStaff
        ? 'Saving...'
        : editingUser
          ? 'Save Changes'
          : 'Create Account'}
    </button>

  </div>

</form>

)}

</section>

{/* Existing Staff List */}
<section className="flex flex-col max-h-[420px]">
                  <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-4">{currentUser?.role === UserRole.SUPER_ADMIN ? 'Current System Users' : 'Current Clinic Users'} ({users.filter(u => currentUser?.role === UserRole.SUPER_ADMIN ? true : u.clinicId === currentUser?.clinicId).length})</h3>
                  <div className="space-y-2 overflow-y-auto overscroll-contain pr-2 h-full">
                    {users
  .filter(u => currentUser?.role === UserRole.SUPER_ADMIN || u.clinicId === currentUser?.clinicId)
  .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  .map(u => (
                      <div key={u.id} className="flex items-center justify-between p-4 bg-white border border-slate-100 rounded-2xl hover:border-slate-200 transition-all group">
                        <div className="flex items-center gap-4">
                          <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${u.role === UserRole.ADMIN ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600'}`}>
                            {u.role === UserRole.ADMIN ? <ShieldCheck size={20} /> : <UserIcon size={20} />}
                          </div>
                          <div>
                            <div className="flex flex-wrap items-center gap-2">

  <span className="font-black text-slate-800 tracking-tight text-base">
    {u.displayName}
  </span>

  <span className="text-[10px] text-slate-400 font-bold">
    ({u.id})
  </span>

  <span
    className={`text-[8px] font-black uppercase px-2 py-0.5 rounded ${
      u.role === UserRole.ADMIN
        ? 'bg-blue-600 text-white'
        : 'bg-slate-200 text-slate-600'
    }`}
  >
    {u.role}
  </span>

  {/* Clinic Badge */}
  {(() => {
    const userClinic = getClinicById(clinics, u.clinicId);
    const clinicColor = getClinicColor(userClinic);
    return (
      <span
        className={`text-[8px] font-black uppercase px-2 py-0.5 rounded border ${clinicColor.badge}`}
        title={userClinic?.name || u.clinicId || 'Clinic'}
      >
        {userClinic?.shortName || u.clinicId || 'Clinic'}
      </span>
    );
  })()}


</div>
                            <div className="flex items-center gap-3 mt-1">
                              <span className="text-[10px] text-slate-400 font-medium flex items-center gap-1">
                                <Key size={10} /> ••••••
                              </span>
                              <span className="text-[10px] text-slate-300 font-medium">
                                Created {new Date(u.createdAt).toLocaleDateString('en-GB', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric'
})}
                              </span>
                            </div>
                          </div>
                        </div>
                        {u.id !== 'admin' && (
                          <div className="flex flex-wrap items-center gap-2">
                            <button 
                              onClick={() => setEditingUser(u)}
                              className="p-2 text-slate-400 hover:text-teal-700 hover:bg-teal-50 rounded-xl transition-all md:opacity-0 md:group-hover:opacity-100"
                              title="Edit User"
                            >
                              <Edit2 size={18} />
                            </button>
                            <button 
                              onClick={() => setUserToDelete(u)}
                              className="p-2 text-slate-400 hover:text-rose-500 hover:bg-rose-50 rounded-xl transition-all md:opacity-0 md:group-hover:opacity-100"
                              title="Delete User"
                            >
                              <Trash2 size={18} />
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              </div>
              
              <div className="p-4 bg-slate-50 border-t border-slate-100 text-center">
                <p className="text-[9px] text-slate-400 font-bold uppercase tracking-tighter">Only Admin can manage these credentials. Keep passwords secure.</p>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {userToDelete && (
          <div className="fixed inset-0 z-[200] flex items-start sm:items-center justify-center p-2 sm:p-4 overflow-y-auto overscroll-contain">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setUserToDelete(null)}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden relative z-10 p-6 text-center border border-slate-100"
            >
              <div className="flex justify-center mb-4">
                <div className="p-3 bg-rose-50 rounded-2xl text-rose-600">
                  <AlertCircle size={28} />
                </div>
              </div>
              <h3 className="text-lg font-black text-slate-800 mb-1 uppercase tracking-tight">Delete User Account?</h3>
              <p className="text-xs text-slate-500 mb-6 leading-relaxed">
                Are you sure you want to remove <span className="font-black text-slate-700">{userToDelete.displayName}</span> ({userToDelete.id})? This staff member will lose all access to the system.
              </p>
              <div className="flex gap-3">
                <button 
                  onClick={() => setUserToDelete(null)}
                  className="flex-1 py-3 bg-slate-100 hover:bg-slate-200 text-slate-600 font-bold rounded-xl transition-all text-[11px] uppercase tracking-widest"
                >
                  Cancel
                </button>
                <button 
                  onClick={() => removeStaffMember(userToDelete.id)}
                  className="flex-1 py-3 bg-rose-600 hover:bg-rose-700 text-white font-black rounded-xl transition-all shadow-lg shadow-rose-100 text-[11px] uppercase tracking-widest"
                >
                  Confirm Delete
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

{showDuplicateWarning && duplicatePatient && (
  <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-2 sm:p-4 overflow-y-auto overscroll-contain bg-black/50 backdrop-blur-sm">
    <div className="w-full max-w-lg max-h-[calc(100dvh-1rem)] overflow-y-auto overscroll-contain rounded-2xl bg-white shadow-2xl">

      {/* Header */}
      <div className="border-b px-6 py-4">
        <h2 className="text-xl font-bold text-amber-600">
          ⚠ Fundus Already Performed
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          This patient already has a fundus screening for this year.
        </p>
      </div>

      {/* Body */}
      <div className="space-y-4 px-6 py-5">

        <div>
          <p className="text-xs text-slate-500">Patient</p>
          <p className="font-semibold">
            {duplicatePatient.patientName}
          </p>
        </div>

        <div>
          <p className="text-xs text-slate-500">IC Number</p>
          <p>{duplicatePatient.icNumber}</p>
        </div>

        <div>
          <p className="text-xs text-slate-500">Fundus Date</p>
          <p>{formatDisplayDate(duplicatePatient.date)}</p>
        </div>

        <div>
          <p className="text-xs text-slate-500">Clinic</p>
          <p>{getClinicById(clinics, duplicatePatient.clinicId)?.name || 'Klinik Kesihatan Lintang'}</p>
        </div>

        {duplicatePatient.fundusProviderClinicId && (
          <div>
            <p className="text-xs text-slate-500">Fundus Provider</p>
            <p>{getClinicById(clinics, duplicatePatient.fundusProviderClinicId)?.name || duplicatePatient.fundusProviderClinicId}</p>
          </div>
        )}

        <div>
          <p className="text-xs text-slate-500">Status</p>
          <StatusBadge status={duplicatePatient.status} />
        </div>

      </div>

      {/* Footer */}
      <div className="flex justify-end gap-3 border-t px-6 py-4">

        <button
          onClick={() => {
  setShowDuplicateWarning(false);
  setDuplicatePatient(null);
  setLookupIC("");
  setIsICLookupOpen(true);
}}
          className="rounded-lg border px-4 py-2"
        >
          Cancel
        </button>

        <button
  onClick={() => {
    if (!duplicatePatient) return;

    //--- Open the previous fundus record but keep duplicatePatient alive so Close can return to this warning ---//
    setSelectedHistory(duplicatePatient);
    setShowDuplicateWarning(false);
  }}
  className="rounded-lg border px-4 py-2"
>
  View Previous
</button>
        <button
          onClick={() => {
  setShowDuplicateWarning(false);
  setDuplicatePatient(null);
  setIsFormOpen(true);
}}
          className="rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
        >
          Continue Anyway
        </button>

      </div>

    </div>
  </div>
)}

{/* IC Lookup Modal */}

<AnimatePresence>
  {isICLookupOpen && (
    <div className="fixed inset-0 z-[120] flex items-start sm:items-center justify-center p-2 sm:p-4 overflow-y-auto overscroll-contain">

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={() => setIsICLookupOpen(false)}
        className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
      />

      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 20 }}
        className="relative z-10 bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden"
      >

        <div className="px-6 py-5 border-b border-slate-100">

          <h2 className="text-xl font-bold text-slate-800">
            New Appointment
          </h2>

          <p className="text-sm text-slate-500 mt-1">
            Enter patient's IC Number
          </p>

        </div>

        <div className="p-6">

          <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
            IC Number
          </label>

          <input
  autoFocus
  value={lookupIC}
  onChange={(e) => {
    //--- Auto format IC: XXXXXX-XX-XXXX ---//
    const digits = e.target.value.replace(/\D/g, "").slice(0, 12);
    setLookupIC(formatIC(digits));
}}
  onKeyDown={(e) => {
  if (
    e.key === "Enter" &&
    lookupIC.replace(/\D/g, "").length === 12
  ) {
    e.preventDefault();
    handlePatientLookup();
  }
}}
  inputMode="numeric"
  maxLength={14}
  placeholder="900101-08-5555"
  className="w-full px-4 py-3 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-blue-500"
/>

          <div className="flex gap-3 mt-6">

            <button
              onClick={() => setIsICLookupOpen(false)}
              className="flex-1 py-3 rounded-xl border border-slate-200 font-semibold hover:bg-slate-50"
            >
              Cancel
            </button>

            <button
  disabled={lookupIC.replace(/\D/g, "").length !== 12}
  onClick={handlePatientLookup}
  className={`flex-1 py-3 rounded-xl font-semibold transition-all ${
    lookupIC.replace(/\D/g, "").length === 12
      ? "bg-blue-600 hover:bg-blue-700 text-white"
      : "bg-slate-200 text-slate-400 cursor-not-allowed"
  }`}
>
  Continue
</button>

          </div>

        </div>

      </motion.div>

    </div>
  )}
</AnimatePresence>

      {/*--- Super Admin Monthly Clinic Clinical Detail Modal ---*/}
      <AnimatePresence>
        {showSuperAdminClinicDetail && superAdminClinicMonthlyDetail && (
          <div className="fixed inset-0 z-[9998] flex items-start sm:items-center justify-center p-2 sm:p-4 overflow-y-auto overscroll-contain">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowSuperAdminClinicDetail(false)}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
            />

            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl max-h-[calc(100dvh-1rem)] sm:max-h-[calc(100dvh-2rem)] overflow-hidden relative z-10 flex flex-col"
            >
              <div className="px-6 py-5 border-b border-slate-100 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-[10px] font-black text-blue-600 uppercase tracking-widest mb-1">Monthly Clinical Summary</p>
                  <h2 className="text-xl font-black text-slate-900 truncate">{superAdminClinicMonthlyDetail.clinic.name}</h2>
                  <p className="text-xs font-bold text-slate-400 mt-1">
                    {selectedAnalyticsMonth.toLocaleString('en-US', { month: 'long', year: 'numeric' })} · {superAdminClinicMonthlyDetail.clinic.id}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowSuperAdminClinicDetail(false)}
                  className="shrink-0 p-2 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
                  aria-label="Close monthly clinical summary"
                >
                  <XCircle size={22} />
                </button>
              </div>

              <div className="p-6 overflow-y-auto space-y-6">
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                  <div className="text-center rounded-2xl bg-slate-50 border border-slate-100 p-3">
                    <p className="text-[8px] font-black text-slate-400 uppercase">Total</p>
                    <p className="text-2xl font-black text-slate-900 mt-1">{superAdminClinicMonthlyDetail.total}</p>
                  </div>
                  <div className="text-center rounded-2xl bg-emerald-50 border border-emerald-100 p-3">
                    <p className="text-[8px] font-black text-emerald-600 uppercase">Normal</p>
                    <p className="text-2xl font-black text-emerald-600 mt-1">{superAdminClinicMonthlyDetail.normal}</p>
                  </div>
                  <div className="text-center rounded-2xl bg-rose-50 border border-rose-100 p-3">
                    <p className="text-[8px] font-black text-rose-600 uppercase">Abnormal</p>
                    <p className="text-2xl font-black text-rose-600 mt-1">{superAdminClinicMonthlyDetail.abnormal}</p>
                  </div>
                  <div className="text-center rounded-2xl bg-orange-50 border border-orange-100 p-3">
                    <p className="text-[8px] font-black text-orange-600 uppercase">Ungradable</p>
                    <p className="text-2xl font-black text-orange-600 mt-1">{superAdminClinicMonthlyDetail.ungradable}</p>
                  </div>
                  <div className="text-center rounded-2xl bg-amber-50 border border-amber-100 p-3">
                    <p className="text-[8px] font-black text-amber-600 uppercase">Not Obtainable</p>
                    <p className="text-2xl font-black text-amber-600 mt-1">{superAdminClinicMonthlyDetail.notObtainable}</p>
                  </div>
                  <div className="text-center rounded-2xl bg-indigo-50 border border-indigo-100 p-3">
                    <p className="text-[8px] font-black text-indigo-600 uppercase">Not Review Yet</p>
                    <p className="text-2xl font-black text-indigo-600 mt-1">{superAdminClinicMonthlyDetail.notReviewYet}</p>
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Reten Findings</h3>
                    <span className="text-[9px] font-bold text-slate-400">Selected month only</span>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {[
                      ['Mild NPDR', superAdminClinicMonthlyDetail.mildNPDR],
                      ['Moderate NPDR', superAdminClinicMonthlyDetail.moderateNPDR],
                      ['Severe NPDR', superAdminClinicMonthlyDetail.severeNPDR],
                      ['PDR', superAdminClinicMonthlyDetail.pdr],
                      ['Maculopathy', superAdminClinicMonthlyDetail.maculopathy],
                      ['ADED', superAdminClinicMonthlyDetail.aded],
                      ['Cataract', superAdminClinicMonthlyDetail.cataract],
                    ].map(([label, value]) => (
                      <div key={label as string} className="rounded-2xl border border-slate-200 bg-white p-4">
                        <p className="text-[9px] font-black text-slate-400 uppercase">{label}</p>
                        <p className="text-2xl font-black text-slate-800 mt-1">{value}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Appointment Modal Overlay */}
      <AnimatePresence>
        {isFormOpen && (
          <div className="fixed inset-0 z-[100] flex items-start sm:items-center justify-center p-2 sm:p-4 overflow-y-auto overscroll-contain">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => !isSavingAppointment && closeForm()}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[calc(100dvh-1rem)] sm:max-h-[calc(100dvh-2rem)] overflow-hidden relative z-10 flex flex-col"
            >
              <div className="px-4 sm:px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50">
                <h2 className="text-lg font-bold text-slate-800">
                  {editingAppointment ? 'Edit Appointment' : 'Create Appointment'}
                </h2>
                <button onClick={() => !isSavingAppointment && closeForm()} disabled={isSavingAppointment} className="text-slate-400 hover:text-slate-600 disabled:opacity-50">
                  <XCircle size={24} />
                </button>
              </div>

              <form 
                className="p-4 sm:p-6 space-y-4 overflow-y-auto overscroll-contain min-h-0"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const formData = new FormData(e.currentTarget);
                    const selectedDiseases = DISEASE_OPTIONS.filter(d => formData.get(`disease_${d}`) === 'on');
                    
                    upsertAppointment({
                      patientName: (formData.get('patientName') as string || '').toUpperCase().trim(),
                      icNumber: formIC,
                      phoneNumber: formPhone,
                      date: (formData.get('date') as string) || '',
                      remarks: (formData.get('remarks') as string || '').toUpperCase().trim(),
                      diseaseTypes: selectedDiseases,
                      otherDisease: ((formData.get('otherDisease') as string) || '').toUpperCase().trim(),
                      rightEyeVAUnaided: ((formData.get('rightEyeVAUnaided') as string) || '').trim(),
                      leftEyeVAUnaided: ((formData.get('leftEyeVAUnaided') as string) || '').trim(),
                      rightEyeVAWithGlasses: ((formData.get('rightEyeVAWithGlasses') as string) || '').trim(),
                      leftEyeVAWithGlasses: ((formData.get('leftEyeVAWithGlasses') as string) || '').trim(),
                      rightEyeVAPinhole: ((formData.get('rightEyeVAPinhole') as string) || '').trim(),
                      leftEyeVAPinhole: ((formData.get('leftEyeVAPinhole') as string) || '').trim(),
                    });
                  }}
              >
                <div className="grid grid-cols-1 gap-4">
                  <div>
                    <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Patient Name</label>
                    <input 
  name="patientName"
  required
  type="text"
  defaultValue={
    editingAppointment?.patientName ??
    existingPatient?.patientName ??
    ""
  }
  className="w-full px-4 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none uppercase"
/>
                  </div>

                  {/* =========================================================
                      PATIENT IDENTIFICATION
                      IC Number + Phone Number
                     ========================================================= */}
                  <div className="grid grid-cols-2 gap-4">
                    {/*--- IC NUMBER ---*/}
                    <div>
                      <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">
                        IC Number
                      </label>
                      <input
                        name="icNumber"
                        type="text"
                        value={formIC}
                        readOnly
                        className="w-full px-4 py-2 border border-slate-200 rounded-lg bg-slate-100 text-slate-600 cursor-not-allowed"
                      />
                    </div>

                    {/*--- PHONE NUMBER ---*/}
                    <div>
                      <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">
                        Phone Number
                      </label>
                      <input
                        name="phoneNumber"
                        required
                        type="tel"
                        value={formPhone}
                        onChange={handlePhoneChange}
                        className="w-full px-4 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none uppercase"
                      />
                    </div>
                  </div>

                  {/* =========================================================
                      REFERRAL / FUNDUS ROUTING
                      Source clinic and fundus provider are separate fields.
                     ========================================================= */}
                  <div className="grid grid-cols-2 gap-4 items-start">
                    <div className="min-w-0 space-y-4">
                    {/*--- ASAL / KLINIK PERUJUK ---*/}
                    <div>
                      <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">
                        Asal / Klinik Perujuk
                      </label>

                      <select
                        value={formReferringClinicId}
                        onChange={e => setFormReferringClinicId(e.target.value)}
                        required
                        className="w-full px-4 py-2.5 rounded-xl border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-none text-sm font-medium bg-white"
                      >
                        <option value="">Pilih asal klinik</option>

                        {clinics
                          .filter(clinic => {
                            //--- Non-provider clinic: only allow the clinic's own environment as the source ---//
                            if (!currentClinic?.isFundusProvider) {
                              return clinic.active && clinic.id === currentClinic?.id;
                            }

                            //--- Provider clinic: show own clinic plus clinics routed to this fundus provider in Fundus Network ---//
                            if (!clinic.active) return false;
                            if (clinic.id === currentClinic.id) return true;

                            return (clinic.fundusProviderClinicIds || []).includes(currentClinic.id);
                          })
                          .map(clinic => (
                            <option key={clinic.id} value={clinic.id}>
                              {clinic.name}
                            </option>
                          ))}
                      </select>

                      <p className="text-[9px] text-slate-400 mt-1">
                        Menunjukkan patient berasal atau dirujuk dari fasiliti mana.
                      </p>
                    </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Medical History</label>
                    <div className="flex flex-wrap gap-x-4 gap-y-2">
                      {DISEASE_OPTIONS.map(d => (
                        <label key={d} className="flex items-center gap-2 cursor-pointer group">
                          <input 
                            type="checkbox" 
                            name={`disease_${d}`}
                            defaultChecked={
  editingAppointment
    ? !!editingAppointment.diseaseTypes?.includes(d)
    : !!existingPatient?.diseaseTypes?.includes(d)
}
                            className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                          />
                          <span className="text-sm font-medium text-slate-700 group-hover:text-blue-600">{d}</span>
                        </label>
                      ))}
                    </div>
                    <div className="mt-3 flex items-center gap-2">
                       <label className="flex items-center gap-2 min-w-[70px]">
                        <input 
                          type="checkbox" 
                          name="has_other"
                          defaultChecked={
  editingAppointment
    ? !!editingAppointment.otherDisease
    : !!existingPatient?.otherDisease
}
                          onChange={(e) => {
                            const input = document.getElementById('other-input') as HTMLInputElement;
                            if (input) input.disabled = !e.target.checked;
                          }}
                          className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                        />
                        <span className="text-sm font-medium text-slate-700">Other</span>
                      </label>
                      <input 
                        id="other-input"
                        name="otherDisease"
                        type="text" 
                        disabled={!(editingAppointment?.otherDisease || existingPatient?.otherDisease)}
                        defaultValue={editingAppointment?.otherDisease ?? existingPatient?.otherDisease ?? ""}
                        placeholder="Please specify..."
                        className="w-28 sm:w-32 max-w-[140px] px-2 py-1.5 border border-slate-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500 uppercase disabled:bg-slate-50 disabled:text-slate-400"
                      />
                    </div>
                  </div>
                    </div>
                    <div className="min-w-0 space-y-4">
                    {/*--- KLINIK RUJUKAN FUNDUS ---*/}
                    <div>
                      <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">
                        Klinik Rujukan Fundus
                      </label>

                      {currentClinic?.isFundusProvider ? (
                        <div className="w-full px-4 py-2.5 rounded-xl border border-emerald-200 bg-emerald-50 text-sm font-bold text-emerald-700">
                          {currentClinic.name}
                          <span className="text-[10px] font-black uppercase ml-2">
                            (Fundus Provider)
                          </span>
                        </div>
                      ) : (
                        <select
                          value={formFundusProviderClinicId}
                          onChange={e => setFormFundusProviderClinicId(e.target.value)}
                          required
                          className="w-full px-4 py-2.5 rounded-xl border border-blue-200 focus:ring-2 focus:ring-blue-500 outline-none text-sm font-medium bg-white"
                        >
                          <option value="">Pilih klinik fundus</option>

                          {fundusProviderClinics
                            .filter(provider => {
                              //--- Only show providers allowed by Fundus Network for the selected referring clinic ---//
                              const referringClinic = clinics.find(
                                clinic => clinic.id === formReferringClinicId
                              );

                              if (!referringClinic) return false;

                              //--- A provider clinic may route to itself ---//
                              if (referringClinic.id === provider.id && referringClinic.isFundusProvider) {
                                return true;
                              }

                              return (referringClinic.fundusProviderClinicIds || []).includes(provider.id);
                            })
                            .map(clinic => (
                              <option key={clinic.id} value={clinic.id}>
                                {clinic.name}
                              </option>
                            ))}
                        </select>
                      )}

                      <p className="text-[9px] text-slate-400 mt-1">
                        Fasiliti yang menjalankan pemeriksaan fundus untuk patient ini.
                      </p>
                    </div>

                  {/*--- Compact Visual Acuity: add only the examination types needed ---*/}
                  <div>
                    <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">
                      Visual Acuity (V/A)
                    </label>
                    <select
                      value={vaMethodToAdd}
                      onChange={e => {
                        const method = e.target.value;
                        if (method) {
                          setVisibleVAMethods(prev => prev.includes(method) ? prev : [...prev, method]);
                        }
                        setVaMethodToAdd('');
                      }}
                      className="w-full px-2.5 py-2 border border-slate-200 rounded-lg bg-white text-xs text-slate-600 outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">+ Add V/A examination</option>
                      <option value="Unaided" disabled={visibleVAMethods.includes('Unaided')}>Unaided</option>
                      <option value="With Glasses" disabled={visibleVAMethods.includes('With Glasses')}>With Glasses</option>
                      <option value="Pinhole" disabled={visibleVAMethods.includes('Pinhole')}>Pinhole</option>
                    </select>

                    {visibleVAMethods.length > 0 && (
                      <div className="mt-2 space-y-2">
                        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2 items-center">
                          <span />
                          <span className="text-[10px] sm:text-xs font-bold text-slate-500 text-center">RE (Right Eye)</span>
                          <span className="text-[10px] sm:text-xs font-bold text-slate-500 text-center">LE (Left Eye)</span>
                        </div>
                        {visibleVAMethods.map(method => {
                          const fields = method === 'Unaided'
                            ? { right: 'rightEyeVAUnaided', left: 'leftEyeVAUnaided' }
                            : method === 'With Glasses'
                              ? { right: 'rightEyeVAWithGlasses', left: 'leftEyeVAWithGlasses' }
                              : { right: 'rightEyeVAPinhole', left: 'leftEyeVAPinhole' };
                          const record = editingAppointment || existingPatient;
                          const rightValue = method === 'Unaided'
                            ? record?.rightEyeVAUnaided
                            : method === 'With Glasses'
                              ? record?.rightEyeVAWithGlasses
                              : record?.rightEyeVAPinhole;
                          const leftValue = method === 'Unaided'
                            ? record?.leftEyeVAUnaided
                            : method === 'With Glasses'
                              ? record?.leftEyeVAWithGlasses
                              : record?.leftEyeVAPinhole;
                          return (
                            <div key={method} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2 items-center">
                              <div className="flex items-center gap-1 min-w-0">
                                <span className="text-[11px] text-slate-600 leading-tight">{method}</span>
                                <button type="button" aria-label={`Remove ${method}`} onClick={() => setVisibleVAMethods(prev => prev.filter(item => item !== method))} className="ml-auto shrink-0 text-slate-400 hover:text-rose-600 text-sm leading-none">×</button>
                              </div>
                              <input aria-label={`${method} visual acuity right eye`} name={fields.right} type="text" defaultValue={rightValue ?? ''} className="min-w-0 w-full px-2 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none" />
                              <input aria-label={`${method} visual acuity left eye`} name={fields.left} type="text" defaultValue={leftValue ?? ''} className="min-w-0 w-full px-2 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none" />
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1">
                    <div>
  <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">
    Date
  </label>

  <div className="flex items-center gap-3">
    <input
      name="date"
      required
      type="date"
      value={selectedDate}
      onChange={(e) => {
        const value = e.target.value;
        setSelectedDate(value);
      }}
      className="w-[220px] px-4 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
    />

    {(() => {
      const referringClinic = clinics.find(
        clinic => clinic.id === formReferringClinicId
      );
      const providerClinic = clinics.find(
        clinic => clinic.id === formFundusProviderClinicId
      );
      const tcaDays =
        referringClinic &&
        providerClinic &&
        referringClinic.id !== providerClinic.id
          ? providerClinic.referralTcaDays?.[referringClinic.id] || []
          : [];

      if (tcaDays.length === 0) return null;

      const dayLabels: Record<number, string> = {
        0: 'Sunday',
        1: 'Monday',
        2: 'Tuesday',
        3: 'Wednesday',
        4: 'Thursday',
        5: 'Friday',
        6: 'Saturday',
      };

      return (
        <span className="shrink-0 text-[10px] font-black text-blue-600 whitespace-nowrap">
          TCA: {tcaDays.map(day => dayLabels[day]).filter(Boolean).join(', ')} only
        </span>
      );
    })()}
  </div>

  {false && selectedDate && (() => {

  const selectedDateObj = new Date(selectedDate);

  const isFriday = selectedDateObj.getDay() === 5;

  const remainingSlots =
    PBOA_LIMIT -
    appointments.filter(
      app =>
        app.department === 'PBOA' &&
        app.date === selectedDate
    ).length;

  return isFriday ? (

    <p className="text-[10px] font-bold text-emerald-600">
      Remaining Slots: {remainingSlots} / {PBOA_LIMIT}
    </p>

  ) : (

    <p className="text-[10px] font-bold text-rose-600">
      No Slot Available for PBOA on this date.
    </p>

  );

})()}
</div>
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Remarks</label>
                    <textarea 
                      name="remarks"
                      rows={2}
                      defaultValue={editingAppointment?.remarks || ''}
                      className="w-full px-4 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none resize-none uppercase"
                      placeholder="Special instructions or notes..."
                    />
                  </div>
                </div>

                <div className="flex gap-3 pt-4">
                  <button 
                    type="button"
                    onClick={() => !isSavingAppointment && closeForm()}
                    disabled={isSavingAppointment}
                    className="flex-1 px-4 py-2 border border-slate-200 text-slate-600 rounded-lg font-semibold hover:bg-slate-50 transition-colors"
                  >
                    Cancel
                  </button>
                  <button 
                    type="submit"
                    disabled={isSavingAppointment}
                    className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 transition-colors shadow-lg"
                  >
                    {isSavingAppointment ? 'Saving...' : editingAppointment ? 'Save Changes' : 'Confirm Appointment'}
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Delete Confirmation Modal */}
      <AnimatePresence>
        {deletingApp && (
          <div className="fixed inset-0 z-[200] flex items-start sm:items-center justify-center p-2 sm:p-4 overflow-y-auto overscroll-contain">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => !isDeletingAppointment && setDeletingApp(null)}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden relative z-10 p-6 text-center"
            >
              <div className="flex justify-center mb-4">
                <div className="w-12 h-12 bg-rose-100 rounded-full flex items-center justify-center text-rose-600">
                  <Trash2 size={24} />
                </div>
              </div>
              <h3 className="text-lg font-bold text-slate-800 mb-2">Delete Appointment</h3>
              <p className="text-sm text-slate-500 mb-6">
                Are you sure you want to permanently delete the record for <span className="font-bold text-slate-700">{deletingApp?.patientName}</span>? This action cannot be undone.
              </p>
              <div className="flex gap-3">
                <button 
                  onClick={() => !isDeletingAppointment && setDeletingApp(null)}
                  disabled={isDeletingAppointment}
                  className="flex-1 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl transition-colors"
                >
                  Cancel
                </button>
                <button 
                  onClick={() => deletingApp && deleteAppointment(deletingApp.id)}
                  disabled={isDeletingAppointment}
                  className="flex-1 py-2.5 bg-rose-600 disabled:opacity-60 disabled:cursor-not-allowed hover:bg-rose-700 text-white font-bold rounded-xl transition-all shadow-lg shadow-rose-100 active:scale-95"
                >
                  {isDeletingAppointment ? 'Deleting...' : 'Delete Now'}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Image Review Modal */}
      <AnimatePresence>
      {/* Image Not Obtainable Modal */}
<AnimatePresence>
  {showImageNotObtainable && selectedUnableApp && (
    <div className="fixed inset-0 z-[120] flex items-start sm:items-center justify-center p-2 sm:p-4 overflow-y-auto overscroll-contain">

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={() => !isSavingImageStatus && setShowImageNotObtainable(false)}
        className="absolute inset-0 bg-slate-900/80 backdrop-blur-md"
      />

      <motion.div
        initial={{ opacity: 0, scale: 0.9, y: 30 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.9, y: 30 }}
        transition={{ duration: 0.2 }}
        className="relative z-10 w-full max-w-xl max-h-[calc(100dvh-1rem)] sm:max-h-[calc(100dvh-2rem)] overflow-hidden rounded-3xl bg-white shadow-2xl flex flex-col"
      >

        {/* Header */}
        <div className="bg-gradient-to-r from-amber-500 to-orange-500 px-6 py-5 text-white">

          <div className="flex items-center gap-3">

            <div className="w-12 h-12 rounded-2xl bg-white/20 flex items-center justify-center">

              <CameraOff size={24} />

            </div>

            <div>

              <h2 className="text-xl font-black">
                Image Not Obtainable
              </h2>

              <p className="text-sm text-white/90">
                Record image capture status
              </p>

            </div>

          </div>

        </div>

        {/* Body */}
<div className="flex-1 overflow-y-auto p-5">

  {/* Patient */}
  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
      Patient
    </p>

    <p className="mt-1 text-base font-black text-slate-800">
      {selectedUnableApp.patientName}
    </p>

    <p className="text-xs text-slate-500">
      {selectedUnableApp.icNumber}
    </p>
  </div>

  {/* Eye Selection */}
  <div className="mt-6">

    <p className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-3">
      Affected Eye
    </p>

    <div className="grid grid-cols-3 gap-3">

      {/* Right */}
      <button
        onClick={() => setUnableEye("right")}
        className={`rounded-2xl border py-2 px-1 transition-all ${
          unableEye === "right"
            ? "border-amber-500 bg-amber-50 shadow-md"
            : "border-slate-200 hover:border-amber-300 hover:bg-amber-50/40"
        }`}
      >
        <div className="flex flex-col items-center">

          <Eye
            size={18}
            className={
              unableEye === "right"
                ? "text-amber-600"
                : "text-slate-400"
            }
          />

          <p className="mt-1 text-xs font-black">
            Right
          </p>

          <p className="text-[10px] text-slate-400">
            RE
          </p>

        </div>
      </button>

      {/* Left */}
      <button
        onClick={() => setUnableEye("left")}
        className={`rounded-2xl border py-3 px-2 transition-all ${
          unableEye === "left"
            ? "border-amber-500 bg-amber-50 shadow-md"
            : "border-slate-200 hover:border-amber-300 hover:bg-amber-50/40"
        }`}
      >
        <div className="flex flex-col items-center">

          <Eye
            size={18}
            className={
              unableEye === "left"
                ? "text-amber-600"
                : "text-slate-400"
            }
          />

          <p className="mt-1 text-xs font-black">
            Left
          </p>

          <p className="text-[10px] text-slate-400">
            LE
          </p>

        </div>
      </button>

      {/* Both */}
      <button
        onClick={() => setUnableEye("both")}
        className={`rounded-2xl border py-3 px-2 transition-all ${
          unableEye === "both"
            ? "border-amber-500 bg-amber-50 shadow-md"
            : "border-slate-200 hover:border-amber-300 hover:bg-amber-50/40"
        }`}
      >
        <div className="flex flex-col items-center">

          <ScanEye
            size={18}
            className={
              unableEye === "both"
                ? "text-amber-600"
                : "text-slate-400"
            }
          />

          <p className="mt-1 text-xs font-black">
            Both
          </p>

          <p className="text-[10px] text-slate-400">
            RE + LE
          </p>

        </div>
      </button>

    </div>

  </div>

  {/* Reason */}
  <div className="mt-6">

    <p className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-3">
      Reason
    </p>

    <div className="grid grid-cols-2 md:grid-cols-3 gap-2">

      {[
        "Dense Cataract",
        "Small Pupil",
        "Corneal Opacity",
        "Vitreous Haemorrhage",
        "Poor Fixation",
        "Patient Uncooperative",
        "Patient Refused",
        "Equipment Issue",
        "Others"
      ].map((reason) => (

        <button
          key={reason}
          onClick={() => setUnableReason(reason)}
          className={`rounded-xl border px-3 py-2 text-left transition-all ${
            unableReason === reason
              ? "border-amber-500 bg-amber-50 shadow-sm"
              : "border-slate-200 hover:border-amber-300 hover:bg-amber-50/40"
          }`}
        >

          <div className="flex items-center justify-between">

            <span
              className={`text-xs font-bold ${
                unableReason === reason
                  ? "text-amber-700"
                  : "text-slate-700"
              }`}
            >
              {reason}
            </span>

            {unableReason === reason && (
              <CheckCircle2
                size={16}
                className="text-amber-600"
              />
            )}

          </div>

        </button>

      ))}

    </div>

    {unableReason === "Others" && (

      <div className="mt-4">

        <p className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2">
          Additional Notes
        </p>

        <textarea
          value={unableOtherReason}
          onChange={(e) => setUnableOtherReason(e.target.value)}
          rows={3}
          className="w-full rounded-xl border border-slate-200 px-3 py-2 outline-none resize-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100"
          placeholder="Please specify..."
        />

      </div>

    )}

  </div>

</div>

        {/* Footer */}
        <div className="sticky bottom-0 bg-white border-t border-slate-200 p-4 flex gap-3">

          <button
            disabled={isSavingImageStatus}
            onClick={() => !isSavingImageStatus && setShowImageNotObtainable(false)}
            className="flex-1 rounded-xl border border-slate-200 bg-white py-2.5 font-bold text-slate-600 transition hover:bg-slate-50"
          >
            Cancel
          </button>

          <button
  onClick={saveImageNotObtainable}
  disabled={isSavingImageStatus || (unableReason === "Others" && !unableOtherReason.trim())}
  className="flex-1 rounded-xl bg-amber-500 hover:bg-amber-600 py-2.5 font-bold text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed"
>
  {isSavingImageStatus ? 'Saving...' : 'Save Status'}
</button>

        </div>

      </motion.div>

    </div>
  )}
</AnimatePresence>
        {selectedPhotoApp && (
          <div className="fixed inset-0 z-[110] flex items-start sm:items-center justify-center p-2 sm:p-4 overflow-y-auto overscroll-contain">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => {

    setRightEyeAIResult(null);

    setLeftEyeAIResult(null);

    setSelectedPhotoApp(null);

}}
              className="absolute inset-0 bg-slate-900/80 backdrop-blur-md"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 30 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 30 }}
              className="bg-white rounded-3xl shadow-2xl w-full max-w-6xl h-[calc(100dvh-1rem)] sm:h-[calc(100dvh-2rem)] overflow-hidden scroll-smooth relative z-10"
            >
              <div className="h-full min-h-0 overflow-hidden flex flex-col lg:flex-row">

              {/*--- Fundus Review close button: fixed to the mobile review box top-right ---*/}
              <button
                type="button"
                onClick={() => {
                  setRightEyeAIResult(null);
                  setLeftEyeAIResult(null);
                  setSelectedPhotoApp(null);
                }}
                className="absolute top-3 right-3 z-40 px-3 py-2 rounded-xl bg-slate-100 text-xs font-bold hover:bg-slate-200"
                aria-label="Close Fundus Review"
              >
                Close
              </button>

{/* Photo Area Bahagian Review Form*/}
<div className="h-[320px] shrink-0 lg:flex-1 lg:h-auto lg:min-h-0 bg-black flex flex-col overflow-hidden relative" onWheel={handleWheel} ref={containerRef}>
<div className="flex-1 flex items-center justify-center p-2 md:p-4 overflow-y-auto lg:overflow-hidden relative">

{/* 🤖 AI PANEL — desktop keeps the full header; mobile collapses to a small side arrow so the fundus image stays clear. */}
<div
  className={`absolute z-30 top-2 left-2 right-auto sm:top-5 sm:right-auto sm:left-1/2 sm:-translate-y-0 sm:-translate-x-1/2 ${
    isAIPanelOpen
      ? 'w-[210px] sm:w-[330px]'
      : 'w-10 sm:w-[330px]'
  }`}
>

  <motion.div
    initial={false}
    animate={{
      height: isAIPanelOpen ? "auto" : 44,
    }}
    transition={{
      duration: 0.25,
      ease: "easeInOut",
    }}
    className="overflow-hidden rounded-xl sm:rounded-2xl border border-slate-700 bg-slate-900/90 backdrop-blur-md shadow-2xl"
  >

    {/* AI HEADER / COLLAPSE BUTTON */}
    <button
      type="button"
      onClick={() =>
        setIsAIPanelOpen(prev => !prev)
      }
      className="w-full h-9 sm:h-11 px-0 sm:px-4 flex items-center justify-center sm:justify-between hover:bg-white/5 transition-all"
    >

      <div className="flex-1 text-center hidden sm:block">

        <p className="text-[9px] uppercase tracking-[0.3em] text-slate-400 font-bold">
          AI ASSISTED REVIEW
        </p>

        {isAIPanelOpen && (
          <p className="mt-0.5 text-[8px] text-slate-500">
            Powered by OpenEye-FM
          </p>
        )}

      </div>

      <span className="text-slate-300 flex items-center justify-center">
        <span className="hidden sm:inline text-xs">
          {isAIPanelOpen ? "▲" : "▼"}
        </span>
        <span className="sm:hidden">
          {isAIPanelOpen ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </span>
      </span>

    </button>


    {/* AI PANEL CONTENT */}
    <AnimatePresence initial={false}>

      {isAIPanelOpen && (

        <motion.div
          initial={{
            opacity: 0,
            height: 0,
          }}
          animate={{
            opacity: 1,
            height: "auto",
          }}
          exit={{
            opacity: 0,
            height: 0,
          }}
          transition={{
            duration: 0.2,
          }}
          className="px-3 pb-3 sm:px-4 sm:pb-4"
        >

          {/* ANALYZE BUTTON */}
          <button
            onClick={analyzeWithAI}
            disabled={isAnalyzing}
            className="w-full rounded-lg bg-indigo-600 hover:bg-indigo-700 py-1.5 sm:py-2.5 text-xs sm:text-base text-white font-bold transition-all disabled:opacity-60"
          >

            {isAnalyzing
              ? "Analyzing..."
              : currentAIResult
                ? "Re-analyze"
                : "Coming Soon: Analyze with AI"}

          </button>


          {/* SELECTED EYE */}
          <div className="mt-2 sm:mt-3 flex justify-center">

            <span className="text-[8px] sm:text-[10px] font-bold text-blue-300">

              {selectedPhotoApp?.eye === "right"
                ? "RIGHT EYE (RE)"
                : "LEFT EYE (LE)"}

            </span>

          </div>


          {/* AI RESULT */}
          {currentAIResult && (

            showAIResult ? (

              <>
                <div className="mt-4 border-t border-white/10 pt-4">

                  <p className="text-[10px] uppercase tracking-[0.25em] text-slate-500">
                    AI SUGGESTIONS
                  </p>

                  <div className="mt-3 space-y-2">

                    {currentAIResult.predictions.map(
                      (prediction: any, index: number) => (

                        <div
                          key={`${prediction.label}-${index}`}
                          className="rounded-lg border border-slate-700 bg-slate-800/50 overflow-hidden"
                        >

                          <button
                            type="button"
                            onClick={() =>
                              setExpandedPrediction(
                                expandedPrediction === index
                                  ? null
                                  : index
                              )
                            }
                            className="w-full p-3 flex items-center justify-between hover:bg-white/5 transition-all"
                          >

                            <div>

                              <p
                                className={`font-bold ${getPredictionColor(
                                  prediction.label
                                )}`}
                              >
                                {prediction.label}
                              </p>

                              <p className="text-xs text-slate-400">
                                {prediction.confidence}%
                              </p>

                            </div>

                          </button>


                          {expandedPrediction === index && (

                            <div className="px-3 pb-3 border-t border-white/10">

                              <p className="mt-3 text-xs text-slate-400 uppercase tracking-widest">
                                Description
                              </p>

                              <p className="mt-2 text-sm text-slate-300 leading-6">
                                {prediction.description}
                              </p>

                              <button
                                type="button"
                                onClick={() =>
                                  applyAISuggestion(prediction)
                                }
                                className="mt-4 w-full rounded-xl bg-emerald-600 hover:bg-emerald-700 py-2 text-white font-bold transition-all"
                              >
                                Apply AI Suggestion
                              </button>

                            </div>

                          )}

                        </div>

                      )
                    )}

                  </div>

                </div>


                {/* HIDE RESULT */}
                <button
                  type="button"
                  onClick={() =>
                    setShowAIResult(false)
                  }
                  className="mt-2 w-full rounded-xl border border-slate-700 py-2 text-sm text-slate-300 hover:bg-slate-800 transition-all"
                >
                  ▲ Hide Result
                </button>

              </>

            ) : (

              /* SHOW RESULT */
              <button
                type="button"
                onClick={() =>
                  setShowAIResult(true)
                }
                className="mt-4 w-full rounded-xl border border-indigo-500 py-2 text-sm text-indigo-300 hover:bg-indigo-600/10 transition-all"
              >
                ▼ Show Result
              </button>

            )

          )}

        </motion.div>

      )}

    </AnimatePresence>

  </motion.div>

</div>

{isAnalyzing && (
  <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/40 backdrop-blur-sm">

    <div className="flex flex-col items-center">

      <div className="h-12 w-12 rounded-full border-4 border-white/20 border-t-white animate-spin"></div>

      <p className="mt-4 text-white font-semibold">
        Analyzing Fundus Image...
      </p>

      <p className="text-sm text-slate-300">
        Please wait...
      </p>

    </div>

  </div>
)}
  
                   {(
  selectedPhotoApp?.eye === "right"
    ? selectedPhotoApp?.app?.rightEyePhoto
    : selectedPhotoApp?.app?.leftEyePhoto
) ? (

  <motion.img
    key={`${selectedPhotoApp?.app?.id}-${selectedPhotoApp?.eye}`}
    drag={zoomScale > 1}
    dragMomentum={false}
    animate={{
      scale: zoomScale,
      x: zoomScale <= 1 ? 0 : undefined,
      y: zoomScale <= 1 ? 0 : undefined,
      cursor: zoomScale > 1 ? "grab" : "zoom-in",
    }}
    transition={{
      type: "spring",
      stiffness: 400,
      damping: 40,
    }}
    src={
      selectedPhotoApp?.eye === "right"
        ? selectedPhotoApp?.app?.rightEyePhoto
        : selectedPhotoApp?.app?.leftEyePhoto
    }
    className="form-fundus-image max-w-full max-h-full object-contain shadow-2xl rounded-lg select-none touch-none"
    onTouchStart={handlePinchStart}
    onTouchMove={handlePinchMove}
    onTouchEnd={handlePinchEnd}
    alt="Fundus View"
  />

) : (

  <div className="flex flex-col items-center justify-center text-center">

    <CircleOff
      size={56}
      className="text-amber-500 mb-4 md:mb-6 md:w-20 md:h-20"
    />

    <h2 className="text-2xl md:text-3xl font-black text-white">
      Image Not Obtainable
    </h2>

    <p className="mt-2 text-sm md:text-base text-slate-300">
      No fundus image available.
    </p>

    <div className="mt-5 md:mt-8 rounded-2xl border border-amber-300 bg-amber-500/10 px-6 py-4 md:px-8 md:py-5">

      <p className="text-xs font-black uppercase tracking-widest text-amber-300">
        Reason
      </p>

      <p className="mt-2 text-lg md:text-xl font-bold text-white">
        {
          selectedPhotoApp?.eye === "right"
            ? selectedPhotoApp?.app?.rightEyeImageReason
            : selectedPhotoApp?.app?.leftEyeImageReason
        }
      </p>

    </div>

  </div>

)}
                </div>
                
                {/* Zoom Indicator */}
                {zoomScale > 1 && (
                  <div className="absolute top-4 left-4 bg-black/60 backdrop-blur-md px-3 py-1.5 rounded-full text-[10px] font-bold text-white border border-white/20 z-20">
                    Zoom: {zoomScale.toFixed(1)}x • Scroll to zoom • Drag to pan
                  </div>
                )}
{/* Fundus Image Upload By FORM */}
<div className="hidden md:flex absolute bottom-20 left-1/2 -translate-x-1/2 z-20 bg-black/70 backdrop-blur-md px-3 md:px-8 py-2 rounded-2xl border border-white/10 flex items-center gap-3 md:gap-6">

  <p className="text-[9px] font-black uppercase tracking-widest text-slate-300">
    Fundus Image Uploaded By:
  </p>

  <p className="text-[9px] md:text-[11px] font-bold text-white uppercase">
    {
      getUserDisplayName(
        selectedPhotoApp?.eye === 'right'
          ? selectedPhotoApp?.app?.rightEyeUploadedBy
          : selectedPhotoApp?.app?.leftEyeUploadedBy
      )
    }
  </p>

  <div className="w-px h-4 bg-white/20"></div>

  <p className="text-[10px] text-slate-200 font-bold">
    {new Date(selectedPhotoApp?.app?.createdAt).toLocaleString('en-GB')}
  </p>

</div>
                {/* Thumbnails to switch between RE/LE */}
                <div className="bg-slate-900/50 p-4 border-t border-white/10 flex justify-center gap-4">
                  {['right', 'left'].map(side => (
                    <button 
                      key={side}
                      disabled={
!(
side === "right"
  ? (
      selectedPhotoApp?.app?.rightEyePhoto ||
      selectedPhotoApp?.app?.rightEyeImageStatus === "Not Obtainable"
    )
  : (
      selectedPhotoApp?.app?.leftEyePhoto ||
      selectedPhotoApp?.app?.leftEyeImageStatus === "Not Obtainable"
    )
)
}
                      onClick={() => setSelectedPhotoApp(prev => prev ? ({ ...prev, eye: side as any }) : null)}
                      className={`px-4 py-2 rounded-xl font-bold text-xs transition-all ${
                        selectedPhotoApp?.eye === side 
                          ? 'bg-blue-600 text-white ring-4 ring-blue-500/30' 
                          : 'bg-white/10 text-white hover:bg-white/20'
                      } disabled:opacity-30`}
                    >
                      {side === 'right' ? 'RIGHT EYE (RE)' : 'LEFT EYE (LE)'}
                    </button>
                  ))}
                </div>
              </div>
              
              {/* Sidebar Info & Review */}
              <div className="w-full md:w-96 flex flex-col p-4 sm:p-8 border border-slate-200 rounded-2xl bg-slate-50 h-full min-h-0 overflow-hidden flex-1 lg:flex-none" key={selectedPhotoApp?.app?.id}>
                {/* Desktop review panel: header/history stay fixed; only the review content scrolls.
                    Mobile layout/behaviour is intentionally unchanged. */}
                <div className="flex-1 min-h-0 overflow-y-auto lg:flex lg:flex-col lg:overflow-hidden pr-1">
                <div className="flex justify-between items-start mb-6">
                  <div>
                    <h2 className="text-base sm:text-lg lg:text-2xl font-bold text-slate-800 tracking-tight">
  {selectedPhotoApp?.app?.patientName}
</h2>
                    <p className="text-sm text-slate-500 uppercase mt-1">IC: {selectedPhotoApp?.app?.icNumber}</p>
                    
                  </div>

                </div>

                <div className="flex flex-col min-h-0">
                  <div className="p-3 bg-white rounded-xl border border-slate-200 mb-6 shrink-0">
                    <span className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Patient History</span>
                    <div className="flex flex-wrap gap-1">
                      {selectedPhotoApp?.app?.diseaseTypes?.map(d => (
                        <span key={d} className="px-2 py-1 bg-red-100 text-red-700 text-[10px] font-bold rounded uppercase">{d}</span>
                      ))}
                      {selectedPhotoApp?.app?.otherDisease && (
                        <span className="px-2 py-1 bg-slate-200 text-slate-700 text-[10px] font-bold rounded uppercase">{selectedPhotoApp?.app?.otherDisease}</span>
                      )}
                    </div>
                    {String(selectedPhotoApp?.app?.remarks || '').trim() && (
                      <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
                        <p className="text-[10px] font-black uppercase tracking-widest text-amber-800">Remarks</p>
                        <p className="mt-1 text-xs leading-relaxed text-slate-700 whitespace-pre-wrap break-words">{selectedPhotoApp?.app?.remarks}</p>
                      </div>
                    )}
                  </div>

                  {renderVisualAcuity(selectedPhotoApp?.app)}

                  <form 
                    className="flex flex-col flex-1 min-h-0"
                    onSubmit={(e) => {
                      e.preventDefault();
                      // Generate summary text from details
                      const generateSummary = (details: Appointment['rightEyeReviewDetails']) => {
                        if (!details || !details.status) return '';
                        let summary = details.status === 'Normal' ? 'NORMAL' : details.status === 'Ungradable' ? 'UNGRADABLE' : 'ABNORMAL';
                        
                        if (details.status === 'Abnormal') {
                          if (details.abnormalTypes && details.abnormalTypes.length > 0) {
                            summary += ': ' + details.abnormalTypes.join(', ');
                            if (details.abnormalTypes.includes('NPDR') && details.npdrSeverity) {
                              summary += ` (${details.npdrSeverity.toUpperCase()})`;
                            }
                          }
                          if (details.othersText) {
                            summary += ` - ${details.othersText}`;
                          }
                        }

                        if (details.comment) {
                          summary += ` | COMMENT: ${details.comment}`;
                        }
                        
                        return summary.toUpperCase();
                      };

                      const rightVal = generateSummary(rightEyeDetails);
                      const leftVal = generateSummary(leftEyeDetails);
                      if (selectedPhotoApp?.app?.id) {
                        saveReview(selectedPhotoApp.app.id, rightVal, leftVal, rightEyeDetails, leftEyeDetails);
                      }
                    }}
                  >
                    <div className="space-y-6 pr-2 summary-scrollbar lg:flex-1 lg:min-h-0 lg:overflow-y-auto">
                      {/* Eye Selection Tabs — desktop only.
                          Mobile already has the RE/LE controls below the fundus image. */}
                      <div className="hidden lg:flex gap-2 p-1 bg-slate-200 rounded-2xl sticky top-0 z-20">
                        {(['right', 'left'] as const).map(eye => (
                          <button
                            key={eye}
                            type="button"
                            onClick={() => setSelectedPhotoApp(prev => prev ? { ...prev, eye } : null)}
                            className={`flex-1 py-3 px-4 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${
                              selectedPhotoApp?.eye === eye 
                                ? 'bg-white text-slate-900 shadow-sm' 
                                : 'text-slate-500 hover:text-slate-700'
                            }`}
                          >
                            {eye === 'right' ? 'Right Eye (RE)' : 'Left Eye (LE)'}
                          </button>
                        ))}
                      </div>

                      {['right', 'left'].map(eye => {
                        const isSelected = selectedPhotoApp?.eye === eye;
                        const details = eye === 'right' ? rightEyeDetails : leftEyeDetails;
                        const setDetails = eye === 'right' ? setRightEyeDetails : setLeftEyeDetails;
                        const isNotObtainable =
  eye === "right"
    ? selectedPhotoApp?.app?.rightEyeImageStatus === "Not Obtainable"
    : selectedPhotoApp?.app?.leftEyeImageStatus === "Not Obtainable";

const imageReason =
  eye === "right"
    ? selectedPhotoApp?.app?.rightEyeImageReason
    : selectedPhotoApp?.app?.leftEyeImageReason;
                        
                        return (
                          <div key={eye} className={isSelected ? 'block space-y-4' : 'hidden'}>
                            <div className="flex items-center gap-2 mb-2">
                              <span className={`w-2.5 h-2.5 rounded-full ${eye === 'right' ? 'bg-blue-600' : 'bg-emerald-600'}`}></span>
                              <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest">
                                {eye === 'right' ? 'Right Eye Review (RE)' : 'Left Eye Review (LE)'}
                              </label>
                            </div>
                            
                            <div className="space-y-6 bg-white p-6 rounded-2xl border border-slate-200 shadow-sm min-h-0">
                              
                              {/* Findings Status / Image Status */}
                              {isNotObtainable ? (
                                <div className="space-y-3">
                                  <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest">Image Status</label>
                                  <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                                    <div className="flex items-center gap-3">
                                      <span className="inline-flex px-3 py-1.5 rounded-lg bg-amber-100 text-amber-700 text-xs font-black uppercase">
                                        Not Obtainable
                                      </span>
                                      <span className="text-xs font-bold text-slate-600 uppercase">
                                        {imageReason || 'Reason not specified'}
                                      </span>
                                    </div>
                                  </div>
                                </div>
                              ) : (
                                <div className="space-y-3">
                                  <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest">Findings Status</label>
                                  <div className="space-y-2">
                                    <div className="grid grid-cols-2 gap-3 p-1 bg-slate-100 rounded-xl">
                                      {(['Normal', 'Abnormal'] as const).map(status => (
                                        <button
                                          key={status}
                                          type="button"
                                          onClick={() => setDetails(prev => {
                                            const current = prev || {
                                              status: '',
                                              abnormalTypes: [],
                                              npdrSeverity: '',
                                              othersText: '',
                                              comment: ''
                                            };
                                            // Tap the selected status again to return to the initial, unselected state.
                                            if (current.status === status) {
                                              return { ...current, status: '', abnormalTypes: [], npdrSeverity: '', othersText: '' };
                                            }
                                            // A Normal result must not retain any previous abnormal findings.
                                            if (status === 'Normal') {
                                              return { ...current, status, abnormalTypes: [], npdrSeverity: '', othersText: '' };
                                            }
                                            return { ...current, status, abnormalTypes: [], npdrSeverity: '', othersText: '' };
                                          })}
                                          className={`py-2 px-4 rounded-lg text-xs font-bold transition-all ${
                                            details?.status === status
                                              ? (status === 'Normal' ? 'bg-emerald-600 text-white shadow-md' : 'bg-rose-600 text-white shadow-md')
                                              : 'text-slate-500 hover:bg-slate-200'
                                          }`}
                                        >
                                          {status}
                                        </button>
                                      ))}
                                    </div>
                                    {(!details?.status || details.status === 'Ungradable') && (
                                      <button
                                        type="button"
                                        onClick={() => setDetails(prev => {
                                          const current = prev || {
                                            status: '',
                                            abnormalTypes: [],
                                            npdrSeverity: '',
                                            othersText: '',
                                            comment: ''
                                          };
                                          if (current.status === 'Ungradable') {
                                            return { ...current, status: '' };
                                          }
                                          return { ...current, status: 'Ungradable', abnormalTypes: [], npdrSeverity: '', othersText: '' };
                                        })}
                                        className={`w-full py-2 px-4 rounded-lg text-xs font-bold transition-all ${
                                          details?.status === 'Ungradable'
                                            ? 'bg-amber-500 text-white shadow-md'
                                            : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                                        }`}
                                      >
                                        Ungradable
                                      </button>
                                    )}
                                  </div>
                                </div>
                              )}

                              {/* Abnormal Options */}
                              {details?.status === 'Abnormal' && (
                                <motion.div 
                                  initial={{ opacity: 0 }}
                                  animate={{ opacity: 1 }}
                                  className="space-y-4 pt-2"
                                >
                                  <div className="grid grid-cols-1 gap-3">
                                    {(['NPDR', 'PDR', 'Maculopathy', 'ADED', 'Others'] as const).map(type => (
                                      <div key={type} className="space-y-2">
                                        <label className="flex items-center gap-3 p-3 rounded-xl border border-slate-100 hover:bg-slate-50 cursor-pointer transition-colors group">
                                          <input
                                            type="checkbox"
                                            checked={!!details?.abnormalTypes?.includes(type)}
                                            onChange={(e) => {
                                              const current = details?.abnormalTypes || [];
                                              const updated = e.target.checked 
                                                ? [...current, type]
                                                : current.filter(t => t !== type);
                                              setDetails(prev => ({ ...(prev || {
                                                status: '',
                                                abnormalTypes: [],
                                                npdrSeverity: '',
                                                othersText: '',
                                                comment: ''
                                              }), abnormalTypes: updated }));
                                            }}
                                            className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                                          />
                                          <span className="text-xs sm:text-sm font-bold text-slate-700">{type}</span>
                                        </label>

                                        {/* NPDR Severity */}
                                        {type === 'NPDR' && details?.abnormalTypes?.includes('NPDR') && (
                                          <div className="ml-8 pr-1">
                                            <div className="grid grid-cols-3 gap-2 bg-slate-50 p-2 rounded-xl border border-slate-100">
                                              {(['mild', 'moderate', 'severe'] as const).map(sev => (
                                                <button
                                                  key={sev}
                                                  type="button"
                                                  onClick={() => setDetails(prev => ({ ...(prev || {
                                                    status: '',
                                                    abnormalTypes: [],
                                                    npdrSeverity: '',
                                                    othersText: '',
                                                    comment: ''
                                                  }), npdrSeverity: sev }))}
                                                  className={`w-full py-1.5 px-1 rounded-lg text-[9px] font-bold transition-all ${
                                                    details?.npdrSeverity === sev
                                                      ? 'bg-blue-600 text-white shadow-sm'
                                                      : 'bg-white border border-slate-200 text-slate-400 hover:border-slate-300 hover:bg-slate-100 hover:text-slate-600'
                                                  }`}
                                                >
                                                  {sev.toUpperCase()}
                                                </button>
                                              ))}
                                            </div>
                                          </div>
                                        )}

                                        {/* Others Box */}
                                        {type === 'Others' && details?.abnormalTypes?.includes('Others') && (
                                          <div className="ml-8 pr-1 animate-in fade-in slide-in-from-top-1">
                                            <textarea
                                              placeholder="Specify other findings..."
                                              value={details?.othersText || ''}
                                              onChange={(e) => setDetails(prev => ({ ...(prev || {
                                                status: '',
                                                abnormalTypes: [],
                                                npdrSeverity: '',
                                                othersText: '',
                                                comment: ''
                                              }), othersText: e.target.value }))}
                                              className="w-full p-3 text-xs bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-blue-500 min-h-[60px] resize-none uppercase"
                                            />
                                          </div>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                </motion.div>
                              )}

                              {/* Comment Box */}
                              <div className="pt-4 border-t border-slate-100 space-y-2">
                                <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest">Clinical Notes / Comments</label>
                                <textarea
                                  placeholder="Type any additional clinical notes here..."
                                  value={details?.comment || ''}
                                  onChange={(e) => setDetails(prev => ({ ...(prev || {
                                    status: '',
                                    abnormalTypes: [],
                                    npdrSeverity: '',
                                    othersText: '',
                                    comment: ''
                                  }), comment: e.target.value }))}
                                  className="w-full p-4 text-xs bg-slate-50 border border-slate-200 rounded-2xl outline-none focus:ring-2 focus:ring-blue-500 min-h-[120px] resize-y uppercase shadow-inner"
                                />
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    

                    {patientHistory.length > 0 && (
  <div className="mt-6 border-t border-slate-100 pt-4">

    <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">
      Patient History
    </h3>

    <div className="space-y-2 max-h-40 overflow-y-auto pr-1">

      {patientHistory.map(history => (

        <div
          key={history.id}
          className="bg-slate-50 border border-slate-100 rounded-xl p-3 flex items-center justify-between"
        >

          <div className="flex flex-col">

            <span className="text-xs font-bold text-slate-700">
              {new Date(history.date).toLocaleDateString('en-GB')}
            </span>

            <span className="text-[9px] text-slate-400 uppercase font-bold tracking-wider">
              {history.status}
            </span>

          </div>

          <button
  type="button"
  onClick={() => {

  setTimeout(() => {

    setSelectedHistory(history);

  }, 120);

}}
  className="text-[9px] font-bold text-blue-600 uppercase"
>
  View
</button>

        </div>

      ))}

    </div>

  </div>
)}
<div className="pt-4 border-t border-slate-100">
  <label className="flex items-center gap-3 p-3 rounded-xl border border-slate-200 hover:bg-slate-50 cursor-pointer transition-colors">
    <input
  type="checkbox"
  checked={isReferred}
  onChange={(e) => setIsReferred(e.target.checked)}
  className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
/>

    <div>
      <span className="text-sm font-bold text-slate-700">
        Kes Dirujuk
      </span>

      <p className="text-[10px] text-slate-400 mt-0.5">
        Tandakan jika pesakit perlu dirujuk
      </p>
    </div>
  </label>
</div>
{isReferred && (
  <div className="mt-3">
    <label className="block text-xs font-bold text-slate-600 mb-1.5">
      Catatan
    </label>

    <textarea
      value={referralComment}
      onChange={(e) => setReferralComment(e.target.value)}
      placeholder="Catatan rujukan (jika ada)"
      rows={3}
      className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
    />
  </div>
)}
</div>
                    <div className="pt-6 shrink-0">
                      <button 
  type="submit"
  disabled={isSavingReview}
  className="w-full py-4 bg-slate-900 hover:bg-black text-white font-black rounded-2xl transition-all shadow-xl active:scale-95 flex items-center justify-center gap-2 text-[11px] uppercase tracking-[0.2em]"
>
                        <CheckCircle2 size={18} />

{
  isSavingReview
    ? 'Saving...'
    : 'Save Clinical Review'
}
                      </button>
                    </div>
                  </form>
                </div>
                </div>
              </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
      <AnimatePresence
  mode="wait"
  initial={false}
>
  {selectedHistory && (
    <div className="fixed inset-0 z-[140] flex items-start sm:items-center justify-center p-2 sm:p-4 overflow-y-auto overscroll-contain">

      <motion.div
  initial={{ opacity: 0 }}
  animate={{ opacity: 1 }}
  exit={{ opacity: 0 }}
  transition={{
    duration: 0.5
  }}
        onClick={() => {
  setSelectedHistory(null);

  //--- Return to the duplicate-fundus warning after viewing previous ---//
  if (duplicatePatient) {
    setShowDuplicateWarning(true);
  }
}}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
      />

      <motion.div
  initial={{
    opacity: 0,
    scale: 0.85,
    y: 60
  }}
  animate={{
    opacity: 1,
    scale: 1,
    y: 0
  }}
  exit={{
    opacity: 0,
    scale: 0.94,
    y: 30
  }}
  transition={{
    duration: 0.65,
    ease: [0.16, 1, 0.3, 1]
  }}
        className="relative z-10 bg-white rounded-3xl shadow-2xl w-full max-w-3xl max-h-[calc(100dvh-1rem)] sm:max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain p-4 sm:p-6"
      >

        <div className="flex items-center justify-between mb-6">

          <div>
            <h2 className="text-xl font-black text-slate-800">
              Previous Visit
            </h2>

            <p className="text-xs text-slate-400 font-bold uppercase tracking-widest">
              {new Date(selectedHistory.date).toLocaleDateString('en-GB')}
            </p>
          </div>

          <button
  onClick={() => {
    setSelectedHistory(null);

    //--- Return to the duplicate-fundus warning after viewing previous ---//
    if (duplicatePatient) {
      setShowDuplicateWarning(true);
    }
  }}
            className="px-4 py-2 rounded-xl bg-slate-100 text-xs font-bold"
          >
            Close
          </button>

        </div>

        {/* Compact patient details shown before the fundus upload information */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4 rounded-2xl border border-slate-200 bg-slate-50/80 p-3">
          <div className="min-w-0">
            <p className="text-[9px] font-black uppercase tracking-wider text-slate-400">Patient Name</p>
            <p className="mt-1 truncate text-xs font-bold text-slate-700" title={selectedHistory.patientName || '-'}>
              {selectedHistory.patientName || '-'}
            </p>
          </div>
          <div className="min-w-0">
            <p className="text-[9px] font-black uppercase tracking-wider text-slate-400">IC Number</p>
            <p className="mt-1 truncate text-xs font-bold text-slate-700" title={selectedHistory.icNumber || '-'}>
              {selectedHistory.icNumber || '-'}
            </p>
          </div>
          <div className="min-w-0">
            <p className="text-[9px] font-black uppercase tracking-wider text-slate-400">Medical History</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {[...(selectedHistory.diseaseTypes || []), ...(selectedHistory.otherDisease ? [selectedHistory.otherDisease] : [])].length > 0 ? (
                [...(selectedHistory.diseaseTypes || []), ...(selectedHistory.otherDisease ? [selectedHistory.otherDisease] : [])].map((disease, index) => (
                  <span key={`${disease}-${index}`} className="rounded-md bg-rose-50 px-1.5 py-0.5 text-[9px] font-bold text-rose-600">
                    {disease}
                  </span>
                ))
              ) : (
                <span className="text-xs text-slate-500">-</span>
              )}
            </div>
          </div>
          <div className="min-w-0">
            <p className="text-[9px] font-black uppercase tracking-wider text-slate-400">Visual Acuity (V/A)</p>
            <div className="mt-1 space-y-1.5">
              <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-1.5">
                <span />
                <span className="w-10 text-center text-[8px] font-black text-slate-400">RE</span>
                <span className="w-10 text-center text-[8px] font-black text-slate-400">LE</span>
              </div>
              {[
                { label: 'Unaided', right: selectedHistory.rightEyeVAUnaided, left: selectedHistory.leftEyeVAUnaided },
                { label: 'With Glasses', right: selectedHistory.rightEyeVAWithGlasses, left: selectedHistory.leftEyeVAWithGlasses },
                { label: 'Pinhole', right: selectedHistory.rightEyeVAPinhole, left: selectedHistory.leftEyeVAPinhole },
              ].filter(row => String(row.right || '').trim() || String(row.left || '').trim()).map(row => (
                <div key={row.label} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-1.5">
                  <span className="min-w-0 text-[9px] leading-tight text-slate-600">{row.label}</span>
                  <span className="w-10 rounded-md border border-slate-100 bg-white px-1 py-1 text-center text-[9px] font-bold text-slate-700">{row.right || '-'}</span>
                  <span className="w-10 rounded-md border border-slate-100 bg-white px-1 py-1 text-center text-[9px] font-bold text-slate-700">{row.left || '-'}</span>
                </div>
              ))}
              {!selectedHistory.rightEyeVAUnaided && !selectedHistory.leftEyeVAUnaided &&
               !selectedHistory.rightEyeVAWithGlasses && !selectedHistory.leftEyeVAWithGlasses &&
               !selectedHistory.rightEyeVAPinhole && !selectedHistory.leftEyeVAPinhole && (
                <span className="text-xs text-slate-500">-</span>
              )}
            </div>
          </div>
        </div>

        {String(selectedHistory.remarks || '').trim() && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 mb-4">
            <div className="flex items-start gap-2">
              <AlertCircle size={15} className="mt-0.5 shrink-0 text-amber-700" />
              <div className="min-w-0">
                <p className="text-[10px] font-black uppercase tracking-wider text-amber-800">Remarks for This Visit</p>
                <p className="mt-1 text-xs leading-relaxed text-slate-700 whitespace-pre-wrap break-words">{selectedHistory.remarks}</p>
              </div>
            </div>
          </div>
        )}

        <div className="bg-slate-50 rounded-2xl p-4 mb-4 text-center">

  <p className="text-[9px] uppercase font-black text-slate-400 tracking-wider">
    {selectedHistory.rightEyeImageStatus === "Not Obtainable" &&
 selectedHistory.leftEyeImageStatus === "Not Obtainable"
  ? "Image Status Updated By"
  : "Fundus Image Uploaded By"}
  </p>

  <p className="text-xs font-bold text-slate-700 mt-1">
  {getUserDisplayName(

    (selectedHistory.rightEyeImageStatus === "Not Obtainable" &&
     selectedHistory.leftEyeImageStatus === "Not Obtainable")

      ? (selectedHistory.imageStatusUpdatedBy || "-")

      : (
          selectedHistory.rightEyeUploadedBy ||
          selectedHistory.leftEyeUploadedBy ||
          "-"
        )

  )}
</p>

</div>

<div className="grid grid-cols-2 gap-6 mb-6">

  {selectedHistory.rightEyePhoto ? (

  <img
    src={selectedHistory.rightEyePhoto}
    className="w-full aspect-square object-contain rounded-2xl border border-slate-200 bg-black"
  />

) : selectedHistory.rightEyeImageStatus === "Not Obtainable" ? (

  <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 flex flex-col items-center justify-center text-center">

    <CircleOff
      size={42}
      className="text-amber-500 mb-3"
    />

    <p className="text-sm font-black uppercase text-amber-700">
      Not Obtainable
    </p>

    <p className="text-xs text-slate-500 mt-2 uppercase">
      {selectedHistory.rightEyeImageReason}
    </p>

  </div>

) : null}

  {selectedHistory.leftEyePhoto ? (

  <img
    src={selectedHistory.leftEyePhoto}
    className="w-full aspect-square object-contain rounded-2xl border border-slate-200 bg-black"
  />

) : selectedHistory.leftEyeImageStatus === "Not Obtainable" ? (

  <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 flex flex-col items-center justify-center text-center">

    <CircleOff
      size={42}
      className="text-amber-500 mb-3"
    />

    <p className="text-sm font-black uppercase text-amber-700">
      Not Obtainable
    </p>

    <p className="text-xs text-slate-500 mt-2 uppercase">
      {selectedHistory.leftEyeImageReason}
    </p>

  </div>

) : null}

</div>

<div className="mt-2 mb-6 text-center border-b border-slate-200 pb-4">

  <p className="text-[9px] uppercase font-black text-slate-400 tracking-wider">
    Reviewed By
  </p>

  <p className="text-xs font-bold text-slate-700 mt-1">
    {(selectedHistory.rightEyeReview || selectedHistory.leftEyeReview ||
      selectedHistory.rightEyeReviewDetails?.status || selectedHistory.leftEyeReviewDetails?.status)
      ? getUserDisplayName(selectedHistory.updatedBy || '')
      : ''}
  </p>

</div>

        <div className="grid grid-cols-2 gap-4">

          {/* RIGHT EYE REVIEW */}
          <div className="bg-slate-50 rounded-2xl p-4">
            <h3 className="text-xs font-black uppercase text-slate-400 mb-2">
              Right Eye Review
            </h3>

            <p className="text-sm font-bold text-slate-700">
              {selectedHistory.rightEyeImageStatus === "Not Obtainable"
                ? "Not Obtainable"
                : (selectedHistory.rightEyeReviewDetails?.status || "No Review")}
            </p>

            {selectedHistory.rightEyeReviewDetails?.status?.toLowerCase() === "abnormal" || selectedHistory.rightEyeReviewDetails?.status?.toLowerCase() === "ungradable" && (
              <div className="text-xs text-slate-600 mt-2 space-y-1">
                {selectedHistory.rightEyeReviewDetails.abnormalTypes?.length > 0 && (
                  <p className="font-semibold">
                    Findings: {selectedHistory.rightEyeReviewDetails.abnormalTypes.join(", ")}
                  </p>
                )}
                {selectedHistory.rightEyeReviewDetails.npdrSeverity && (
                  <p>Severity: {selectedHistory.rightEyeReviewDetails.npdrSeverity}</p>
                )}
                {selectedHistory.rightEyeReviewDetails.othersText && (
                  <p>Others: {selectedHistory.rightEyeReviewDetails.othersText}</p>
                )}
              </div>
            )}

            <p className="text-xs text-slate-500 mt-2 whitespace-pre-wrap uppercase">
              {selectedHistory.rightEyeImageStatus === "Not Obtainable"
                ? (selectedHistory.rightEyeImageReason || "-")
                : (selectedHistory.rightEyeReviewDetails?.comment || "-")}
            </p>
          </div>

          {/* LEFT EYE REVIEW */}
          <div className="bg-slate-50 rounded-2xl p-4">
            <h3 className="text-xs font-black uppercase text-slate-400 mb-2">
              Left Eye Review
            </h3>

            <p className="text-sm font-bold text-slate-700">
              {selectedHistory.leftEyeImageStatus === "Not Obtainable"
                ? "Not Obtainable"
                : (selectedHistory.leftEyeReviewDetails?.status || "No Review")}
            </p>

            {selectedHistory.leftEyeReviewDetails?.status?.toLowerCase() === "abnormal" || selectedHistory.leftEyeReviewDetails?.status?.toLowerCase() === "ungradable" && (
              <div className="text-xs text-slate-600 mt-2 space-y-1">
                {selectedHistory.leftEyeReviewDetails.abnormalTypes?.length > 0 && (
                  <p className="font-semibold">
                    Findings: {selectedHistory.leftEyeReviewDetails.abnormalTypes.join(", ")}
                  </p>
                )}
                {selectedHistory.leftEyeReviewDetails.npdrSeverity && (
                  <p>Severity: {selectedHistory.leftEyeReviewDetails.npdrSeverity}</p>
                )}
                {selectedHistory.leftEyeReviewDetails.othersText && (
                  <p>Others: {selectedHistory.leftEyeReviewDetails.othersText}</p>
                )}
              </div>
            )}

            <p className="text-xs text-slate-500 mt-2 whitespace-pre-wrap uppercase">
              {selectedHistory.leftEyeImageStatus === "Not Obtainable"
                ? (selectedHistory.leftEyeImageReason || "-")
                : (selectedHistory.leftEyeReviewDetails?.comment || "-")}
            </p>
          </div>

        </div>

        {/*--- Other previous fundus visits ---*/}
        {selectedHistoryVisits.length > 0 && (
          <div className="mt-6 bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200">
              <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                Previous Fundus Visits
              </p>
            </div>

            <div className="p-3 space-y-2">
              {selectedHistoryVisits.map(history => (
                <button
                  key={history.id}
                  type="button"
                  onClick={() => setSelectedHistory(history)}
                  className="w-full flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 hover:bg-blue-50 hover:border-blue-200 px-4 py-3 transition-all group"
                >
                  <div className="text-left">
                    <p className="text-sm font-bold text-slate-700">
                      {new Date(history.date).toLocaleDateString("en-GB")}
                    </p>
                    <p className="text-[10px] uppercase text-slate-400 mt-0.5">
                      {history.status}
                    </p>
                  </div>

                  <Eye
                    size={17}
                    className="text-slate-400 group-hover:text-blue-600"
                  />
                </button>
              ))}
            </div>
          </div>
        )}

      </motion.div>

    </div>
  )}
  <AnimatePresence>

  {selectedReviewSummary && (

    <div className="fixed inset-0 z-[130] flex items-start lg:items-center justify-center p-2 md:p-4 overflow-y-auto overscroll-contain">

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={() => {

  setSelectedReviewSummary(null);

}}
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
      />

      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="relative z-10 bg-white rounded-3xl shadow-2xl w-full max-w-6xl h-[calc(100dvh-1rem)] sm:h-[calc(100dvh-2rem)] overflow-hidden flex flex-col lg:flex-row"
      >

        <div className="flex flex-col lg:flex-row w-full h-full min-h-0">

  {/* Summary LEFT IMAGE SECTION */}
<div
  className="w-full min-h-[320px] lg:min-h-0 bg-black flex flex-col overflow-hidden relative"
  onWheel={handleWheel}
  ref={containerRef}
>

  {/* Photo Area */}
              <div className="flex-1 min-h-[320px] lg:min-h-0 bg-black flex flex-col overflow-hidden relative" onWheel={handleWheel} ref={containerRef}>
                <div className="flex-1 flex items-center justify-center p-2 md:p-4 overflow-y-auto lg:overflow-hidden relative">
                   {(
  summaryEye === "right"
    ? selectedReviewSummary.rightEyePhoto
    : selectedReviewSummary.leftEyePhoto
) ? (

  <motion.img
    key={`${selectedReviewSummary.id}-${summaryEye}`}
    drag={zoomScale > 1}
    dragMomentum={false}
    animate={{
      scale: zoomScale,
      x: zoomScale <= 1 ? 0 : undefined,
      y: zoomScale <= 1 ? 0 : undefined,
      cursor: zoomScale > 1 ? "grab" : "zoom-in",
    }}
    transition={{
      type: "spring",
      stiffness: 400,
      damping: 40,
    }}
    src={
      summaryEye === "right"
        ? selectedReviewSummary.rightEyePhoto
        : selectedReviewSummary.leftEyePhoto
    }
    className="summary-fundus-image max-w-full max-h-full object-contain shadow-2xl rounded-lg select-none touch-none"
    onTouchStart={handlePinchStart}
    onTouchMove={handlePinchMove}
    onTouchEnd={handlePinchEnd}
    alt="Fundus View"
  />

) : (

  <div className="flex flex-col items-center justify-center text-center">

    <CircleOff
      size={80}
      className="text-amber-500 mb-6"
    />

    <h2 className="text-3xl font-black text-white">
      Image Not Obtainable
    </h2>

    <p className="mt-2 text-slate-300">
      No fundus image available.
    </p>

    <div className="mt-8 rounded-2xl border border-amber-300 bg-amber-500/10 px-8 py-5">

      <p className="text-xs font-black uppercase tracking-widest text-amber-300">
        Reason
      </p>

      <p className="mt-2 text-xl font-bold text-white">
        {
          summaryEye === "right"
            ? selectedReviewSummary.rightEyeImageReason
            : selectedReviewSummary.leftEyeImageReason
        }
      </p>

    </div>

  </div>

)}
                </div>

  </div>
  {/* Zoom Indicator */}
{zoomScale > 1 && (
  <div className="absolute top-4 left-4 bg-black/60 backdrop-blur-md px-3 py-1.5 rounded-full text-[10px] font-bold text-white border border-white/20 z-20">
    Zoom: {zoomScale.toFixed(1)}x • Scroll to zoom • Drag to pan
  </div>
)}

{/* Fundus Image Upload By SUMMARY */}
<div className="hidden md:flex absolute bottom-20 left-1/2 -translate-x-1/2 z-20 bg-black/70 backdrop-blur-md px-8 py-3 rounded-2xl border border-white/10 flex items-center gap-6 whitespace-nowrap">

  <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">
  {(summaryEye === "right"
      ? selectedReviewSummary.rightEyeImageStatus === "Not Obtainable"
      : selectedReviewSummary.leftEyeImageStatus === "Not Obtainable")
    ? "Image Status Updated By:"
    : "Fundus Image Uploaded By:"}
</p>

  <p className="text-[11px] font-bold text-white uppercase">
    {
      getUserDisplayName(
        <p className="text-[11px] font-bold text-white uppercase">
  {getUserDisplayName(

    (summaryEye === "right"
      ? selectedReviewSummary.rightEyeImageStatus === "Not Obtainable"
      : selectedReviewSummary.leftEyeImageStatus === "Not Obtainable")

      ? selectedReviewSummary.imageStatusUpdatedBy
      : (
          summaryEye === "right"
            ? selectedReviewSummary.rightEyeUploadedBy
            : selectedReviewSummary.leftEyeUploadedBy
        )

  )}
</p>
      )
    }
  </p>

  <div className="w-px h-4 bg-white/20"></div>

  <p className="text-[10px] text-slate-200 font-bold">
    {new Date(selectedReviewSummary.createdAt).toLocaleString('en-GB')}
  </p>

</div>

</div>

  <div className="absolute top-4 md:top-auto md:bottom-4 left-1/2 -translate-x-1/2 flex items-center justify-center gap-2 bg-slate-900/80 backdrop-blur-md p-1.5 rounded-2xl z-20">

  <button
    onClick={() => setSummaryEye('right')}
    className={`px-2.5 md:px-5 py-1 text-[9px] md:text-xs rounded-xl text-xs font-black uppercase transition-all ${
      summaryEye === 'right'
        ? 'bg-blue-600 text-white'
        : 'bg-slate-700 text-slate-300'
    }`}
  >
    Right Eye (RE)
  </button>

  <button
    onClick={() => setSummaryEye('left')}
    className={`px-2.5 md:px-5 py-1 text-[9px] md:text-xs rounded-xl text-xs font-black uppercase transition-all ${
      summaryEye === 'left'
        ? 'bg-blue-600 text-white'
        : 'bg-slate-700 text-slate-300'
    }`}
  >
    Left Eye (LE)
  </button>

</div>

  {/* RIGHT SIDEBAR */}
  <div className="w-full lg:w-[380px] bg-slate-50 border-l border-slate-200 p-4 md:p-6 flex flex-col flex-1 lg:flex-none h-full min-h-0 overflow-y-auto lg:overflow-hidden">

    <div className="flex items-center justify-between mb-6">

      <div>

        <h2 className="text-xl md:text-2xl font-black text-slate-800">
          {selectedReviewSummary.patientName}
        </h2>

        <p className="text-xs font-bold uppercase tracking-widest text-slate-400 mt-1">
          IC: {
  selectedReviewSummary.ic ||
  selectedReviewSummary.icNumber ||
  selectedReviewSummary.patientIc ||
  '-'
}
        </p>
        
<p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1 mt-2">
  Patient History
</p>

<div className="flex flex-wrap gap-2">

  {selectedReviewSummary.diseaseTypes?.map((disease: string) => (

    <span
      key={disease}
      className="px-2 py-1 rounded-lg bg-red-100 text-red-700 text-[10px] font-black uppercase"
    >
      {disease}
    </span>

  ))}

</div>
      </div>

      <button
        onClick={() => {

  setSelectedReviewSummary(null);

}}
        className="absolute top-3 right-3 z-40 px-3 py-2 rounded-xl bg-slate-100 text-xs font-bold hover:bg-slate-200"
      >
        Close
      </button>

    </div>
<div className="lg:flex-1 min-h-0 overflow-visible lg:overflow-y-auto pr-2 space-y-6 summary-scrollbar">

  {renderVisualAcuity(selectedReviewSummary)}

{/* REVIEWED BY / IMAGE STATUS BY */}
<div className="bg-white rounded-2xl border border-slate-200 p-4">

  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
  {
    selectedReviewSummary.rightEyeImageStatus === "Not Obtainable" &&
    selectedReviewSummary.leftEyeImageStatus === "Not Obtainable"
      ? "Image Status By"
      : (selectedReviewSummary.isEdited ? "Review Edited By" : "Reviewed By")
  }
</p>

  <p className="text-sm font-bold text-slate-700 uppercase mt-2">
    {getUserDisplayName(
      selectedReviewSummary.rightEyeImageStatus === "Not Obtainable" &&
      selectedReviewSummary.leftEyeImageStatus === "Not Obtainable"
        ? (selectedReviewSummary.imageStatusUpdatedBy || "-")
        : (selectedReviewSummary.updatedBy || selectedReviewSummary.reviewedBy || "-")
    )}
  </p>

</div>

{selectedReviewSummary.referred === true && (
  <div className="bg-amber-50 rounded-2xl border border-amber-200 p-4">
    <div className="flex items-start gap-3">
      <div className="flex-1 min-w-0">
        <p className="text-[11px] font-black uppercase tracking-widest text-amber-700">
          ✓ Kes Dirujuk
        </p>

        {selectedReviewSummary.referralComment && (
          <p className="text-sm text-slate-700 mt-2 whitespace-pre-wrap uppercase">
            {selectedReviewSummary.referralComment}
          </p>
        )}
      </div>
    </div>
  </div>
)}

{/* FINDINGS */}
<div className="bg-white rounded-2xl border border-slate-200 p-5 flex flex-col">
  <p className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-4">
    Findings
  </p>

  <div className="space-y-4 pr-2">

    {/* RIGHT EYE */}
    <div className="bg-slate-50 rounded-2xl border border-slate-200 p-4">

      <div className="pb-3 border-b border-black/10 mb-4">

  <p className="text-[11px] font-black uppercase tracking-widest text-blue-500">
    Right Eye Review
  </p>

</div>

      <div className="mt-4">

  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">
    Status
  </p>

  {selectedReviewSummary.rightEyeImageStatus === "Not Obtainable" ? (

    <div className="space-y-2">

      <span className="inline-flex px-4 py-2 rounded-xl text-sm font-black uppercase bg-amber-100 text-amber-700">
        Not Obtainable
      </span>

      <p className="text-xs font-bold uppercase text-slate-500">
        {selectedReviewSummary.rightEyeImageReason}
      </p>

    </div>

  ) : (

    <span
      className={`inline-flex px-4 py-2 rounded-xl text-sm font-black uppercase ${
        selectedReviewSummary.rightEyeReviewDetails?.status === "Abnormal"
          ? "bg-rose-100 text-rose-600"
          : selectedReviewSummary.rightEyeReviewDetails?.status === "Ungradable"
            ? "bg-orange-100 text-orange-700"
            : "bg-emerald-100 text-emerald-600"
      }`}
    >
      {selectedReviewSummary.rightEyeReviewDetails?.status || "-"}
    </span>

  )}

</div>

      {selectedReviewSummary.rightEyeReviewDetails?.abnormalTypes?.length > 0 && (
        <div className="mt-5">

          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">
            Findings
          </p>

          <div className="text-sm text-slate-700 uppercase space-y-1">

            {selectedReviewSummary.rightEyeReviewDetails.abnormalTypes.map((item: string) => (

  <div key={item} className="space-y-1">

    <p className="uppercase font-semibold">
      • {item}
    </p>

    {item === 'Others' &&
      selectedReviewSummary.rightEyeReviewDetails?.othersText && (

        <p className="ml-4 uppercase text-slate-500">
          - {selectedReviewSummary.rightEyeReviewDetails.othersText}
        </p>

      )
    }

    {item === 'NPDR' &&
      selectedReviewSummary.rightEyeReviewDetails?.npdrSeverity && (

        <p className="ml-4 uppercase text-slate-500">
          - {selectedReviewSummary.rightEyeReviewDetails.npdrSeverity}
        </p>

      )
    }

  </div>

))}

          </div>

        </div>
      )}

      {selectedReviewSummary.rightEyeReviewDetails?.comment && (
        <div className="mt-5">

          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">
            Comments
          </p>

          <p className="text-sm text-slate-600 whitespace-pre-wrap uppercase">
            {selectedReviewSummary.rightEyeReviewDetails.comment}
          </p>

        </div>
      )}

    </div>

    {/* LEFT EYE */}
    <div className="bg-slate-50 rounded-2xl border border-slate-200 p-4">

      <div className="pb-3 border-b border-black/10 mb-4">

  <p className="text-[11px] font-black uppercase tracking-widest text-blue-500">
    Left Eye Review
  </p>

</div>

      <div className="mt-4">

  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">
    Status
  </p>

  {selectedReviewSummary.leftEyeImageStatus === "Not Obtainable" ? (

    <div className="space-y-2">

      <span className="inline-flex px-4 py-2 rounded-xl text-sm font-black uppercase bg-amber-100 text-amber-700">
        Not Obtainable
      </span>

      <p className="text-xs font-bold uppercase text-slate-500">
        {selectedReviewSummary.leftEyeImageReason}
      </p>

    </div>

  ) : (

    <span
      className={`inline-flex px-4 py-2 rounded-xl text-sm font-black uppercase ${
        selectedReviewSummary.leftEyeReviewDetails?.status === "Abnormal"
          ? "bg-rose-100 text-rose-600"
          : selectedReviewSummary.leftEyeReviewDetails?.status === "Ungradable"
            ? "bg-orange-100 text-orange-700"
            : "bg-emerald-100 text-emerald-600"
      }`}
    >
      {selectedReviewSummary.leftEyeReviewDetails?.status || "-"}
    </span>

  )}

</div>

      {selectedReviewSummary.leftEyeReviewDetails?.abnormalTypes?.length > 0 && (
        <div className="mt-5">

          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">
            Findings
          </p>

          <div className="text-sm text-slate-700 uppercase space-y-1">

            {selectedReviewSummary.leftEyeReviewDetails.abnormalTypes.map((item: string) => (

  <div key={item} className="space-y-1">

    <p className="uppercase font-semibold">
      • {item}
    </p>

    {item === 'Others' &&
      selectedReviewSummary.leftEyeReviewDetails?.othersText && (

        <p className="ml-4 uppercase text-slate-500">
          - {selectedReviewSummary.leftEyeReviewDetails.othersText}
        </p>

      )
    }

    {item === 'NPDR' &&
      selectedReviewSummary.leftEyeReviewDetails?.npdrSeverity && (

        <p className="ml-4 uppercase text-slate-500">
          - {selectedReviewSummary.leftEyeReviewDetails.npdrSeverity}
        </p>

      )
    }

  </div>

))}

          </div>

        </div>
      )}

      {selectedReviewSummary.leftEyeReviewDetails?.comment && (
        <div className="mt-5">

          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">
            Comments
          </p>

          <p className="text-sm text-slate-600 whitespace-pre-wrap uppercase">
            {selectedReviewSummary.leftEyeReviewDetails.comment}
          </p>

        </div>
        
      )}

    </div>
      </div>
        </div>

{/* PREVIOUS VISITS */}
{patientHistory.length > 0 && (
<div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">

  <button
    onClick={() =>
      setShowPatientHistory(!showPatientHistory)
    }
    disabled={patientHistory.length === 0}
    className={`w-full flex items-center justify-between px-4 py-3 transition-all ${
      patientHistory.length === 0
        ? "cursor-not-allowed bg-slate-50"
        : "hover:bg-slate-50"
    }`}
  >

    <div className="flex flex-col items-start">

      <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">
        Previous Visits
      </span>

      <span className="text-xs font-bold text-slate-500">
        {patientHistory.length} record
        {patientHistory.length !== 1 && "s"}
      </span>

    </div>

    <ChevronDown
      size={18}
      className={`transition-transform duration-300 ${
        showPatientHistory ? "rotate-180" : ""
      } ${
        patientHistory.length === 0
          ? "text-slate-300"
          : "text-slate-500"
      }`}
    />

  </button>

  {showPatientHistory && patientHistory.length > 0 && (

    <div className="border-t border-slate-200 p-3 space-y-2">

      {patientHistory.map(history => (

        <button
          key={history.id}
          onClick={() => setSelectedHistory(history)}
          className="w-full flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 hover:bg-blue-50 hover:border-blue-200 px-3 py-2 transition-all group"
        >

          <div className="text-left">

            <p className="text-xs font-bold text-slate-700">
              {new Date(history.date).toLocaleDateString("en-GB")}
            </p>

            <p className="text-[10px] uppercase text-slate-400">
              {history.department}
            </p>

          </div>

          <Eye
            size={15}
            className="text-slate-400 group-hover:text-blue-600"
          />

        </button>

      ))}

    </div>

  )}

</div>
)}

{/*--- Mobile edit button: stays in the normal scroll flow at the very bottom ---*/}
<button
  onClick={() => {
    setSelectedReviewSummary(null);
    setSelectedPhotoApp({
      app: selectedReviewSummary,
      eye: 'right'
    });
  }}
  className="lg:hidden w-full py-4 mt-6 mb-2 bg-slate-900 hover:bg-black text-white font-black rounded-2xl transition-all text-[11px] uppercase tracking-[0.2em]"
>
  Edit Review
</button>

</div>
{/* EDIT REVIEW BUTTON */}
<button
  onClick={() => {
    setSelectedReviewSummary(null);
    setSelectedPhotoApp({
      app: selectedReviewSummary,
      eye: 'right'
    });
  }}
  className="hidden lg:block shrink-0 w-full py-4 bg-slate-900 hover:bg-black text-white font-black rounded-2xl transition-all text-[11px] uppercase tracking-[0.2em]"
>
  Edit Review
</button>


  </div>

</div>

      </motion.div>

    </div>

  )}

</AnimatePresence>
</AnimatePresence>
    </div>
    <AnimatePresence>

  {showAccountSettings && (

    <div className="fixed inset-0 z-[300] flex items-start sm:items-center justify-center p-2 sm:p-4 overflow-y-auto overscroll-contain">

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={() => {

  if (isSavingAccount) return;

  setShowAccountSettings(false);

  setCurrentPasswordInput('');
  setNewPasswordInput('');
  setConfirmPasswordInput('');

  setNewDisplayName(currentUser?.displayName || '');

}}
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
      />

      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        className="relative z-10 w-full max-w-md max-h-[calc(100dvh-1rem)] sm:max-h-[calc(100dvh-2rem)] bg-white rounded-3xl shadow-2xl overflow-hidden flex flex-col"
      >

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-blue-50">

          <div className="flex items-center gap-3">

  <div className="w-10 h-10 rounded-2xl bg-blue-600 flex items-center justify-center shadow-lg">

    <UserCog size={18} className="text-white" />

  </div>

  <div>

    <h2 className="text-lg font-black text-slate-800 tracking-tight">
      Clinical Account Settings
    </h2>

    <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mt-1">
      Manage Your Credentials
    </p>

  </div>

</div>

          <button
            onClick={() => {

  if (isSavingAccount) return;

  setShowAccountSettings(false);

  setCurrentPasswordInput('');
  setNewPasswordInput('');
  setConfirmPasswordInput('');

  setNewDisplayName(currentUser?.displayName || '');

}}
            disabled={isSavingAccount}
            className="p-2 rounded-xl hover:bg-slate-200 text-slate-400 transition-all disabled:opacity-50"
          >
            <XCircle size={22} />
          </button>

        </div>

        {/* Body */}
        <div className="p-6 space-y-3">

          {/* Display Name */}
          <div className="space-y-2">

            <label className="text-[10px] font-black uppercase tracking-widest text-slate-400">

              Display Name

            </label>

            <input
              type="text"
              value={newDisplayName}
              onChange={(e) => setNewDisplayName(e.target.value)}
              className="w-full px-4 py-3 rounded-2xl border border-slate-200 bg-slate-50/70 focus:ring-2 focus:ring-blue-500 outline-none text-sm font-semibold"
              placeholder="Enter display name"
            />

          </div>

          {/* Current Password */}
<div className="space-y-2">

  <label className="text-[10px] font-black uppercase tracking-widest text-slate-400">

    Current Password

  </label>

  <div className="relative">

    <input
      type={showCurrentPassword ? 'text' : 'password'}
      value={currentPasswordInput}
      onChange={(e) => setCurrentPasswordInput(e.target.value)}
      className="w-full px-4 py-3 pr-12 rounded-2xl border border-slate-200 bg-slate-50/70 bg-slate-50/70 focus:ring-2 focus:ring-blue-500 outline-none text-sm font-semibold"
      placeholder="••••••"
    />

    <div
      onMouseEnter={() => setShowCurrentPassword(true)}
      onMouseLeave={() => setShowCurrentPassword(false)}
      className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 cursor-pointer transition-all duration-200"
    >

      <Eye size={18} />

    </div>

  </div>

</div>

          {/* New Password */}
<div className="space-y-2">

  <label className="text-[10px] font-black uppercase tracking-widest text-slate-400">

    New Password

  </label>

  <div className="relative">

    <input
      type={showNewPassword ? 'text' : 'password'}
      value={newPasswordInput}
      onChange={(e) => setNewPasswordInput(e.target.value)}
      className="w-full px-4 py-3 pr-12 rounded-2xl border border-slate-200 bg-slate-50/70 bg-slate-50/70 focus:ring-2 focus:ring-blue-500 outline-none text-sm font-semibold"
      placeholder="••••••"
    />

    <div
      onMouseEnter={() => setShowNewPassword(true)}
      onMouseLeave={() => setShowNewPassword(false)}
      className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 cursor-pointer transition-all duration-200"
    >

      <Eye size={18} />

    </div>

  </div>

</div>

          {/* Confirm Password */}
<div className="space-y-2">

  <label className="text-[10px] font-black uppercase tracking-widest text-slate-400">

    Confirm Password

  </label>

  <div className="relative">

    <input
      type={showConfirmPassword ? 'text' : 'password'}
      value={confirmPasswordInput}
      onChange={(e) => setConfirmPasswordInput(e.target.value)}
      className="w-full px-4 py-3 pr-12 rounded-2xl border border-slate-200 bg-slate-50/70 bg-slate-50/70 focus:ring-2 focus:ring-blue-500 outline-none text-sm font-semibold"
      placeholder="••••••"
    />

    <div
      onMouseEnter={() => setShowConfirmPassword(true)}
      onMouseLeave={() => setShowConfirmPassword(false)}
      className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 cursor-pointer transition-all duration-200"
    >

      <Eye size={18} />

    </div>

  </div>

</div>

          {/* Save Button */}
          <button
          onClick={handleAccountUpdate}
          disabled={isSavingAccount}
            className="w-full py-4 bg-gradient-to-r from-slate-900 to-blue-900 hover:bg-gradient-to-r hover:from-slate-800 hover:to-blue-800 text-white font-black rounded-2xl transition-all uppercase tracking-widest text-xs"
          >

            {isSavingAccount ? 'Saving...' : 'Save Changes'}

          </button>

        </div>

      </motion.div>

    </div>

  )}

</AnimatePresence>

{/* MONTHLY SUMMARY MODAL */}
<AnimatePresence>
  {showMonthlySummary && (
    <div
      className="fixed inset-0 z-[145] flex items-start sm:items-center justify-center p-2 sm:p-4 overflow-y-auto overscroll-contain bg-slate-900/50 backdrop-blur-sm"
      onClick={() => setShowMonthlySummary(false)}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 10 }}
        transition={{ duration: 0.2 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-5xl max-h-[calc(100dvh-1rem)] sm:max-h-[calc(100dvh-2rem)] bg-white rounded-3xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col"
      >

        {/* HEADER */}
<div className="px-6 py-5 border-b border-slate-200">

  <div className="flex items-start justify-between gap-4">

    {/* TITLE */}
    <div className="min-w-0">
      <h2 className="text-xl md:text-2xl font-black text-slate-800">
        Monthly Summary
      </h2>

      <p className="text-[11px] font-bold uppercase tracking-widest text-slate-400 mt-1">
        Reten Saringan Fundus Kamera — {currentClinic?.name || 'Klinik Kesihatan Lintang'}
      </p>
    </div>


    {/* MONTH NAVIGATION + CLOSE */}
    <div className="flex items-center gap-2 shrink-0">

    <div className="flex items-center gap-3 mt-2">

  <button
    onClick={() => changeAnalyticsMonth(-1)}
    className="p-1 rounded-full hover:bg-slate-200"
  >
    <ChevronLeft size={18}/>
  </button>

  <p className="text-slate-600 text-sm font-bold min-w-[120px] text-center">
    {
      selectedAnalyticsMonth.toLocaleString(
        'en-US',
        {
          month: 'long',
          year: 'numeric'
        }
      )
    }
  </p>

  <button
    disabled={isCurrentMonth}
    onClick={() => changeAnalyticsMonth(1)}
    className={`p-1 rounded-full transition-all ${
      isCurrentMonth
        ? "opacity-30 cursor-not-allowed"
        : "hover:bg-slate-200"
    }`}
  >
    <ChevronRight size={18}/>
  </button>

</div>


      {/* CLOSE */}
      <button
        onClick={() => setShowMonthlySummary(false)}
        className="ml-2 w-9 h-9 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-500 hover:text-slate-700 flex items-center justify-center font-black transition-all"
        title="Close"
      >
        ×
      </button>

    </div>

  </div>

</div>

        {/* CONTENT */}
<div className="p-4 sm:p-6 flex-1 min-h-0 overflow-y-auto overscroll-contain">

  {/* ===== SCREENING SUMMARY ===== */}
  <section>
    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-3">
      Screening Summary
    </p>

    <div className="grid grid-cols-1 md:grid-cols-4 gap-3">

      {/*--- Total monthly provider workload. Referrals performed by this clinic are included. ---*/}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 md:col-span-1">
        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
          Total
        </p>

        <p className="text-3xl font-black text-white mt-1">
          {monthlyRetenStats.total}
        </p>

        <p className="text-[10px] font-bold text-slate-400 uppercase">
          Cases
        </p>
      </div>

    </div>
  </section>


  {/* ===== OUTCOME SCREENING ===== */}
  <section className="mt-6">

    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-3">
      Outcome Screening
    </p>

    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">

      {/* NORMAL */}
      <div className="bg-emerald-50 border border-emerald-100 rounded-2xl p-5">
        <div className="flex items-center justify-between">

          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-emerald-600">
              ✓ Normal
            </p>

            <p className="text-3xl font-black text-slate-800 mt-1">
              {monthlyRetenStats.normal}
            </p>
          </div>

        </div>
      </div>


      {/* ABNORMAL */}
      <div className="bg-rose-50 border border-rose-100 rounded-2xl p-5">
        <div className="flex items-center justify-between">

          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-rose-600">
              ⚠ Abnormal
            </p>

            <p className="text-3xl font-black text-slate-800 mt-1">
              {monthlyRetenStats.abnormal}
            </p>
          </div>

        </div>
      </div>

      {/* UNGRADABLE */}
      <div className="bg-orange-50 border border-orange-100 rounded-2xl p-5">
        <div>
          <p className="text-[10px] font-black uppercase tracking-widest text-orange-600">◈ Ungradable</p>
          <p className="text-3xl font-black text-orange-600 mt-1">{monthlyRetenStats.ungradable}</p>
        </div>
      </div>

      {/* NOT OBTAINABLE */}
      <div className="bg-amber-50 border border-amber-100 rounded-2xl p-5">
        <div>
          <p className="text-[10px] font-black uppercase tracking-widest text-amber-600">
            ◯ Not Obtainable
          </p>

          <p className="text-3xl font-black text-slate-800 mt-1">
            {monthlyRetenStats.notObtainable}
          </p>
        </div>
      </div>
      {/* NOT REVIEW YET */}
<div className="bg-slate-50 border border-slate-200 rounded-2xl p-5">
  <div>
    <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">
      ◷ Not Review Yet
    </p>

    <p className="text-3xl font-black text-slate-800 mt-1">
      {monthlyRetenStats.notReviewYet}
    </p>
  </div>
</div>
    </div>

  </section>


  {/* ===== RETEN FINDINGS ===== */}
  <section className="mt-6">

    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-3">
      Reten Findings
    </p>

    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">

      {/* MILD NPDR */}
      <div className="bg-white border border-slate-200 rounded-2xl p-4">
        <p className="text-[10px] font-black uppercase text-slate-400">
          Mild NPDR
        </p>
        <p className="text-2xl font-black text-slate-800 mt-1">
          {monthlyRetenStats.mildNPDR}
        </p>
      </div>

      {/* MODERATE NPDR */}
      <div className="bg-white border border-slate-200 rounded-2xl p-4">
        <p className="text-[10px] font-black uppercase text-slate-400">
          Moderate NPDR
        </p>
        <p className="text-2xl font-black text-slate-800 mt-1">
          {monthlyRetenStats.moderateNPDR}
        </p>
      </div>

      {/* SEVERE NPDR */}
      <div className="bg-white border border-slate-200 rounded-2xl p-4">
        <p className="text-[10px] font-black uppercase text-slate-400">
          Severe NPDR
        </p>
        <p className="text-2xl font-black text-slate-800 mt-1">
          {monthlyRetenStats.severeNPDR}
        </p>
      </div>

      {/* PDR */}
      <div className="bg-white border border-slate-200 rounded-2xl p-4">
        <p className="text-[10px] font-black uppercase text-slate-400">
          PDR
        </p>
        <p className="text-2xl font-black text-slate-800 mt-1">
          {monthlyRetenStats.pdr}
        </p>
      </div>

      {/* MACULOPATHY */}
      <div className="bg-white border border-slate-200 rounded-2xl p-4">
        <p className="text-[10px] font-black uppercase text-slate-400">
          Maculopathy
        </p>
        <p className="text-2xl font-black text-slate-800 mt-1">
          {monthlyRetenStats.maculopathy}
        </p>
      </div>

      {/* ADED */}
      <div className="bg-white border border-slate-200 rounded-2xl p-4">
        <p className="text-[10px] font-black uppercase text-slate-400">
          ADED
        </p>
        <p className="text-2xl font-black text-slate-800 mt-1">
          {monthlyRetenStats.aded}
        </p>
      </div>

      {/* CATARACT */}
      <div className="bg-white border border-slate-200 rounded-2xl p-4">
        <p className="text-[10px] font-black uppercase text-slate-400">
          Cataract
        </p>
        <p className="text-2xl font-black text-slate-800 mt-1">
          {monthlyRetenStats.cataract}
        </p>
      </div>

      {/* LAIN-LAIN */}
      <div className="bg-white border border-slate-200 rounded-2xl p-4">
        <p className="text-[10px] font-black uppercase text-slate-400">
          Lain-lain
        </p>
        <p className="text-2xl font-black text-slate-800 mt-1">
          {monthlyRetenStats.others}
        </p>
      </div>

      {/* REFERRED */}
      <div className="bg-cyan-50 border border-cyan-100 rounded-2xl p-4">
        <p className="text-[10px] font-black uppercase text-cyan-600">
          ✓ Kes Dirujuk
        </p>
        <p className="text-2xl font-black text-slate-800 mt-1">
          {monthlyRetenStats.referred}
        </p>
      </div>

    </div>

  </section>

</div>

      </motion.div>
    </div>
  )}
</AnimatePresence>

{/* ACTIVITY LOG MODAL */}
<AnimatePresence>

  {showActivityLogs && (

    <div className="fixed inset-0 z-[140] flex items-start sm:items-center justify-center p-2 sm:p-4 overflow-y-auto overscroll-contain">

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={() => setShowActivityLogs(false)}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
      />

      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="relative z-10 bg-white rounded-3xl shadow-2xl w-full max-w-2xl max-h-[calc(100dvh-1rem)] sm:max-h-[calc(100dvh-2rem)] overflow-hidden flex flex-col"
      >

        <div className="p-6 border-b border-slate-200 flex items-center justify-between">

          <div>

            <h2 className="text-xl font-black text-slate-800">
              Clinical Activity Logs
            </h2>

            <p className="text-[10px] uppercase tracking-widest text-slate-400 font-bold mt-1">
              Administrative Audit Trail
            </p>

          </div>

          <button
            onClick={() => setShowActivityLogs(false)}
            className="w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 transition-all"
          >
            ✕
          </button>

        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">

          {visibleActivityLogs.length === 0 ? (

            <div className="text-center text-slate-400 text-sm py-10 font-bold">
              No activity logs available.
            </div>

          ) : (

            visibleActivityLogs.map((log, index) => (

              <div
                key={index}
                className="bg-slate-50 border border-slate-200 rounded-2xl p-4"
              >

                <div className="flex items-center justify-between gap-4">

                  <div>

                    <p className="text-sm font-black text-slate-800 uppercase">
                      {log.action}
                    </p>

                    <p className="text-xs text-slate-500 font-semibold mt-1 uppercase">
                      {log.patient}
                    </p>

                    <p className="text-[10px] text-slate-400 font-bold uppercase mt-2">
                      BY {log.by}
                    </p>

                  </div>

                  <div className="text-[10px] text-slate-400 font-bold whitespace-nowrap">
                    {new Date(log.timestamp).toLocaleString('en-GB')}
                  </div>

                </div>

              </div>

            ))

          )}

        </div>

      </motion.div>

    </div>

  )}

      </AnimatePresence>

      {/* Print Patient Report: editable A4 form preview; values are only used for this PDF */}
      <AnimatePresence>
        {printReportApp && (
          <div className="fixed inset-0 z-[180] flex flex-col bg-slate-950/80 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}
              className="flex min-h-0 flex-1 flex-col"
            >
              <div className="shrink-0 px-4 sm:px-6 py-3 bg-gradient-to-r from-blue-950 to-blue-800 text-white flex items-center justify-between gap-4 shadow-lg">
                <div className="min-w-0">
                  <h2 className="text-base sm:text-lg font-black">{reportActionMode === 'refer' ? 'Borang Rujukan Pakar' : 'Preview Borang Sebelum Cetak'}</h2>
                  <p className="text-[11px] sm:text-xs text-blue-100 mt-0.5">{reportActionMode === 'refer' ? 'Lengkapkan maklumat rujukan sebelum dihantar ke klinik pakar.' : 'Isi terus pada ruangan borang. Perubahan hanya digunakan untuk PDF dan tidak disimpan ke rekod pesakit.'}</p>
                </div>
                <button type="button" onClick={() => !isGeneratingPatientReport && setPrintReportApp(null)} disabled={isGeneratingPatientReport} className="shrink-0 rounded-lg px-3 py-2 text-white hover:bg-white/10 disabled:opacity-50" aria-label="Tutup popup">✕</button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-6 sm:py-6">
                {(() => {
                  const app = printReportApp;
                  const inputClass = "min-w-0 w-full border-0 border-b border-dotted border-slate-500 bg-transparent px-1 py-0.5 text-[11px] sm:text-xs text-slate-900 outline-none focus:border-blue-700 focus:ring-0 rounded-none placeholder:text-slate-400";
                  const labelClass = "shrink-0 text-[10px] sm:text-[11px] font-semibold text-slate-700";
                  const field = (key: string, label: string, placeholder = '', multiline = false) => (
                    <label key={key} className="flex min-w-0 items-baseline gap-1.5">
                      <span className={labelClass}>{label}:</span>
                      {multiline ? <textarea rows={2} className={inputClass + " resize-y border border-dotted border-slate-400 px-1.5 py-1"} value={printReportFields[key] || ''} placeholder={placeholder} onChange={e => setPrintReportFields(prev => ({ ...prev, [key]: e.target.value }))} /> : <input className={inputClass} value={printReportFields[key] || ''} placeholder={placeholder} onChange={e => setPrintReportFields(prev => ({ ...prev, [key]: e.target.value }))} />}
                    </label>
                  );
                  const section = (n: number, title: string) => <div className="mb-2 flex items-center gap-2 rounded-sm bg-blue-50 px-2 py-1.5 border-l-[3px] border-blue-900"><span className="flex h-5 w-5 items-center justify-center rounded-full bg-blue-950 text-[10px] font-bold text-white">{n}</span><span className="text-[11px] font-black uppercase tracking-wide text-blue-950">{title}</span></div>;
                  const eyeInfo = (eye: 'right' | 'left') => {
                    const d = eye === 'right' ? app.rightEyeReviewDetails : app.leftEyeReviewDetails;
                    const review = eye === 'right' ? app.rightEyeReview : app.leftEyeReview;
                    const status = eye === 'right' ? app.rightEyeImageStatus : app.leftEyeImageStatus;
                    const reason = eye === 'right' ? app.rightEyeImageReason : app.leftEyeImageReason;
                    const types = d?.abnormalTypes || [];
                    const text = status === 'Not Obtainable' ? `Not Obtainable${reason ? ` — ${reason}` : ''}` : (d?.status || review || 'Belum direkodkan');
                    return { text, types: types.join(', '), severity: d?.npdrSeverity || '', notes: [d?.othersText, d?.comment].filter(Boolean).join(' — ') };
                  };
                  const miniInput = (key: string, placeholder = 'Isi di sini') => <input aria-label={key} className={inputClass + " text-center"} value={printReportFields[key] || ''} placeholder={placeholder} onChange={e => setPrintReportFields(prev => ({ ...prev, [key]: e.target.value }))} />;
                  return <div className="mx-auto flex w-full max-w-[900px] flex-col items-center gap-6 text-slate-900">
                    {/* PAGE 1 — follows the first page of the downloadable PDF */}
                    <div className="w-full max-w-[794px] bg-white shadow-2xl ring-1 ring-black/10 px-5 py-5 sm:px-8 sm:py-7 aspect-auto min-h-[1000px] text-[11px]">
                      <div className="grid grid-cols-[76px_minmax(0,1fr)] items-center gap-3 border-b-[3px] border-blue-950 pb-3 mb-3">
                        <div className="flex flex-col items-center gap-1"><img src={roundLogo} alt="SINAR logo" className="h-12 w-12 object-contain"/><img src={textLogo} alt="SINAR" className="h-4 max-w-[76px] object-contain"/></div>
                        <div className="text-center"><h3 className="text-sm sm:text-base font-black text-blue-950">REKOD PEMERIKSAAN FUNDUS &amp; RUJUKAN</h3><p className="mt-1 text-[10px] font-bold text-slate-600">{(getClinicById(clinics, superAdminClinicContext || currentUser?.clinicId) || currentClinic)?.name || ''}</p>{(getClinicById(clinics, superAdminClinicContext || currentUser?.clinicId) || currentClinic)?.address && <p className="mt-0.5 text-[9px] leading-tight text-slate-500 whitespace-pre-line">{(getClinicById(clinics, superAdminClinicContext || currentUser?.clinicId) || currentClinic)?.address}</p>}{(getClinicById(clinics, superAdminClinicContext || currentUser?.clinicId) || currentClinic)?.phone && <p className="mt-0.5 text-[9px] font-semibold text-slate-600">Tel: {(getClinicById(clinics, superAdminClinicContext || currentUser?.clinicId) || currentClinic)?.phone}</p>}</div>
                      </div>

                      {section(1, 'Maklumat Pesakit')}
                      <div className="space-y-2 px-1 mb-3">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-2"><div className="flex items-baseline gap-1.5"><span className={labelClass}>Nama Pesakit:</span><span className="border-b border-dotted border-slate-500 px-1 py-0.5 text-xs font-bold flex-1">{app.patientName || '—'}</span></div><div className="flex items-baseline gap-1.5"><span className={labelClass}>No. K/P:</span><span className="border-b border-dotted border-slate-500 px-1 py-0.5 text-xs font-bold flex-1">{app.icNumber || '—'}</span></div><div className="flex items-baseline gap-1.5"><span className={labelClass}>Klinik Kesihatan (Asal):</span><span className="border-b border-dotted border-slate-500 px-1 py-0.5 text-[11px] flex-1">{getClinicById(clinics, getReferringClinicId(app))?.name || '—'}</span></div><div className="flex items-baseline gap-1.5"><span className={labelClass}>No. Telefon:</span><span className="border-b border-dotted border-slate-500 px-1 py-0.5 text-[11px] flex-1">{app.phoneNumber || '—'}</span></div></div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-2"><div className="flex items-baseline gap-1.5"><span className={labelClass}>Diabetes Mellitus sejak:</span>{field('dmDuration', '(tahun)', 'Contoh: 8 tahun')}</div>{field('hba1c', 'HbA1c', 'Keputusan')}</div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-2"><div className="flex min-w-0 items-baseline gap-1.5"><span className={labelClass}>Penyakit Lain:</span><input aria-label="Penyakit Lain" className={inputClass + " flex-1 min-w-0"} value={printReportFields.otherDiseases || ''} placeholder="Contoh: DM, HTN, LIPID, CKD" onChange={e => setPrintReportFields(prev => ({ ...prev, otherDiseases: e.target.value }))} /></div><div className="flex items-baseline gap-1.5"><span className={labelClass}>Tarikh Pemeriksaan:</span><span className="border-b border-dotted border-slate-500 px-1 py-0.5 text-[11px] flex-1">{app.date ? new Date(app.date).toLocaleDateString('en-GB') : '—'}</span></div></div>
                        {field('history', 'Sejarah ringkas', 'Masukkan sejarah ringkas', true)}
                      </div>

                      {section(2, 'Visual Acuity (V/A)')}
                      <div className="mb-4 overflow-hidden border border-slate-300">
                        <div className="grid grid-cols-3 bg-blue-50 text-[10px] font-black text-blue-950"><div className="p-2">PEMERIKSAAN</div><div className="p-2 text-center border-l border-slate-300">RE (MATA KANAN)</div><div className="p-2 text-center border-l border-slate-300">LE (MATA KIRI)</div></div>
                        {[{label:'Unaided',right:'rightEyeVAUnaided',left:'leftEyeVAUnaided'},{label:'With Glasses',right:'rightEyeVAWithGlasses',left:'leftEyeVAWithGlasses'},{label:'Pinhole',right:'rightEyeVAPinhole',left:'leftEyeVAPinhole'}].map(row=><div key={row.label} className="grid grid-cols-3 border-t border-slate-300 min-h-8 items-center"><div className="px-2 py-1 text-[11px]">{row.label}</div><div className="px-2 py-1 border-l border-slate-300">{miniInput(row.right)}</div><div className="px-2 py-1 border-l border-slate-300">{miniInput(row.left)}</div></div>)}
                      </div>

                      {section(3, 'Gambar Fundus')}
                      <div className="grid grid-cols-2 gap-3 mb-4">
                        {[{title:'MATA KANAN (RE)',image:app.rightEyePhoto,uploadedBy:app.rightEyeUploadedBy,uploadedAt:app.rightEyePhotoUploadedAt},{title:'MATA KIRI (LE)',image:app.leftEyePhoto,uploadedBy:app.leftEyeUploadedBy,uploadedAt:app.leftEyePhotoUploadedAt}].map(photo=><div key={photo.title} className="border border-slate-300 rounded-sm p-2"><h4 className="text-center text-[10px] font-black text-blue-950 mb-2">{photo.title}</h4><div className="h-36 sm:h-44 flex items-center justify-center bg-slate-50 border border-slate-200">{photo.image?<img src={photo.image} alt={photo.title} className="max-h-full max-w-full object-contain"/>:<span className="text-[10px] text-slate-400">Tiada gambar fundus</span>}</div><p className="mt-2 text-center text-[9px] text-slate-600">Tarikh / masa imej: {photo.uploadedAt ? new Date(photo.uploadedAt).toLocaleString('en-GB') : '____ / ____ / ______  ______'}</p><p className="text-center text-[9px] text-slate-600">Dimuat naik oleh: {photo.uploadedBy ? getUserDisplayName(photo.uploadedBy) : '________________'}</p></div>)}
                      </div>

                      {section(4, 'Dapatan Pemeriksaan')}
                      <div className="grid grid-cols-2 gap-3 mb-3">
                        {[{title:'MATA KANAN (RE)',data:eyeInfo('right')},{title:'MATA KIRI (LE)',data:eyeInfo('left')}].map(eye=><div key={eye.title} className="border border-slate-300 rounded-sm overflow-hidden"><h4 className="bg-blue-50 px-2 py-1.5 text-[10px] font-black text-blue-950">{eye.title}</h4><div className="p-2 space-y-1 text-[10px]"><p><b>Status:</b> {eye.data.text}</p><p><b>Jenis abnormaliti:</b> {eye.data.types || '—'}</p><p><b>NPDR severity:</b> {eye.data.severity || '—'}</p><p><b>Catatan:</b> {eye.data.notes || '—'}</p></div></div>)}
                      </div>
                      <div className="grid grid-cols-[100px_minmax(0,1fr)] gap-3 px-1"> <div className="flex items-baseline gap-1.5"><span className={labelClass}>Kes Dirujuk:</span><span className="text-[11px] font-bold">{app.referred === true ? 'Ya' : app.referred === false ? 'Tidak' : '—'}</span></div><div className="flex min-w-0 items-baseline gap-1.5"><span className={labelClass}>Jika Ya, nyatakan sebab:</span><input aria-label="Jika Ya, nyatakan sebab" className={inputClass} value={printReportFields.referralReason || ''} placeholder="Tulis sebab rujukan di sini" onChange={e => setPrintReportFields(prev => ({ ...prev, referralReason: e.target.value }))} /></div></div>

                      {section(5, 'Pengesahan Petugas')}
                      <div className="px-1 mb-3 space-y-2">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-2">{field('staffName', 'Nama Petugas', 'Nama pegawai yang merujuk')}{field('staffDesignation', 'Jawatan', 'Jawatan')}</div>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-2"><div className="flex items-baseline gap-1.5"><span className={labelClass}>Tandatangan:</span><span className="flex-1 border-b border-dotted border-slate-500 min-h-5"></span></div><div className="flex items-baseline gap-1.5"><span className={labelClass}>Cop Rasmi:</span><span className="flex-1 border-b border-dotted border-slate-500 min-h-5"></span></div><div className="flex items-baseline gap-1.5"><span className={labelClass}>Tarikh:</span><span className="flex-1 border-b border-dotted border-slate-500 min-h-5">{printReportFields.staffDate || ''}</span></div></div>
                      </div>
                      <p className="mt-4 text-right text-[8px] text-slate-400">Halaman 1 · Preview borang SINAR</p>
                    </div>

                    {reportActionMode === 'print' && (() => {
                      // Section 6 is never editable from the clinic print preview.
                      // It is populated only from the specialist report returned to this appointment.
                      const returned = (app as any).specialistReport || {};
                      const hasReturnedReport = (app as any).specialistReportStatus === 'Returned' || Boolean((app as any).specialistReportReturnedAt);
                      const hasDigitalSpecialistReport = hasReturnedReport && Boolean(String(returned.ophthalmologyDoctorName || '').trim());
                      const reportValue = (key: string) => hasReturnedReport ? String(returned[key] ?? '') : '';
                      const ruledLines = (value: string, count: number) => {
                        const lines = value ? value.split(/\r?\n/) : [];
                        return Array.from({ length: Math.max(count, lines.length) }, (_, index) => (
                          <div key={index} className="min-h-7 border-b border-slate-400 flex items-end px-1 pb-1 text-[11px] text-slate-900 whitespace-pre-wrap">{lines[index] || ''}</div>
                        ));
                      };
                      return <div className="w-full max-w-[794px] min-h-[1000px] bg-white shadow-2xl ring-1 ring-black/10 px-5 py-5 sm:px-8 sm:py-7 text-[11px]">
                        <div className="border-b border-slate-300 pb-3 mb-5">
                          <h3 className="text-sm sm:text-base font-black text-blue-950">SAMBUNGAN REKOD PEMERIKSAAN FUNDUS &amp; RUJUKAN</h3>
                          <p className="mt-2 text-[10px] text-slate-600"><b>Nama:</b> {app.patientName || '—'} <span className="ml-5"><b>No. K/P:</b> {app.icNumber || '—'}</span></p>
                        </div>
                        {section(6, 'Untuk Kegunaan Pakar Oftalmologi')}
                        <div className="space-y-5 px-1 pt-2">
                          <div><p className={labelClass + ' mb-1'}>Laporan:</p>{ruledLines(reportValue('ophthalmologyReport'), 3)}</div>
                          <div><p className={labelClass + ' mb-1'}>Syor:</p>{ruledLines(reportValue('ophthalmologyRecommendation'), 3)}</div>
                          <div className="max-w-[360px]"><p className={labelClass + ' mb-1'}>Temujanji di Klinik Oftalmologi:</p><div className="min-h-7 border-b border-dotted border-slate-500 flex items-end px-1 pb-1 text-[11px]">{reportValue('ophthalmologyAppointment')}</div></div>
                          <div className="grid grid-cols-2 gap-5 pt-2">
                            <div><p className={labelClass + ' mb-1'}>Nama Doktor:</p><div className="min-h-7 border-b border-dotted border-slate-500 px-1 pb-1">{reportValue('ophthalmologyDoctorName')}</div></div>
                            <div><p className={labelClass + ' mb-1'}>Jawatan:</p><div className="min-h-7 border-b border-dotted border-slate-500 px-1 pb-1">{reportValue('ophthalmologyDesignation')}</div></div>
                          </div>
                          <div className="max-w-[260px]"><p className={labelClass + ' mb-1'}>Tarikh laporan:</p><div className="min-h-7 border-b border-dotted border-slate-500 px-1 pb-1">{hasReturnedReport && (app as any).specialistReportReturnedAt ? ((app as any).specialistReportReturnedAt?.toDate ? (app as any).specialistReportReturnedAt.toDate() : new Date((app as any).specialistReportReturnedAt)).toLocaleDateString('en-GB') : reportValue('ophthalmologyDate')}</div></div>
                        </div>
                        <div className="mt-10 text-right text-[8px] text-slate-400">{hasReturnedReport ? 'Laporan pakar diterima semula oleh klinik' : 'Untuk kegunaan pakar oftalmologi'}</div>
                        <div className="mt-16 border-t border-slate-200 pt-2 flex items-end justify-between gap-3 text-[8px] text-slate-400">{hasDigitalSpecialistReport && <span className="italic">Dokumen ini dijana secara digital dan tidak memerlukan tandatangan atau cop rasmi.</span>}<span className="shrink-0">Halaman 2 · SINAR</span></div>
                      </div>;
                    })()}

                  </div>;
                })()}
              </div>

              <div className="shrink-0 px-4 sm:px-6 py-3 bg-white border-t border-slate-200 flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-2 shadow-[0_-4px_12px_rgba(0,0,0,0.08)]">
                <p className="text-[10px] text-slate-500">{reportActionMode === 'refer' ? 'Semak dan lengkapkan maklumat sebelum menghantar rujukan kepada klinik pakar.' : 'Popup ini memaparkan bahagian 1 hingga 5. Borang PDF akan dijana menggunakan maklumat di atas.'}</p>
                <div className="flex flex-wrap justify-end gap-2"><button type="button" onClick={() => setPrintReportApp(null)} disabled={isGeneratingPatientReport || isSendingReferral} className="px-4 py-2.5 rounded-xl border border-slate-300 text-slate-700 font-bold text-sm hover:bg-slate-50 disabled:opacity-50">Batal</button>{reportActionMode === 'refer' && <button type="button" onClick={() => { const allowedSpecialistIds = currentClinic?.specialistClinicIds || []; if (!specialistClinics.some(clinic => clinic.active && allowedSpecialistIds.includes(clinic.id))) { alert('Tiada klinik pakar yang dibenarkan untuk klinik anda. Sila hubungi Super Admin untuk tetapkan Specialist Referral Routing.'); return; } setShowReferralClinicPicker(true); }} disabled={isSendingReferral} className="px-5 py-2.5 rounded-xl bg-violet-700 hover:bg-violet-800 text-white font-black text-sm shadow-md disabled:opacity-60 flex items-center justify-center gap-2"><Network size={16}/>Rujuk</button>}{reportActionMode === 'print' && <button type="button" onClick={() => void generatePatientReport(printReportApp, printReportFields)} disabled={isGeneratingPatientReport} className="px-5 py-2.5 rounded-xl bg-blue-700 hover:bg-blue-800 text-white font-black text-sm shadow-md disabled:opacity-60 flex items-center justify-center gap-2"><Printer size={16}/>{isGeneratingPatientReport ? 'Sedang menjana PDF...' : 'Jana & Muat Turun PDF'}</button>}</div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showReferralClinicPicker && printReportApp && (
          <div className="fixed inset-0 z-[220] flex items-center justify-center p-4">
            <motion.button type="button" aria-label="Tutup pilihan klinik pakar" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => !isSendingReferral && setShowReferralClinicPicker(false)} className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm" />
            <motion.div initial={{ opacity: 0, scale: 0.96, y: 12 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96, y: 8 }} className="relative z-10 w-full max-w-lg overflow-hidden rounded-3xl bg-white shadow-2xl">
              <div className="flex items-center gap-3 border-b border-slate-100 bg-violet-50 px-5 py-4">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-violet-700 text-white"><Building2 size={22}/></div>
                <div className="min-w-0 flex-1"><h2 className="text-lg font-black text-slate-900">Pilih Klinik Pakar</h2><p className="mt-0.5 text-xs text-slate-500">Referral untuk {printReportApp.patientName || 'pesakit'}</p></div>
                <button type="button" onClick={() => !isSendingReferral && setShowReferralClinicPicker(false)} disabled={isSendingReferral} className="rounded-xl p-2 text-slate-400 hover:bg-violet-100 hover:text-slate-700 disabled:opacity-50"><XCircle size={22}/></button>
              </div>
              <div className="space-y-3 p-5">
                <label className="block text-xs font-black uppercase tracking-widest text-slate-500">Klinik pakar penerima</label>
                {specialistClinics.filter(clinic => clinic.active && (currentClinic?.specialistClinicIds || []).includes(clinic.id)).length === 0 ? <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">Tiada klinik pakar dibenarkan untuk klinik anda. Sila hubungi Super Admin untuk tetapkan Specialist Referral Routing.</p> : specialistClinics.filter(clinic => clinic.active && (currentClinic?.specialistClinicIds || []).includes(clinic.id)).map(clinic => (
                  <label key={clinic.id} className={`flex cursor-pointer items-center gap-3 rounded-2xl border p-4 transition-colors ${selectedReferralClinicId === clinic.id ? 'border-violet-500 bg-violet-50 ring-2 ring-violet-100' : 'border-slate-200 hover:border-violet-200 hover:bg-slate-50'}`}>
                    <input type="radio" name="specialistClinic" value={clinic.id} checked={selectedReferralClinicId === clinic.id} onChange={() => setSelectedReferralClinicId(clinic.id)} className="h-4 w-4 accent-violet-700" />
                    <span className="min-w-0 flex-1"><span className="block text-sm font-bold text-slate-800">{clinic.name}</span>{clinic.address && <span className="mt-0.5 block text-xs text-slate-500">{clinic.address}</span>}{clinic.phone && <span className="mt-0.5 block text-xs text-slate-500">{clinic.phone}</span>}</span>
                    {selectedReferralClinicId === clinic.id && <CheckCircle2 size={19} className="text-violet-700"/>}
                  </label>
                ))}
              </div>
              <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-4">
                <button type="button" onClick={() => setShowReferralClinicPicker(false)} disabled={isSendingReferral} className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-bold text-slate-600 hover:bg-slate-100 disabled:opacity-50">Kembali</button>
                <button type="button" onClick={() => void sendPatientReferral()} disabled={!selectedReferralClinicId || isSendingReferral} className="flex items-center justify-center gap-2 rounded-xl bg-violet-700 px-5 py-2.5 text-sm font-black text-white shadow-md hover:bg-violet-800 disabled:cursor-not-allowed disabled:opacity-50"><Network size={16}/>{isSendingReferral ? 'Menghantar...' : 'Sahkan & Hantar Referral'}</button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
      </>
  );
}

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
  AlertTriangle,
  CircleOff
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

import clinicLogo from './assets/logo.png';
import fundusBg from './assets/fundus-bg.png';

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
  getDocs
} from 'firebase/firestore';

const APP_VERSION = "v3.4.0";

// --- Types & Constants ---

enum UserRole {
  ADMIN = 'ADMIN',
  STAFF = 'STAFF'
}

interface User {
  id: string;
  password?: string;
  role: UserRole;

  displayName: string;

  department: 'OPD KKL' | 'PBOA';

  canViewAllDepartments: boolean;

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

interface Appointment {
  id: string;
  firestoreId?: string;
  patientName: string;
  department: 'OPD KKL' | 'PBOA';
  icNumber: string;
  phoneNumber: string;
  date: string;
  remarks: string;

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
  // Clinical Review
  // =========================
  rightEyeReview?: string;
  rightEyeReviewDetails?: {
    status: 'Normal' | 'Abnormal' | '';
    abnormalTypes?: string[];
    npdrSeverity?: 'mild' | 'moderate' | 'severe' | '';
    othersText?: string;
    comment?: string;
  };

  leftEyeReview?: string;
  leftEyeReviewDetails?: {
    status: 'Normal' | 'Abnormal' | '';
    abnormalTypes?: string[];
    npdrSeverity?: 'mild' | 'moderate' | 'severe' | '';
    othersText?: string;
    comment?: string;
  };

  status: AppointmentStatus;
  diseaseTypes: string[];
  otherDisease: string;

  createdBy: string;
  rightEyeUploadedBy?: string;
  leftEyeUploadedBy?: string;

  updatedBy: string;
  createdAt: number;
}

interface ActivityLog {
  action: string;
  patient: string;
  by: string;
  timestamp: number;
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

// --- Main Application ---

export default function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(() => {
    const saved = sessionStorage.getItem('clinic_current_user');
    if (!saved) return null;
    try {
      return JSON.parse(saved);
    } catch (e) {
      console.error("Failed to parse current user", e);
      return null;
    }
  });
  
  const [users, setUsers] = useState<User[]>([
  {
  id: 'admin',
  password: 'cokkodok',
  displayName: 'Administrator',

  role: UserRole.ADMIN,

  department: 'OPD KKL',

  canViewAllDepartments: true,

  createdAt: Date.now()
}
]);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [authMessage, setAuthMessage] = useState('');
  const [tempUserId, setTempUserId] = useState('');
  const [tempPassword, setTempPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [showStaffForm, setShowStaffForm] = useState(false);
  
  const [showAdminConsole, setShowAdminConsole] = useState(false);
  const [newStaffId, setNewStaffId] = useState('');
  const [newStaffName, setNewStaffName] = useState('');
  const [newStaffPass, setNewStaffPass] = useState('');
  const [activityLogs, setActivityLogs] = useState<ActivityLog[]>([]);
  
  const [newStaffDepartment, setNewStaffDepartment] =
  useState<'OPD KKL' | 'PBOA'>('OPD KKL');
  const [newStaffMA, setNewStaffMA] =
  useState(false);

  const [showAccountSettings, setShowAccountSettings] = useState(false);
  const [currentPasswordInput, setCurrentPasswordInput] = useState('');
  const [newPasswordInput, setNewPasswordInput] = useState('');
  const [confirmPasswordInput, setConfirmPasswordInput] = useState('');
  const [newDisplayName, setNewDisplayName] = useState(
  currentUser?.displayName || ''
);

  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [showAccountSuccess, setShowAccountSuccess] = useState(false);
  const [showPboaWarning, setShowPboaWarning] =useState(false);
  const [showActivityLogs, setShowActivityLogs] = useState(false);
  
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [userToDelete, setUserToDelete] = useState<User | null>(null);
  
  
  const [showTCASchedule, setShowTCASchedule] = useState(false);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [selectedPhotoApp, setSelectedPhotoApp] = useState<{app: Appointment, eye: 'right' | 'left'} | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [formIC, setFormIC] = useState('');
  const [formPhone, setFormPhone] = useState('');
  const [formDepartment, setFormDepartment] = useState<'OPD KKL' | 'PBOA'>('OPD KKL');
  const [selectedDate, setSelectedDate] = useState('');
  const [editingAppointment, setEditingAppointment] = useState<Appointment | null>(null);
  const [deletingApp, setDeletingApp] = useState<Appointment | null>(null);
  const [zoomScale, setZoomScale] = useState(1);
  const [uploadingImageId, setUploadingImageId] = useState<string | null>(null);
  const [isSavingReview, setIsSavingReview] = useState(false);
  const [isReviewViewMode, setIsReviewViewMode] = useState(false);
  const [selectedHistory, setSelectedHistory] = useState<Appointment | null>(null);
  const [summaryEye, setSummaryEye] = useState<'right' | 'left'>('right');
  const [selectedReviewSummary, setSelectedReviewSummary] = useState<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [showImageNotObtainable, setShowImageNotObtainable] = useState(false);
        useEffect(() => {
  document.body.style.overflow = showImageNotObtainable
    ? "hidden"
    : "";

  return () => {
    document.body.style.overflow = "";
  };
}, [showImageNotObtainable]);
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
  useEffect(() => {

  const modalOpen =
    showPboaWarning ||
    showTCASchedule ||
    showAdminConsole ||
    showActivityLogs ||
    isFormOpen ||
    !!selectedPhotoApp ||
    !!editingAppointment;

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
  isFormOpen,
  selectedPhotoApp,
  editingAppointment
]);
  // Sync IC and Phone state when opening form
  useEffect(() => {
    if (isFormOpen && editingAppointment) {
      setFormIC(editingAppointment.icNumber);
      setFormPhone(editingAppointment.phoneNumber);
      setFormDepartment(editingAppointment.department || 'OPD KKL'
);
    } else if (isFormOpen) {
  setFormIC('');
  setFormPhone('');

  setFormDepartment(
    currentUser?.department || 'OPD KKL'
  );

  setSelectedDate(todayStr);
}
  }, [isFormOpen, editingAppointment, currentUser]);

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

  const addActivityLog = (action: string, patient: string = 'System', byOverride?: string) => {
    const logEntry: ActivityLog = {
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

  useEffect(() => {

  if (selectedPhotoApp) {

    document.body.style.overflow = 'hidden';

  } else {

    document.body.style.overflow = 'auto';

  }

  return () => {

    document.body.style.overflow = 'auto';

  };

}, [selectedPhotoApp]);
  
  // Calculate Monthly Stats
  const monthlyStats = useMemo(() => {
    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();
    
    const thisMonthApps = appointments.filter(app => {
      if (!app || !app.date) return false;
      const appDate = new Date(app.date);
      const isThisMonth = appDate.getMonth() === currentMonth && appDate.getFullYear() === currentYear;
      const isNotNoShow = app.status !== AppointmentStatus.NO_SHOW;
      return isThisMonth && isNotNoShow;
    });

    return {
      total: thisMonthApps.length,
      // Pending Fundus: Patients with at least one photo missing (excluding no-show)
      fundusPending: thisMonthApps.filter(a => !a.rightEyePhoto || !a.leftEyePhoto).length,
      // Pending Review: Patients who have photos but haven't finished both eye reviews (excluding no-show)
      reviewPending: thisMonthApps.filter(a => (a.rightEyePhoto || a.leftEyePhoto) && (!a.rightEyeReview || !a.leftEyeReview)).length,
      // Overall still in queue (incomplete) (excluding no-show)
      totalPending: thisMonthApps.filter(a => !(a.rightEyePhoto && a.leftEyePhoto && a.rightEyeReview && a.leftEyeReview)).length
    };
  }, [appointments]);

  const monthlyDepartmentStats = useMemo(() => {

  const now = new Date();

  const currentMonth = now.getMonth();
  const currentYear = now.getFullYear();

  const thisMonthApps = appointments.filter(app => {

    if (!app || !app.date) return false;

    const appDate = new Date(app.date);

    return (
      appDate.getMonth() === currentMonth &&
      appDate.getFullYear() === currentYear &&
      app.status !== AppointmentStatus.NO_SHOW
    );

  });

  return {

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

}, [appointments]);

  const yearlyStats = useMemo(() => {
    const currentYear = new Date().getFullYear();

    const thisYearApps = appointments.filter(app => {
      if (!app || !app.date) return false;
      const appDate = new Date(app.date);
      return appDate.getFullYear() === currentYear && app.status !== AppointmentStatus.NO_SHOW;
    });

    return {
      opd:
  thisYearApps.filter(
    a => a.department === 'OPD KKL'
  ).length,

pboa:
  thisYearApps.filter(
    a => a.department === 'PBOA'
  ).length,

reviewPendingOPD:
  thisYearApps.filter(
    a =>
      a.department === 'OPD KKL' &&
      (a.rightEyePhoto || a.leftEyePhoto) &&
      !(a.rightEyeReview && a.leftEyeReview)
  ).length,

reviewPendingPBOA:
  thisYearApps.filter(
    a =>
      a.department === 'PBOA' &&
      (a.rightEyePhoto || a.leftEyePhoto) &&
      !(a.rightEyeReview && a.leftEyeReview)
  ).length,
      total: thisYearApps.length,
      reviewPending: thisYearApps.filter(a => (a.rightEyePhoto || a.leftEyePhoto) && !(a.rightEyeReview && a.leftEyeReview)).length,
      year: currentYear
    };
  }, [appointments]);

  const isAppointmentComplete = (app: Appointment) => {
    if (!app) return false;
    return !!(app.rightEyePhoto && app.leftEyePhoto && app.rightEyeReview && app.leftEyeReview);
  };

  const patientHistory = selectedPhotoApp
  ? appointments.filter(app =>
      app.icNumber === selectedPhotoApp.app.icNumber &&
      app.id !== selectedPhotoApp.app.id
    )
    .sort((a, b) =>
      (b.createdAt || 0) - (a.createdAt || 0)
    )
  : [];

 // Search & Filter State
const [searchQuery, setSearchQuery] = useState('');
const [filterDate, setFilterDate] = useState('');
const [filterStatus, setFilterStatus] = useState<AppointmentStatus | 'All' | 'Active'>('Active');
const [filterReview, setFilterReview] = useState<'All' | 'Pending' | 'Abnormal' | 'Normal'>('All');
const [filterDepartment, setFilterDepartment] =
  useState<'All' | 'OPD KKL' | 'PBOA'>('All');
const [currentPage, setCurrentPage] = useState(1);

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

  // Realtime Firestore Sync
const unsubscribe = onSnapshot(
  collection(db, "appointments"),
  (snapshot) => {

    const firestoreApps = snapshot.docs.map(docSnapshot => ({
  firestoreId: docSnapshot.id,
  ...docSnapshot.data()
})) as Appointment[];

    if (firestoreApps.length > 0) {
      setAppointments(firestoreApps);
    }

  }
);


// Realtime Users Sync
const unsubscribeUsers = onSnapshot(
  collection(db, "users"),
  (snapshot) => {

    let firestoreUsers = snapshot.docs.map(doc => ({
      firestoreId: doc.id,
      ...doc.data()
    })) as User[];

    const hasAdmin = firestoreUsers.some(
      u => u.id === 'admin'
    );

    if (!hasAdmin) {

      firestoreUsers.unshift({
        id: 'admin',
        password: 'cokkodok',
        displayName: 'Administrator',
        role: UserRole.ADMIN,
        createdAt: Date.now()
      });

    }

    console.log("USERS SYNC", firestoreUsers);

    setUsers(firestoreUsers);

  }
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
      ...docSnapshot.data()
    })) as ActivityLog[];

    setActivityLogs(firestoreActivityLogs);

  }
);

return () => {
  unsubscribe();
  unsubscribeUsers();
  unsubscribeActivityLogs();
};

}, []);


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

}, [appointments]);


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


// AUTO LOGOUT AFTER 1 HOUR IDLE
useEffect(() => {

  let timeout: NodeJS.Timeout;

  const resetTimer = () => {

    clearTimeout(timeout);

    timeout = setTimeout(() => {

      sessionStorage.removeItem('clinic_current_user');

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
      u =>
        u.id.toLowerCase() === id &&
        u.password === pass
    );

    if (user) {

      setCurrentUser(user);
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

      setCurrentUser(null);

      setTempUserId('');
      setTempPassword('');

      setIsAuthenticating(false);

    }, 1200);

  }, 1200);

};

const addStaffMember = (e: React.FormEvent) => {

  e.preventDefault();

  if (
    !newStaffId.trim() ||
    !newStaffPass.trim() ||
    !newStaffName.trim()
  ) return;

  const id = newStaffId.trim().toUpperCase();

  if (users.some(u => u.id === id)) {

    alert('User ID already exists');

    return;

  }

  const newUser: User = {
  id,
  password: newStaffPass,
  displayName: newStaffName.trim(),
  role: UserRole.STAFF,

  department: newStaffDepartment,

  canViewAllDepartments: newStaffMA,

  createdAt: Date.now()
};

  addDoc(
    collection(db, "users"),
    newUser
  );

  addActivityLog('Created Staff Account', `${newUser.displayName} (${newUser.id})`);

  setNewStaffId('');
  setNewStaffName('');
  setNewStaffPass('');

};
  
const updateStaffMember = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;
    
    if (!editingUser?.firestoreId) return;

updateDoc(
  doc(db, "users", editingUser.firestoreId),
  {
    ...editingUser
  }
);

    addActivityLog('Updated Staff Account', `${editingUser.displayName} (${editingUser.id})`);
    
    // If current user is editing themselves, update current user state too
    if (currentUser && currentUser.id === editingUser.id) {
      setCurrentUser(editingUser);
    }
    
    setEditingUser(null);
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
  
  const uploadToCloudinary = async (file: File) => {

  const formData = new FormData();

  formData.append("file", file);
  formData.append("upload_preset", "fundus_upload");

  const response = await fetch(
    "https://api.cloudinary.com/v1_1/dkz7ubrr8/image/upload",
    {
      method: "POST",
      body: formData
    }
  );

  const data = await response.json();

console.log(data);

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

    console.log(appToUpdate);

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

    const hasPhotos =
      appToUpdate.rightEyePhoto &&
      appToUpdate.leftEyePhoto;

    const hasReviews =
      rightDetails?.status &&
      leftDetails?.status;

    let nextStatus =
      AppointmentStatus.DONE_REVIEW;

    if (hasPhotos && hasReviews) {
      nextStatus = AppointmentStatus.DONE;
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
        isEdited:
  isEditedReview

      }
    );

    addActivityLog(
      isEditedReview ? 'Edited Clinical Review' : 'Saved Clinical Review',
      appToUpdate.patientName || '-'
    );

    setIsReviewViewMode(true);

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
    const rows = appointments.filter(app => !!app).map(app => [
      app.date || '',
      app.patientName || '',
      app.icNumber || '',
      app.phoneNumber || '',
      (app.diseaseTypes || []).join('; ') + (app.otherDisease ? `; ${app.otherDisease}` : ''),
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
    link.setAttribute("download", `Klinik_Kesihatan_Lintang_Fundus_Report_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    addActivityLog('Exported Monthly Summary CSV', `${appointments.length} records`);
  };

  const upsertAppointment = async (
  data: Partial<Appointment>
) => {

  try {
// ===== PBOA RULES =====
if (!editingAppointment && formDepartment === 'PBOA') {

  const selectedDate = new Date(data.date || '');

  // Friday only
  if (selectedDate.getDay() !== 5) {

    alert(
      'PBOA appointments can only be scheduled on Fridays.'
    );

    return;
  }

  // Check slot count
  const pboaCount = appointments.filter(
    app =>
      app.department === 'PBOA' &&
      app.date === data.date
  ).length;

  if (pboaCount >= PBOA_LIMIT) {

    alert(
      `PBOA slot is full for ${data.date}. Please select the next available Friday.`
    );

    return;
  }

}
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
    department: formDepartment
  }
);

      addActivityLog('Updated Appointment', data.patientName || editingAppointment.patientName || '-');

    } else {

      const newApp: Appointment = {

        id: Math.random()
          .toString(36)
          .substr(2, 9),

        patientName:
          data.patientName || '',

        icNumber:
          data.icNumber || '',

        phoneNumber:
          data.phoneNumber || '',

        department: formDepartment,

        date:
          data.date || '',

        remarks:
          data.remarks || '',

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

  }

};

  const confirmDelete = (app: Appointment) => {
    setDeletingApp(app);
  };

  const deleteAppointment = async (
  id: string
) => {

  try {

    const appToDelete = appointments.find(
      app =>
        app.id === id ||
        app.firestoreId === id
    );

    if (!appToDelete?.firestoreId) return;

    await deleteDoc(
      doc(
        db,
        "appointments",
        appToDelete.firestoreId
      )
    );

    addActivityLog('Deleted Appointment', appToDelete.patientName || '-');

    setDeletingApp(null);

  } catch (e) {

    console.error(
      "Failed to delete appointment",
      e
    );

  }

};

const saveImageNotObtainable = async () => {

  if (!selectedUnableApp?.firestoreId) return;

  try {

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

if (rightCompleted && leftCompleted) {
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
    return appointments
  .filter(app => {

    // ADMIN nampak semua
    if (currentUser?.role === UserRole.ADMIN) {
      return true;
    }

    // MA nampak semua
    if (currentUser?.canViewAllDepartments) {
      return true;
    }

    // Staff biasa ikut department
    return (
      app.department ===
      currentUser?.department
    );

  })
  .filter(app => {
        if (!app) return false;
        const patientName = app.patientName || '';
        const icNumber = app.icNumber || '';
        
        const q = searchQuery.toLowerCase();
        const matchesSearch = 
          patientName.toLowerCase().includes(q) ||
          icNumber.includes(searchQuery);
        const matchesDate = !filterDate || app.date === filterDate;
        const today = new Date();
today.setHours(23,59,59,999);

const appointmentDate = new Date(app.date);

const matchesStatus = true;
        
        const hasPhotos = !!(app.rightEyePhoto || app.leftEyePhoto);
        const hasBothReviews = !!(app.rightEyeReview && app.leftEyeReview);
        const isAbnormal = app.rightEyeReviewDetails?.status === 'Abnormal' || app.leftEyeReviewDetails?.status === 'Abnormal';
        const isNormal = hasBothReviews && app.rightEyeReviewDetails?.status === 'Normal' && app.leftEyeReviewDetails?.status === 'Normal';
        
        const matchesReview = filterReview === 'All' || 
          (filterReview === 'Pending' && hasPhotos && !hasBothReviews) ||
          (filterReview === 'Abnormal' && isAbnormal) ||
          (filterReview === 'Normal' && isNormal);
        
          const matchesDepartment =
  filterDepartment === 'All' ||
  app.department === filterDepartment;
        return (
  matchesSearch &&
  matchesDate &&
  matchesStatus &&
  matchesReview &&
  matchesDepartment
);
      })
      .sort((a, b) => {

  if (filterStatus === 'All') {

    const dateCompare = b.date.localeCompare(a.date);

    if (dateCompare !== 0) {
      return dateCompare;
    }

    return (b.createdAt || 0) - (a.createdAt || 0);
  }

  return (b.createdAt || 0) - (a.createdAt || 0);

});
  }, [
  appointments,
  currentUser,
  searchQuery,
  filterDate,
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

  const allTodayAppointments = useMemo(() => {

  return appointments

    .filter(app => {

      if (currentUser?.role === UserRole.ADMIN)
        return true;

      if (currentUser?.canViewAllDepartments)
        return true;

      return (
        app.department ===
        currentUser?.department
      );

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

  const todayDepartmentStats = useMemo(() => {

  const todayApps = appointments.filter(
    app => app && isToday(app.date)
  );

  return {
    opd: todayApps.filter(
      app => app.department === 'OPD KKL'
    ).length,

    pboa: todayApps.filter(
      app => app.department === 'PBOA'
    ).length
  };

}, [appointments]);

const tcaSchedule = useMemo(() => {

  const today = new Date();

  const grouped: Record<
    string,
    {
      opd: number;
      pboa: number;
      total: number;
    }
  > = {};

  appointments
    .filter(
      app =>
        new Date(app.date) >= today
    )
    .forEach(app => {

      if (!grouped[app.date]) {

        grouped[app.date] = {
          opd: 0,
          pboa: 0,
          total: 0
        };

      }

      if (
        app.department ===
        'OPD KKL'
      ) {

        grouped[app.date].opd++;

      }

      if (
        app.department ===
        'PBOA'
      ) {

        grouped[app.date].pboa++;

      }

      grouped[app.date].total++;

    });

  return Object.entries(grouped)
    .sort(
      ([a], [b]) =>
        new Date(a).getTime() -
        new Date(b).getTime()
    );

}, [appointments]);

const tomorrowTCA = useMemo(() => {

  const tomorrow = new Date();

  tomorrow.setDate(
    tomorrow.getDate() + 1
  );

  const tomorrowStr =
    tomorrow.toLocaleDateString('en-CA');

  return {

    opd: appointments.filter(
      app =>
        app.date === tomorrowStr &&
        app.department === 'OPD KKL'
    ).length,

    pboa: appointments.filter(
      app =>
        app.date === tomorrowStr &&
        app.department === 'PBOA'
    ).length

  };

}, [appointments]);

  // --- Views ---

  if (!currentUser) {
    return (
  <>
  {isAuthenticating && (

  <div className="fixed inset-0 z-[99999] bg-black/30 backdrop-blur-sm flex items-center justify-center">

    <div className="bg-white/95 backdrop-blur-xl rounded-2xl px-8 py-7 shadow-2xl flex flex-col items-center w-[300px] border border-white/40">

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
            <div className="w-24 h-24 rounded-full overflow-hidden border-4 border-white shadow-xl mb-6 ring-1 ring-slate-100">
              <img 
                src={clinicLogo} 
                alt="Klinik Kesihatan Lintang Logo"
                className="w-full h-full object-cover"
                
              />
            </div>
            <h1 className="text-2xl font-black text-slate-900 tracking-tight text-center">Klinik Kesihatan Lintang</h1>
            <p className="text-blue-600 font-bold text-[10px] uppercase tracking-[0.2em] mt-1">Fundus Screening System</p>
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

            <div className="space-y-1.5">
              <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Password</label>
              <div className="relative">
                <Lock size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-300" />
                <input 
                  type="password" 
                  autoComplete="new-password"
                  required
                  className="w-full pl-12 pr-4 py-4 rounded-xl border border-slate-400 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all outline-none text-sm font-medium text-slate-800"
                  placeholder="••••••"
                  value={tempPassword}
                  onChange={e => setTempPassword(e.target.value)}
                />
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

    <div className="bg-white rounded-2xl shadow-2xl p-6 w-[350px]">

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

    <div className="bg-white/95 backdrop-blur-xl rounded-2xl px-8 py-7 shadow-2xl flex flex-col items-center w-[300px] border border-white/40">

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

    <div className="bg-white rounded-3xl shadow-2xl w-[92vw] max-w-[500px] max-h-[70vh] overflow-y-auto">

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

      <div className="p-5 space-y-3">

        {tcaSchedule.length === 0 ? (

          <div className="text-center py-6 md:py-10 text-slate-400 font-medium">
  No upcoming appointments
</div>

        ) : (

          tcaSchedule.map(([date, stats]) => {

            return (

              <div
                key={date}
                className="border border-slate-200 rounded-2xl p-4 md:p-5"
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

      const today = new Date();

      const nextWeek = new Date();

      nextWeek.setDate(
        today.getDate() + 7
      );

      const currentDate =
        new Date(date);

      return (
        currentDate > today &&
        currentDate <= nextWeek
      );

    })() &&

    date !== (() => {

      const tomorrow = new Date();

      tomorrow.setDate(
        tomorrow.getDate() + 1
      );

      return tomorrow.toLocaleDateString('en-CA');

    })() && (

      <span className="bg-sky-100 text-sky-700 border border-sky-300 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-wide whitespace-nowrap">
        📅 THIS WEEK
      </span>

    )}

  </div>

</div>

                    <div className="mt-2 space-y-1">

  <p className="text-xs font-semibold text-sky-600">
    OPD KKL : {stats.opd} Patients
  </p>

  <p className="text-xs font-semibold text-emerald-600">
    PBOA : {stats.pboa} Patients
  </p>

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
            <div className="w-10 h-10 rounded-full overflow-hidden border-2 border-slate-100 shadow-sm bg-white shrink-0">
              <img 
                src={clinicLogo} 
                alt="Klinik Kesihatan Lintang Logo"
                className="w-full h-full object-cover"
              
              />
            </div>
            <div className="flex flex-col">
              <span className="font-black text-base md:text-lg leading-none tracking-tighter text-slate-900">Klinik Kesihatan Lintang</span>
              <span className="text-[10px] font-bold text-blue-600 uppercase tracking-widest mt-0.5">Fundus Clinic</span>
            </div>
          </div>
          
         <div className="w-full md:w-auto flex items-center justify-between md:justify-end gap-2 md:gap-3 flex-wrap">

  {currentUser.role === UserRole.ADMIN && (

    <>

      <button 
  onClick={() => setShowAdminConsole(true)}
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
            <div className="flex flex-col items-end mr-1 md:mr-2">
              <span className="text-sm font-semibold text-slate-700">{currentUser.displayName}</span>
              <span className="text-[11px] font-black text-emerald-600 uppercase tracking-widest">
  {currentUser.department}
</span>
              <span className="text-[10px] text-slate-400 uppercase tracking-widest font-bold">{currentUser.role} Account ({currentUser.id})</span>
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
      </header>

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

    {/* OPD + PBOA */}
    <div className="flex flex-col items-center gap-2">

      <div className="text-center">
        <p className="text-[9px] font-black text-sky-600 uppercase">
          OPD
        </p>
        <p className="text-lg font-black text-sky-600 leading-none">
          {yearlyStats.opd}
        </p>
      </div>

      <div className="text-center">
        <p className="text-[9px] font-black text-emerald-600 uppercase">
          PBOA
        </p>
        <p className="text-lg font-black text-emerald-600 leading-none">
          {yearlyStats.pboa}
        </p>
      </div>

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

    {/* OPD + PBOA */}
    <div className="flex flex-col items-center gap-2">

      <div className="text-center">
        <p className="text-[9px] font-black text-sky-600 uppercase">
          OPD
        </p>
        <p className="text-lg font-black text-sky-600 leading-none">
          {yearlyStats.reviewPendingOPD}
        </p>
      </div>

      <div className="text-center">
        <p className="text-[9px] font-black text-emerald-600 uppercase">
          PBOA
        </p>
        <p className="text-lg font-black text-emerald-600 leading-none">
          {yearlyStats.reviewPendingPBOA}
        </p>
      </div>

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

    <div className="flex items-center justify-between gap-4">

      <div>
        <h2 className="text-sm font-bold text-blue-600 uppercase tracking-widest mb-1">
          Monthly Analytics
        </h2>

        <p className="text-slate-500 text-sm font-bold">
  {new Date().toLocaleString('en-US', {
    month: 'long',
    year: 'numeric'
  })}
</p>
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
        
        {/* Today's Quick Section */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <Clock size={20} className="text-blue-600" />
              <h2 className="text-lg font-bold text-slate-800 tracking-tight">Today's Queue</h2>
              <div className="flex flex-wrap items-center gap-2">
                <span className="bg-blue-600 text-white px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-tighter shadow-sm">
                  {allTodayAppointments.length} Total Cases
                </span>
                <span className="bg-slate-100 text-slate-600 px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-tighter">
                  {todayAppointments.length} Active
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2 ml-2">

  <span className="bg-sky-100 text-sky-700 px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-tighter border border-sky-200">
    OPD KKL: {todayDepartmentStats.opd}
  </span>

  <span className="bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-tighter border border-emerald-200">
    PBOA: {todayDepartmentStats.pboa}
  </span>

  {(tomorrowTCA.opd > 0 || tomorrowTCA.pboa > 0) && (

    <div className="md:hidden flex items-center gap-1 bg-amber-50 border border-amber-200 px-2 py-1 rounded-lg">

      <span>🔔</span>

      <div className="w-5 h-5 rounded-full bg-sky-500 text-white flex items-center justify-center text-[10px] font-black">
        O
      </div>

      <span className="text-xs font-black">
        {tomorrowTCA.opd}
      </span>

      <div className="w-5 h-5 rounded-full bg-emerald-500 text-white flex items-center justify-center text-[10px] font-black">
        P
      </div>

      <span className="text-xs font-black">
        {tomorrowTCA.pboa}
      </span>

    </div>

  )}

</div>

            </div>
            <div className="flex flex-wrap items-center gap-2">

  {(tomorrowTCA.opd > 0 ||
    tomorrowTCA.pboa > 0) && (

    <div className="hidden md:flex items-center gap-2 bg-amber-50 border border-amber-200 px-3 py-2 rounded-lg">

      <span className="text-amber-600">
        🔔
      </span>

      <span className="hidden md:inline text-xs font-bold text-slate-700">
        Tomorrow's TCA
      </span>

      <div className="flex items-center gap-1">

  <div className="w-5 h-5 rounded-full bg-sky-500 text-white flex items-center justify-center text-[10px] font-black">
    O
  </div>

  <span className="text-xs font-black text-slate-700">
    {tomorrowTCA.opd}
  </span>

</div>

<div className="flex items-center gap-1">

  <div className="w-5 h-5 rounded-full bg-emerald-500 text-white flex items-center justify-center text-[10px] font-black">
    P
  </div>

  <span className="text-xs font-black text-slate-700">
    {tomorrowTCA.pboa}
  </span>

</div>

    </div>

  )}

  <button
    onClick={() => setShowTCASchedule(true)}
    className="bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 px-4 py-2 rounded-lg flex items-center gap-2 text-sm font-semibold shadow-sm transition-all"
  >
    <Calendar size={18} />
    TCA Schedule
  </button>

  <button
    onClick={() => setIsFormOpen(true)}
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
                                onClick={() => setSelectedPhotoApp({ app, eye: eye as any })} 
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

    <span
      className={`text-[8px] px-2 py-[1px] rounded-full font-black border uppercase ${
        app.department === 'OPD KKL'
          ? 'bg-sky-50 text-sky-700 border-sky-200'
          : 'bg-emerald-50 text-emerald-700 border-emerald-200'
      }`}
    >
      {app.department === 'OPD KKL' ? 'OPD' : 'PBOA'}
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
                  <p className="text-[10px] font-mono font-medium text-slate-500 mb-4">{app.icNumber}</p>

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
                           (app.rightEyeReview && app.leftEyeReview)
                             ? 'bg-indigo-50 text-indigo-600 border border-indigo-100'
                             : 'bg-slate-900 text-white shadow-lg shadow-slate-200 hover:bg-black'
                         }`}
                       >
                         { (app.rightEyeReview && app.leftEyeReview) ? <CheckCircle2 size={12} /> : <Search size={12} /> }
                         { (app.rightEyeReview && app.leftEyeReview) ? 'Review Complete' : 'Perform Clinical Review' }
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
            <div className="relative w-full sm:flex-1">
              <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input 
                type="text" 
                placeholder="Search Patient or IC..." 
                className="w-full pl-10 pr-4 py-2 bg-white border border-slate-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
              />
            </div>
            
            <div className="grid grid-cols-1 sm:flex sm:flex-wrap items-center gap-2">
              <button 
                onClick={exportToCSV}
                className="w-full sm:w-auto justify-center bg-slate-900 border border-slate-800 hover:bg-black text-white px-3 py-2 rounded-xl text-xs font-bold flex items-center gap-2 transition-all shadow-md hover:shadow-xl active:scale-95"
              >
                 <Download size={14} />
                 Generate Monthly Summary (CSV)
              </button>

              <div className="flex items-center gap-2 bg-white border border-slate-200 rounded-lg px-3 py-1.5">
                <Calendar size={16} className="text-slate-400" />
                <input 
                  type="date" 
                  className="bg-transparent border-none outline-none text-xs font-medium"
                  value={filterDate}
                  onChange={e => setFilterDate(e.target.value)}
                />
              </div>

              <div className="flex items-center gap-2 bg-white border border-slate-200 rounded-lg px-3 py-1.5">
                <Filter size={16} className="text-slate-400" />
                <select 
                  className="bg-transparent border-none outline-none text-xs font-medium appearance-none"
                  value={filterStatus}
                  onChange={e => setFilterStatus(e.target.value as any)}
                >
                  <option value="Active">Active Queue</option>
                  <option value="All">All Records</option>
                </select>
              </div>

              <div className="flex items-center gap-2 bg-white border border-slate-200 rounded-lg px-3 py-1.5">
  <ShieldCheck size={16} className="text-blue-500" />
  <select
    className="bg-transparent border-none outline-none text-xs font-medium appearance-none cursor-pointer"
    value={filterReview}
    onChange={e => setFilterReview(e.target.value as any)}
  >
    <option value="All">All Reviews (Any)</option>
    <option value="Pending">Pending Review</option>
    <option value="Abnormal">Abnormal Findings</option>
    <option value="Normal">Normal Findings</option>
  </select>
</div>

{(currentUser?.role === UserRole.ADMIN ||
  currentUser?.canViewAllDepartments) && (
  <div className="flex items-center gap-2 bg-white border border-slate-200 rounded-lg px-3 py-1.5">
    <Users size={16} className="text-emerald-500" />

    <select
      className="bg-transparent border-none outline-none text-xs font-medium appearance-none cursor-pointer"
      value={filterDepartment}
      onChange={(e) =>
        setFilterDepartment(
          e.target.value as 'All' | 'OPD KKL' | 'PBOA'
        )
      }
    >
      <option value="All">All Departments</option>
      <option value="OPD KKL">OPD KKL</option>
      <option value="PBOA">PBOA</option>
    </select>
  </div>
)}
              
              {(searchQuery || filterDate || filterStatus !== 'Active' || filterReview !== 'All') && (
                <button 
                  onClick={() => { setSearchQuery(''); setFilterDate(''); setFilterStatus('Active'); setFilterReview('All'); setFilterDepartment('All'); }}
                  className="text-xs text-blue-600 font-bold hover:underline px-2"
                >
                  Clear Filters
                </button>
              )}
            </div>
          </div>

          {/* Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse min-w-[950px] md:min-w-[800px]">
              <thead className="bg-slate-50/80 backdrop-blur-sm">
                <tr className="border-b border-slate-200 bg-slate-200">
                  <th className="px-3 md:px-6 py-3 md:py-4 text-[10px] font-bold text-slate-400 uppercase tracking-wider">RE / LE Photos</th>
                  <th className="px-3 md:px-6 py-3 md:py-4 text-[10px] font-bold text-slate-400 uppercase tracking-wider">Patient Details</th>
                  <th className="px-3 md:px-6 py-3 md:py-4 text-[10px] font-bold text-slate-400 uppercase tracking-wider">Input By</th>
                  <th className="px-3 md:px-6 py-3 md:py-4 text-[10px] font-bold text-slate-400 uppercase tracking-wider">Schedule</th>
                  <th className="px-3 md:px-6 py-3 md:py-4 text-[10px] font-bold text-slate-400 uppercase tracking-wider">Status</th>
                  <th className="px-3 md:px-6 py-3 md:py-4 text-[10px] font-bold text-slate-400 uppercase tracking-wider">Fundus Actions</th>
                  <th className="px-3 md:px-6 py-3 md:py-4 text-[10px] font-bold text-slate-400 uppercase tracking-wider">Review Findings</th>
                  <th className="px-3 md:px-6 py-3 md:py-4 text-[10px] font-bold text-slate-400 uppercase tracking-wider text-right">Options</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                <AnimatePresence>
                  {paginatedAppointments.map((app) => {
                    // Calculate queue number for that specific day
                    const sameDayApps = appointments
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
  className={`group hover:bg-slate-50 transition-colors border-l-4 ${
    
    app.department === 'OPD KKL'
      ? 'border-l-sky-500'
      : 'border-l-emerald-500'

  } ${
    (app.status === AppointmentStatus.DONE || app.status === AppointmentStatus.DONE_REVIEW)
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
                          <div className="flex gap-2">
                            {['right', 'left'].map(eye => {
                              const photo = eye === 'right' ? app.rightEyePhoto : app.leftEyePhoto;
                              return (
                                    <div key={eye} className="relative w-10 h-10 group/photo">
                                      {photo ? (
                                        <>
                                          <button 
                                            onClick={() => setSelectedPhotoApp({ app, eye: eye as any })} 
                                            className="w-full h-full rounded-lg border border-slate-200 overflow-hidden hover:ring-2 hover:ring-blue-500 transition-all bg-white"
                                          >
                                            <img src={photo} className="w-full h-full object-cover" alt="" />
                                          </button>
                                          <button 
                                            onClick={() => removeImage(app.id, eye as any)}
                                            className="absolute -top-1 -right-1 bg-rose-500 text-white rounded-full p-0.5 opacity-0 group-hover/photo:opacity-100 transition-opacity shadow-sm z-10"
                                          >
                                            <XCircle size={10} />
                                          </button>
                                        </>
                                      ) : (
                                        <label className="w-full h-full bg-slate-100 border border-dashed border-slate-300 rounded-lg flex flex-col items-center justify-center text-slate-400 cursor-pointer hover:bg-slate-200 transition-colors">
                                          <Plus size={14} />
                                          <span className="text-[7px] font-bold uppercase">{eye === 'right' ? 'RE' : 'LE'}</span>
                                          <input 
                                            type="file" 
                                            className="hidden" 
                                            accept="image/*" 
                                            onChange={(e) => handleImageUpload(app.id, eye as any, e)}
                                          />
                                        </label>
                                      )}
                                    </div>
                              );
                            })}
                          </div>
                          {(app.rightEyeUploadedBy || app.leftEyeUploadedBy) && (
                            <div className="flex flex-col items-center mt-1">
                              <span className="text-[8px] text-slate-400 font-bold uppercase tracking-tighter leading-none">
                                DONE BY:
                              </span>
                              <span className="text-xs text-slate-500 font-black uppercase tracking-tighter mt-0.5">
                                {getUserDisplayName(app.rightEyeUploadedBy || app.leftEyeUploadedBy || '')}
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
  className={`text-[8px] px-2 py-[1px] rounded font-black border uppercase ${
    app.department === 'OPD KKL'
      ? 'bg-sky-50 text-sky-700 border-sky-200'
      : 'bg-emerald-50 text-emerald-700 border-emerald-200'
  }`}
>
  {app.department}
</span>
                          </div>
                          <span className="text-[9px] md:text-[10px] font-mono text-slate-400 mt-1">
  IC: {app.icNumber}
</span>

<span className="text-[10px] md:text-xs text-slate-500 mt-1 flex items-center gap-1">
  <Phone size={10} /> {app.phoneNumber}
</span>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex flex-col">
                          <span className="text-sm font-black text-slate-800 uppercase tracking-tighter">{getUserDisplayName(app.createdBy)}</span>
                          <span className="text-[9px] text-slate-400 font-bold uppercase">{app.createdBy}</span>
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
                      <td className="px-6 py-4">
  <div className="flex flex-col gap-1">

    <div className="flex gap-2">
      <StatusBadge status={app.status} />
    </div>

    {(app.status === AppointmentStatus.DONE ||
      app.status === AppointmentStatus.DONE_REVIEW) && (
      <div className="flex flex-col mt-1">

        <span className="text-[8px] text-slate-400 font-bold uppercase tracking-tighter leading-none">
  {app.isEdited ? 'REVIEW EDITED BY:' : 'REVIEW BY:'}
</span>

        <span className="text-xs text-slate-500 font-black uppercase tracking-tighter mt-0.5">
          {getUserDisplayName(app.updatedBy || '')}
        </span>

      </div>
    )}

  </div>
</td>
                      <td className="px-6 py-4">
                        <div className="flex flex-wrap items-center gap-2">
                           <div className="flex gap-1">
                             <button 
                               onClick={() => {
                                 const input = document.createElement('input');
                                 input.type = 'file';
                                 input.accept = 'image/*';
                                 input.onchange = (e) => handleImageUpload(app.id, 'right', e as any);
                                 input.click();
                               }}
                               className={`px-2 py-1.5 rounded-lg text-[9px] font-bold uppercase transition-all flex items-center gap-1 ${
                                 app.rightEyePhoto
                                   ? 'bg-emerald-50 text-emerald-600 border border-emerald-100 hover:bg-emerald-600 hover:text-white'
                                   : 'bg-blue-600 text-white shadow hover:bg-blue-700'
                               }`}
                             >
                               { app.rightEyePhoto ? <CheckCircle2 size={10} /> : <Plus size={10} /> }
                               RE
                             </button>
                             <button 
                               onClick={() => {
                                 const input = document.createElement('input');
                                 input.type = 'file';
                                 input.accept = 'image/*';
                                 input.onchange = (e) => handleImageUpload(app.id, 'left', e as any);
                                 input.click();
                               }}
                               className={`px-2 py-1.5 rounded-lg text-[9px] font-bold uppercase transition-all flex items-center gap-1 ${
                                 app.leftEyePhoto
                                   ? 'bg-emerald-50 text-emerald-600 border border-emerald-100 hover:bg-emerald-600 hover:text-white'
                                   : 'bg-blue-600 text-white shadow hover:bg-blue-700'
                               }`}
                             >
                               { app.leftEyePhoto ? <CheckCircle2 size={10} /> : <Plus size={10} /> }
                               LE
                             </button>
                           </div>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex flex-col gap-3 min-w-[200px]">
                          {(app.rightEyePhoto || app.leftEyePhoto) && (
                            <button 
                              onClick={() => {

  const isReviewed =
    app.rightEyeReview ||
    app.leftEyeReview;

  if (isReviewed) {

    document.body.style.overflow = 'hidden';

setSelectedReviewSummary(app);

  } else {

    setSelectedPhotoApp({
      app,
      eye: app.rightEyePhoto ? 'right' : 'left'
    });

  }

}}
                              className={`w-full py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2 border ${
                                (app.rightEyeReview && app.leftEyeReview)
                                  ? 'bg-emerald-50 text-emerald-600 border-emerald-100 hover:bg-emerald-600 hover:text-white'
                                  : 'bg-blue-600 text-white border-blue-700 shadow-lg shadow-blue-100 hover:bg-blue-700'
                              }`}
                            >
                              <CheckCircle2 size={14} />
                              Clinical Review
                            </button>
                          )}
                          
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
                                      <span className={`text-[10px] font-bold ${details?.status === 'Abnormal' ? 'text-rose-600' : 'text-emerald-600'} uppercase leading-none`}>
                                        {details?.status || 'REVIEWED'}
                                      </span>
                                      {details?.status === 'Abnormal' && details?.abnormalTypes && details.abnormalTypes.length > 0 && (
                                        <span className="text-[8px] font-medium text-slate-500 uppercase truncate">
                                          {details.abnormalTypes.join(', ')}
                                        </span>
                                      )}
                                    </>
                                  ) : (
                                    <span className="text-[9px] text-slate-300 italic font-medium uppercase tracking-tighter">Pending</span>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <div className="flex justify-end gap-2 md:opacity-0 group-hover:opacity-100 transition-opacity">
                          <button 
                            onClick={() => { setEditingAppointment(app); setIsFormOpen(true); }}
                            className="p-2 text-slate-500 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                            title="Edit"
                          >
                            <Edit2 size={18} />
                          </button>
                          <button 
                            onClick={() => confirmDelete(app)}
                            className="p-2 text-slate-500 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors group/del"
                            title="Delete Patient Record"
                          >
                            <Trash2 size={18} className="group-hover/del:scale-110 transition-transform" />
                          </button>
                        </div>
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

        <div className="text-center py-3 flex flex-col">
  
  <span className="text-[10px] text-slate-500 font-bold tracking-widest uppercase">
    Fundus Klinik Kesihatan Lintang • {APP_VERSION}
  </span>

  <span className="text-[9px] text-slate-400 font-semibold tracking-wide mt-1">
    Created by Azairi
  </span>

</div>
      </main>

      {/* Staff Management Console */}
      <AnimatePresence>
        {showAdminConsole && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowAdminConsole(false)}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-2xl bg-white rounded-3xl shadow-2xl flex flex-col max-h-[70vh] md:max-h-[80vh]"
            >
              <div className="p-6 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-blue-600 rounded-xl">
                    <Users size={20} className="text-white" />
                  </div>
                  <div>
                    <h2 className="text-lg font-black text-slate-800 leading-none">Clinical Staff Management</h2>
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">Authorized Admin Console</p>
                  </div>
                </div>
                <button 
                  onClick={() => {

  setShowAdminConsole(false);

  setEditingUser(null);

  setNewStaffId('');
  setNewStaffName('');
  setNewStaffPass('');

}}
                  className="p-2 hover:bg-slate-200 rounded-xl transition-colors text-slate-400"
                >
                  <XCircle size={24} />
                </button>
              </div>

              <div className="p-4 md:p-6 space-y-4 md:space-y-8 overflow-y-auto">
                {/* Add/Edit Staff Form */}
                <section>

  <button
    type="button"
    onClick={() => setShowStaffForm(!showStaffForm)}
    className="w-full flex items-center justify-between mb-4"
  >
    <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-2">
      {editingUser ? <Edit2 size={14} className="text-blue-500" /> : <UserPlus size={14} className="text-blue-500" />}
      {editingUser ? `Editing Account: ${editingUser.id}` : 'Register New Clinical Staff'}
    </h3>

    {!editingUser && (
      <span className="text-xs font-bold text-blue-600">
        {showStaffForm ? 'Hide' : 'Show'}
      </span>
    )}
  </button>

  {(showStaffForm || editingUser) && (

  <form
  onSubmit={editingUser ? updateStaffMember : addStaffMember}
  className="bg-blue-50/50 p-3 md:p-4 rounded-2xl border border-blue-100"
>

  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">

    <div className="space-y-1">
      <label className="text-[9px] font-bold text-blue-600 uppercase ml-1">
        Staff User ID
      </label>

      <input
        type="text"
        required
        disabled={!!editingUser}
        className="w-full px-4 py-2.5 rounded-xl border border-blue-200 focus:ring-2 focus:ring-blue-500 outline-none text-sm font-bold disabled:bg-slate-100 disabled:text-slate-500"
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
      <label className="text-[9px] font-bold text-blue-600 uppercase ml-1">
        Password
      </label>

      <input
        type="text"
        required
        className="w-full px-4 py-2.5 rounded-xl border border-blue-200 focus:ring-2 focus:ring-blue-500 outline-none text-sm font-medium"
        value={editingUser ? editingUser.password : newStaffPass}
        onChange={e =>
          editingUser
            ? setEditingUser({
                ...editingUser,
                password: e.target.value
              })
            : setNewStaffPass(e.target.value)
        }
      />
    </div>

    <div className="space-y-1">
      <label className="text-[9px] font-bold text-blue-600 uppercase ml-1">
        Display Name
      </label>

      <input
        type="text"
        required
        placeholder="e.g. Dr. Johny"
        className="w-full px-4 py-2.5 rounded-xl border border-blue-200 focus:ring-2 focus:ring-blue-500 outline-none text-sm font-medium"
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
      <label className="text-[9px] font-bold text-blue-600 uppercase ml-1">
        Department
      </label>

      <select
        value={
          editingUser
            ? editingUser.department
            : newStaffDepartment
        }
        onChange={(e) => {

          const value =
            e.target.value as
              | 'OPD KKL'
              | 'PBOA';

          editingUser
            ? setEditingUser({
                ...editingUser,
                department: value
              })
            : setNewStaffDepartment(value);

        }}
        className="w-full px-4 py-2.5 rounded-xl border border-blue-200 focus:ring-2 focus:ring-blue-500 outline-none text-sm font-medium bg-white"
      >
        <option value="OPD KKL">
          OPD KKL
        </option>

        <option value="PBOA">
          PBOA
        </option>
      </select>
    </div>

    <div className="space-y-1">
      <label className="text-[9px] font-bold text-blue-600 uppercase ml-1">
        Access Level
      </label>

      <label className="flex items-center gap-3 px-4 py-3 rounded-xl border border-blue-200 bg-white cursor-pointer hover:bg-blue-50 transition h-[46px]">

        <input
          type="checkbox"
          checked={
            editingUser
              ? editingUser.canViewAllDepartments
              : newStaffMA
          }
          onChange={(e) => {

            editingUser
              ? setEditingUser({
                  ...editingUser,
                  canViewAllDepartments:
                    e.target.checked
                })
              : setNewStaffMA(
                  e.target.checked
                );

          }}
          className="w-4 h-4"
        />

        <div className="flex flex-col">
          <span className="text-xs font-bold text-slate-700">
            MA Access
          </span>

          <span className="text-[10px] text-slate-400">
            Can view all departments
          </span>
        </div>

      </label>
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
      className={`${
        editingUser
          ? 'bg-emerald-600 hover:bg-emerald-700'
          : 'bg-blue-600 hover:bg-blue-700'
      } text-white font-black px-5 py-2.5 rounded-xl transition-all shadow-lg active:scale-95 text-[10px] uppercase tracking-widest`}
    >
      {editingUser
        ? 'Save Changes'
        : 'Create Account'}
    </button>

  </div>

</form>

)}

</section>

{/* Existing Staff List */}
<section className="flex flex-col max-h-[420px]">
                  <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-4">Current System Users ({users.length})</h3>
                  <div className="space-y-2 overflow-y-auto overscroll-contain pr-2 h-full">
                    {users.map(u => (
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

  {/* Department Badge */}
  <span
    className={`text-[8px] font-black uppercase px-2 py-0.5 rounded ${
      u.department === 'OPD KKL'
        ? 'bg-sky-100 text-sky-700'
        : 'bg-emerald-100 text-emerald-700'
    }`}
  >
    {u.department}
  </span>

  {/* MA Badge */}
  {u.canViewAllDepartments && (
    <span className="text-[8px] font-black uppercase px-2 py-0.5 rounded bg-amber-100 text-amber-700">
      ALL ACCESS
    </span>
  )}

</div>
                            <div className="flex items-center gap-3 mt-1">
                              <span className="text-[10px] text-slate-400 font-medium flex items-center gap-1">
                                <Key size={10} /> ••••••
                              </span>
                              <span className="text-[10px] text-slate-300 font-medium">
                                Created {new Date(u.createdAt).toLocaleDateString()}
                              </span>
                            </div>
                          </div>
                        </div>
                        {u.id !== 'admin' && (
                          <div className="flex flex-wrap items-center gap-2">
                            <button 
                              onClick={() => setEditingUser(u)}
                              className="p-2 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-xl transition-all md:opacity-0 md:group-hover:opacity-100"
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
          <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
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

      {/* Appointment Modal Overlay */}
      <AnimatePresence>
        {isFormOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={closeForm}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden relative z-10"
            >
              <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50">
                <h2 className="text-lg font-bold text-slate-800">
                  {editingAppointment ? 'Edit Appointment' : 'Create Appointment'}
                </h2>
                <button onClick={closeForm} className="text-slate-400 hover:text-slate-600">
                  <XCircle size={24} />
                </button>
              </div>

              <form 
                className="p-6 space-y-4"
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
                      defaultValue={editingAppointment?.patientName || ''}
                      className="w-full px-4 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none uppercase"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">IC Number</label>
                      <input 
                        name="icNumber"
                        required
                        type="text" 
                        value={formIC}
                        onChange={handleICChange}
                        className="w-full px-4 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none uppercase"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Phone Number</label>
                      <input 
                        name="phoneNumber"
                        required
                        type="tel" 
                        value={formPhone}
                        onChange={handlePhoneChange}
                        className="w-full px-4 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none uppercase"
                      />
                      <div className="space-y-1">
  <label className="text-[9px] font-bold text-blue-600 uppercase ml-1">
    Department
  </label>

  <select
    value={formDepartment}
    onChange={(e) =>
      setFormDepartment(
        e.target.value as
          | 'OPD KKL'
          | 'PBOA'
      )
    }
    disabled={
  currentUser?.role !== UserRole.ADMIN &&
  !currentUser?.canViewAllDepartments
}
    className="w-full px-4 py-2.5 rounded-xl border border-blue-200 focus:ring-2 focus:ring-blue-500 outline-none text-sm font-medium bg-white"
  >
    <option value="OPD KKL">
      OPD KKL
    </option>

    <option value="PBOA">
      PBOA
    </option>
  </select>
</div>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Medical History</label>
                    <div className="flex flex-wrap gap-x-4 gap-y-2">
                      {DISEASE_OPTIONS.map(d => (
                        <label key={d} className="flex items-center gap-2 cursor-pointer group">
                          <input 
                            type="checkbox" 
                            name={`disease_${d}`}
                            defaultChecked={editingAppointment ? !!editingAppointment.diseaseTypes?.includes(d) : false}
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
                          defaultChecked={!!editingAppointment?.otherDisease}
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
                        disabled={!editingAppointment?.otherDisease}
                        defaultValue={editingAppointment?.otherDisease}
                        placeholder="Please specify..."
                        className="flex-1 px-3 py-1.5 border border-slate-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500 uppercase disabled:bg-slate-50 disabled:text-slate-400"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-1">
                    <div>
  <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">
    Date
  </label>

 <input
  name="date"
  required
  type="date"
  value={selectedDate}
  onChange={(e) => {
    const value = e.target.value;

    if (formDepartment === 'PBOA') {

      const selectedDateObj = new Date(value);

      if (selectedDateObj.getDay() !== 5) {

        setShowPboaWarning(true);
        return;
      }
    }

    setSelectedDate(value);
  }}
/>

  {formDepartment === 'PBOA' && selectedDate && (() => {

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
                    onClick={closeForm}
                    className="flex-1 px-4 py-2 border border-slate-200 text-slate-600 rounded-lg font-semibold hover:bg-slate-50 transition-colors"
                  >
                    Cancel
                  </button>
                  <button 
                    type="submit"
                    className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 transition-colors shadow-lg"
                  >
                    {editingAppointment ? 'Save Changes' : 'Confirm Appointment'}
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
          <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setDeletingApp(null)}
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
                  onClick={() => setDeletingApp(null)}
                  className="flex-1 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl transition-colors"
                >
                  Cancel
                </button>
                <button 
                  onClick={() => deletingApp && deleteAppointment(deletingApp.id)}
                  className="flex-1 py-2.5 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-xl transition-all shadow-lg shadow-rose-100 active:scale-95"
                >
                  Delete Now
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
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={() => setShowImageNotObtainable(false)}
        className="absolute inset-0 bg-slate-900/80 backdrop-blur-md"
      />

      <motion.div
        initial={{ opacity: 0, scale: 0.9, y: 30 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.9, y: 30 }}
        transition={{ duration: 0.2 }}
        className="relative z-10 w-full max-w-lg overflow-hidden rounded-3xl bg-white shadow-2xl"
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
<div className="p-6">

  {/* Patient */}
  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
      Patient
    </p>

    <p className="mt-1 text-lg font-black text-slate-800">
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
        className={`rounded-2xl border py-3 px-2 transition-all ${
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

    <div className="grid grid-cols-2 gap-3">

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
          className={`rounded-xl border px-3 py-2.5 text-left transition-all ${
            unableReason === reason
              ? "border-amber-500 bg-amber-50 shadow-sm"
              : "border-slate-200 hover:border-amber-300 hover:bg-amber-50/40"
          }`}
        >

          <div className="flex items-center justify-between">

            <span
              className={`text-sm font-bold ${
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
        <div className="flex gap-3 border-t border-slate-100 p-5">

          <button
            onClick={() => setShowImageNotObtainable(false)}
            className="flex-1 rounded-xl border border-slate-200 bg-white py-2.5 font-bold text-slate-600 transition hover:bg-slate-50"
          >
            Cancel
          </button>

          <button
  onClick={saveImageNotObtainable}
  disabled={
    unableReason === "Others" &&
    !unableOtherReason.trim()
  }
  className="flex-1 rounded-xl bg-amber-500 hover:bg-amber-600 py-2.5 font-bold text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed"
>
  Save Status
</button>

        </div>

      </motion.div>

    </div>
  )}
</AnimatePresence>
        {selectedPhotoApp && (
          <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSelectedPhotoApp(null)}
              className="absolute inset-0 bg-slate-900/80 backdrop-blur-md"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 30 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 30 }}
              className="bg-white rounded-3xl shadow-2xl w-full max-w-6xl h-[95vh] lg:max-h-[90vh] overflow-y-auto scroll-smooth lg:overflow-hidden relative z-10 flex flex-col lg:flex-row"
            >
              {/* Photo Area */}
              <div className="flex-1 min-h-[320px] lg:min-h-0 bg-black flex flex-col overflow-hidden relative" onWheel={handleWheel} ref={containerRef}>
                <div className="flex-1 flex items-center justify-center p-2 md:p-4 overflow-y-auto lg:overflow-hidden relative">
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
    className="form-fundus-image max-w-full max-h-full object-contain shadow-2xl rounded-lg select-none"
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
              <div className="w-full md:w-96 flex flex-col p-8 border-l border-slate-100 bg-slate-50" key={selectedPhotoApp?.app?.id}>
                <div className="flex justify-between items-start mb-6">
                  <div>
                    <h2 className="text-2xl font-bold text-slate-800 tracking-tight">{selectedPhotoApp?.app?.patientName}</h2>
                    <p className="text-sm font-mono text-slate-500 uppercase mt-1">IC: {selectedPhotoApp?.app?.icNumber}</p>
                    
                  </div>
                  <button onClick={() => setSelectedPhotoApp(null)} className="text-slate-400 hover:text-slate-600">
                    <XCircle size={28} />
                  </button>
                </div>

                <div className="flex-1 flex flex-col overflow-hidden min-h-0">
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
                  </div>

                  <form 
                    className="flex flex-col flex-1 min-h-0"
                    onSubmit={(e) => {
                      e.preventDefault();
                      // Generate summary text from details
                      const generateSummary = (details: Appointment['rightEyeReviewDetails']) => {
                        if (!details || !details.status) return '';
                        let summary = details.status === 'Normal' ? 'NORMAL' : 'ABNORMAL';
                        
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
                    <div className="space-y-4 flex-1 overflow-y-auto pr-2 pb-6 min-h-0">
                      {/* Eye Selection Tabs */}
                      <div className="flex gap-2 p-1 bg-slate-200 rounded-2xl sticky top-0 z-20">
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
                            
                            <div className="space-y-6 bg-white p-6 rounded-2xl border border-slate-200 shadow-sm min-h-[650px]">
                              
                              {/* Status Selection */}
                              <div className="space-y-3">
                                <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest">Findings Status</label>
                                <div className="flex gap-4 p-1 bg-slate-100 rounded-xl">
                                  {(['Normal', 'Abnormal'] as const).map(status => (
                                    <button
                                      key={status}
                                      type="button"
                                      onClick={() => setDetails(prev => ({ ...(prev || {
                                        status: '',
                                        abnormalTypes: [],
                                        npdrSeverity: '',
                                        othersText: '',
                                        comment: ''
                                      }), status }))}
                                      className={`flex-1 py-2 px-4 rounded-lg text-xs font-bold transition-all ${
                                        details?.status === status 
                                          ? (status === 'Normal' ? 'bg-emerald-600 text-white shadow-md' : 'bg-rose-600 text-white shadow-md')
                                          : 'text-slate-500 hover:bg-slate-200'
                                      }`}
                                    >
                                      {status}
                                    </button>
                                  ))}
                                </div>
                              </div>

                              {/* Abnormal Options */}
                              {details?.status === 'Abnormal' && (
                                <motion.div 
                                  initial={{ opacity: 0 }}
                                  animate={{ opacity: 1 }}
                                  className="space-y-4 pt-2"
                                >
                                  <div className="grid grid-cols-1 gap-3">
                                    {(['NPDR', 'PDR', 'Maculopathy', 'Others'] as const).map(type => (
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
                                          <span className="text-sm font-bold text-slate-700">{type}</span>
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
                                                  className={`py-1.5 px-2 rounded-lg text-[10px] font-bold transition-all ${
                                                    details?.npdrSeverity === sev
                                                      ? 'bg-blue-600 text-white shadow-sm'
                                                      : 'bg-white border border-slate-200 text-slate-400 hover:border-slate-300'
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
                                  className="w-full p-4 text-xs bg-slate-50 border border-slate-200 rounded-2xl outline-none focus:ring-2 focus:ring-blue-500 min-h-[70px] resize-none uppercase shadow-inner"
                                />
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>

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
    setSelectedHistory(history);
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

                    <div className="pt-6 mt-auto shrink-0">
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
            </motion.div>
          </div>
        )}
      </AnimatePresence>
      <AnimatePresence>
  {selectedHistory && (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={() => setSelectedHistory(null)}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
      />

      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.9 }}
        className="relative z-10 bg-white rounded-3xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto p-6"
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
            onClick={() => setSelectedHistory(null)}
            className="px-4 py-2 rounded-xl bg-slate-100 text-xs font-bold"
          >
            Close
          </button>

        </div>
        <div className="bg-slate-50 rounded-2xl p-4 mb-4 text-center">

  <p className="text-[9px] uppercase font-black text-slate-400 tracking-wider">
    Fundus Image Uploaded By
  </p>

  <p className="text-xs font-bold text-slate-700 mt-1">
    {getUserDisplayName(
      selectedHistory.rightEyeUploadedBy ||
      selectedHistory.leftEyeUploadedBy ||
      '-'
    )}
  </p>

</div>

<div className="grid grid-cols-2 gap-4 mb-4">

  {selectedHistory.rightEyePhoto && (
    <img
      src={selectedHistory.rightEyePhoto}
      className="rounded-2xl border border-slate-200"
    />
  )}

  {selectedHistory.leftEyePhoto && (
    <img
      src={selectedHistory.leftEyePhoto}
      className="rounded-2xl border border-slate-200"
    />
  )}

</div>

<div className="mt-2 mb-6 text-center border-b border-slate-200 pb-4">

  <p className="text-[9px] uppercase font-black text-slate-400 tracking-wider">
    Reviewed By
  </p>

  <p className="text-xs font-bold text-slate-700 mt-1">
    {getUserDisplayName(selectedHistory.updatedBy || '-')}
  </p>

</div>

        <div className="grid grid-cols-2 gap-4">

          <div className="bg-slate-50 rounded-2xl p-4">
            <h3 className="text-xs font-black uppercase text-slate-400 mb-2">
              Right Eye Review
            </h3>

            <p className="text-sm font-bold text-slate-700">
              {selectedHistory.rightEyeReviewDetails?.status || 'No Review'}
              {selectedHistory.rightEyeReviewDetails?.abnormalTypes?.length > 0 && (
  <p className="text-[10px] text-slate-500 font-bold mt-1 uppercase">

    {selectedHistory.rightEyeReviewDetails.abnormalTypes.join(', ')}

    {selectedHistory.rightEyeReviewDetails.npdrSeverity
      ? ` - ${selectedHistory.rightEyeReviewDetails.npdrSeverity}`
      : ''
    }

    {selectedHistory.rightEyeReviewDetails.othersText
      ? ` - ${selectedHistory.rightEyeReviewDetails.othersText}`
      : ''
    }

  </p>
)}
            </p>

            <p className="text-xs text-slate-500 mt-2 whitespace-pre-wrap uppercase">
              {selectedHistory.rightEyeReviewDetails?.comment || '-'}
            </p>
          </div>

          <div className="bg-slate-50 rounded-2xl p-4">
            <h3 className="text-xs font-black uppercase text-slate-400 mb-2">
              Left Eye Review
            </h3>

            <p className="text-sm font-bold text-slate-700">
              {selectedHistory.leftEyeReviewDetails?.status || 'No Review'}
            </p>

            <p className="text-xs text-slate-500 mt-2 whitespace-pre-wrap uppercase">
              {selectedHistory.leftEyeReviewDetails?.comment || '-'}
            </p>
          </div>

        </div>

      </motion.div>

    </div>
  )}
  <AnimatePresence>

  {selectedReviewSummary && (

    <div className="fixed inset-0 z-[130] flex items-start lg:items-center justify-center p-2 md:p-4 overflow-y-auto">

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={() => {

  document.body.style.overflow = 'auto';

  setSelectedReviewSummary(null);

}}
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
      />

      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="relative z-10 bg-white rounded-3xl shadow-2xl w-full max-w-6xl max-h-[95vh] lg:max-h-[90vh] overflow-y-auto flex flex-col lg:flex-row"
      >

        <div className="flex flex-col lg:flex-row w-full">

  {/* Summary LEFT IMAGE SECTION */}
<div
  className="w-full min-h-[320px] lg:min-h-0 bg-black flex flex-col overflow-hidden relative"
  onWheel={handleWheel}
  ref={containerRef}
>

  <div className="flex-1 flex items-center justify-center p-4 overflow-hidden relative">

    <motion.img
      key={summaryEye}
      drag={zoomScale > 1}
      dragMomentum={false}
      animate={{
        scale: zoomScale,
        cursor: zoomScale > 1 ? 'grab' : 'zoom-in'
      }}
      transition={{ type: 'spring', stiffness: 400, damping: 40 }}
      src={
        summaryEye === 'right'
          ? selectedReviewSummary.rightEyePhoto
          : selectedReviewSummary.leftEyePhoto
      }
      className="summary-fundus-image max-w-full max-h-full object-contain shadow-2xl rounded-lg select-none"
      alt="Fundus View"
    />

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
    Fundus Image Uploaded By:
  </p>

  <p className="text-[11px] font-bold text-white uppercase">
    {
      getUserDisplayName(
        summaryEye === 'right'
          ? selectedReviewSummary.rightEyeUploadedBy
          : selectedReviewSummary.leftEyeUploadedBy
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
  <div className="w-full lg:w-[380px] bg-slate-50 border-l border-slate-200 p-4 md:p-6 flex flex-col h-full overflow-hidden">

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

  document.body.style.overflow = 'auto';

  setSelectedReviewSummary(null);

}}
        className="absolute top-3 right-3 z-20 w-8 h-8 rounded-full bg-slate-200 hover:bg-slate-300 transition-all font-black"
      >
        x
      </button>

    </div>
<div className="flex flex-col flex-1 min-h-0 gap-6">

  {/* REVIEWED BY */}
<div className="bg-white rounded-2xl border border-slate-200 p-4">

  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
  {
    selectedReviewSummary.isEdited
  ? 'Review Edited By'
  : 'Reviewed By'
  }
</p>

  <p className="text-sm font-bold text-slate-700 uppercase mt-2">
    {getUserDisplayName(
  selectedReviewSummary.updatedBy ||
  selectedReviewSummary.reviewedBy ||
  '-'
)}
  </p>

</div>

{/* FINDINGS */}
<div className="bg-white rounded-2xl border border-slate-200 p-5 flex flex-col flex-1 min-h-0 overflow-hidden">
  <p className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-4">
    Findings
  </p>

  <div className="flex-1 overflow-y-auto space-y-4 pr-2 min-h-0">

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

        <span className={`inline-flex px-4 py-2 rounded-xl text-sm font-black uppercase ${
          selectedReviewSummary.rightEyeReviewDetails?.status === 'Abnormal'
            ? 'bg-rose-100 text-rose-600'
            : 'bg-emerald-100 text-emerald-600'
        }`}>

          {selectedReviewSummary.rightEyeReviewDetails?.status || '-'}

        </span>

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

        <span className={`inline-flex px-4 py-2 rounded-xl text-sm font-black uppercase ${
          selectedReviewSummary.leftEyeReviewDetails?.status === 'Abnormal'
            ? 'bg-rose-100 text-rose-600'
            : 'bg-emerald-100 text-emerald-600'
        }`}>

          {selectedReviewSummary.leftEyeReviewDetails?.status || '-'}

        </span>

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
<button
  onClick={() => {

    setSelectedReviewSummary(null);

    setSelectedPhotoApp({
      app: selectedReviewSummary,
      eye: 'right'
    });

  }}
  className="mt-auto shrink-0 w-full py-4 bg-slate-900 hover:bg-black text-white font-black rounded-2xl transition-all text-[11px] uppercase tracking-[0.2em]"
>
  Edit Review
</button>

  </div>

</div>
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

    <div className="fixed inset-0 z-[300] flex items-center justify-center p-4">

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={() => {

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
        className="relative z-10 w-full max-w-md bg-white rounded-3xl shadow-2xl overflow-hidden"
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

  setShowAccountSettings(false);

  setCurrentPasswordInput('');
  setNewPasswordInput('');
  setConfirmPasswordInput('');

  setNewDisplayName(currentUser?.displayName || '');

}}
            className="p-2 rounded-xl hover:bg-slate-200 text-slate-400 transition-all"
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
            className="w-full py-4 bg-gradient-to-r from-slate-900 to-blue-900 hover:bg-gradient-to-r hover:from-slate-800 hover:to-blue-800 text-white font-black rounded-2xl transition-all uppercase tracking-widest text-xs"
          >

            Save Changes

          </button>

        </div>

      </motion.div>

    </div>

  )}

</AnimatePresence>
{/* ACTIVITY LOG MODAL */}
<AnimatePresence>

  {showActivityLogs && (

    <div className="fixed inset-0 z-[140] flex items-center justify-center p-4">

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
        className="relative z-10 bg-white rounded-3xl shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col"
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

          {activityLogs.length === 0 ? (

            <div className="text-center text-slate-400 text-sm py-10 font-bold">
              No activity logs available.
            </div>

          ) : (

            activityLogs.map((log, index) => (

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
      </>
  );
}

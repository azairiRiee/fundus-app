import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyAK7Ed-x-Vj9rqFRedTZ0kVeWgulknnRa0",
  authDomain: "fundus-kklintang.firebaseapp.com",
  projectId: "fundus-kklintang",
  storageBucket: "fundus-kklintang.firebasestorage.app",
  messagingSenderId: "584370973966",
  appId: "1:584370973966:web:fe5fc076713b5c14ddfb5f"
};

const app = initializeApp(firebaseConfig);

export const db = getFirestore(app);
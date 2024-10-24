// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
    apiKey: "AIzaSyCUN0qlShI4KsDUgU-heyAPtFbb_SzndMk",
    authDomain: "soundboard-84dec.firebaseapp.com",
    projectId: "soundboard-84dec",
    storageBucket: "soundboard-84dec.appspot.com",
    messagingSenderId: "396082901651",
    appId: "1:396082901651:web:fd9bf28fe1c2ee9f7c5366",
    measurementId: "G-FCDBQRLZM4"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
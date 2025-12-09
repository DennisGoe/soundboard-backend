# 🎧 Soundboard Backend

The **Soundboard Backend** is a lightweight Node.js and Express server powering the Soundboard application.  
It provides secure authentication, media upload handling, and real-time communication for the frontend client.

---

## 🚀 Tech Stack

- **Node.js** — Runtime environment  
- **Express** — Fast and minimalist web framework  
- **MongoDB + Mongoose** — Database and object modeling  
- **Socket.io** — Real-time event communication  
- **Firebase Admin SDK** — Cloud storage integration  
- **JWT** — Secure authentication  
- **TypeScript** *(if applicable)* — Static typing and cleaner code  

---

## ⚙️ Setup

### 1. Clone the repository
```bash
git clone https://github.com/yourusername/soundboard-backend.git
cd soundboard-backend
```

### 2. Install dependencies
```bash
npm install
```

### 3. Configure environment variables
Create a `.env` file in the project root:
```bash
MONGO_URI=your-mongodb-uri
JWT_SECRET=your-jwt-secret
FIREBASE_STORAGE_BUCKET=your-bucket-id
PRIVATE_KEY_ID=your-private-key-id
PRIVATE_KEY="your-private-key"
```

> ⚠️ **Do not commit** the `.env` file — it contains sensitive information.

---

## 🧩 Scripts

| Command | Description |
|----------|-------------|
| `npm run dev` | Start the development server with hot reload |
| `npm run build` | Compile the project for production |
| `npm start` | Run the production build |

---

## 🗂️ Basic Project Structure

```
src/
 ├── models/        # Mongoose models
 ├── routes/        # Express route handlers
 ├── middleware/    # Authentication & validation logic
 ├── services/      # Firebase, Socket, etc.
 └── index.js       # App entry point
```

---

## 🧠 Overview

- Handles **user authentication** via JWT  
- Supports **audio uploads** to Firebase Storage  
- Enables **real-time updates** with Socket.io  
- Connects to **MongoDB** for data persistence  

---

## 🪪 License

This project is licensed under the **ISC License**.


